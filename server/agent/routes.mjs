import { generatedFiles, generatedId } from "../../shared/workspace-files.mjs";
import { complete } from "../models/client.mjs";
import { completionMessages } from "../models/completion.mjs";
import { modelConfig } from "../models/providers.mjs";
import { fault } from "../storage.mjs";
import { recordWorkspaceFiles } from "../workspace/generation-log.mjs";
import { agentHistory, chatStorageId, transcriptPath } from "./history.mjs";
import { messageQueue } from "./queue.mjs";
import { pauseAgent, recoverableRequest, runAgent } from "./run.mjs";
import { agentStream } from "./stream.mjs";

function resolveChatFile(files, id, version) {
  const file = files.find(f => f.id === id);
  if (!file) fault("文档不存在", 404);
  if (version === undefined || version === 0) return file;

  // Old clients address a PRD by its parent ID and delivery version.
  const child = files.find(f => f.id === generatedId(id, version, "prd"));
  if (child) return child;
  const output = file.outputs?.find(o => o.version === version);
  if (!output?.prd) fault("未找到指定版本的图文 PRD", 404);
  const children = generatedFiles(file, output);
  files.push(...children.filter(f => !files.some(existing => existing.id === f.id)));
  return children.find(f => f.origin.file === "prd");
}

function queueCommand(path, input) {
  const { action, requestId, question, refs = [], modelId } = input;
  if (!["list", "add", "prioritize"].includes(action)) fault("未知的队列操作");
  if (action !== "list" && !/^[0-9a-f-]{36}$/i.test(requestId || "")) fault("消息编号无效");
  if (action !== "add") return messageQueue(path, action, { requestId });
  if (typeof question !== "string" || !question.trim() || !Array.isArray(refs)) fault("消息内容无效");
  return messageQueue(path, action, { requestId, question, refs, ...(modelId && { modelId }), createdAt: Date.now() });
}

function archiveResponse(file, out, input) {
  if (!out.workspaceFiles) return out;
  const { workspaceFiles, workspaceChanges, ...chat } = out;
  const delivery = recordWorkspaceFiles(file.id, workspaceFiles, workspaceChanges, input.question,
    input.chatId, out.conversationId, out.answerEntry ?? input.requestId);
  // An acknowledged delivery is already present in the saved workspace.
  if (!delivery) return chat;
  const summary = [];
  if (delivery.files.length) summary.push("已创建 " + delivery.files.map(f => f.title).join("、"));
  if (delivery.changes.length) summary.push("已处理 " + delivery.changes.length + " 个文件的修改，正文和画布修改可在对应文件中预览");
  return { ...chat, answer: summary.join("。") + "。", delivery };
}

export async function agentRoute(url, req, res, files, input) {
  const path = url.pathname;
  if (path === "/api/agent/history" && req.method === "GET") {
    const version = url.searchParams.get("prdVersion");
    const file = resolveChatFile(files, url.searchParams.get("doc"), version === null ? undefined : Number(version));
    const chatId = url.searchParams.get("chatId");
    if (!(file.chatSessions || [{ id: "legacy" }]).some(s => s.id === chatId))
      fault("会话不存在", 404);
    const storeId = chatStorageId(file), tool = url.searchParams.get("tool");
    const work = tool === null && await recoverableRequest(transcriptPath(storeId, chatId));
    const history = agentHistory(storeId, chatId, tool);
    if (tool === null) {
      const turn = work && history.turns.findLast(t => t.requestId === work.requestId);
      const session = file.chatSessions?.find(s => s.id === chatId);
      if (turn && !session?.messages.some(m => m.requestId === turn.requestId)) {
        turn.control = work.status === "completed" ? "ready" : "paused";
        turn.editIndex = work.editIndex;
        turn.refsUsed = work.refs;
      }
    }
    return history;
  }
  if (req.method !== "POST" || !["/api/agent", "/api/agent/pause", "/api/agent/queue"].includes(path))
    fault("无此接口", 404);
  // Old bookmarks may still carry task-scoped API credentials. New callers use their message.
  delete input.externalApi;
  const file = resolveChatFile(files, input.doc, input.prdVersion);
  if (path === "/api/agent" && input.mode === "complete") {
    const controller = new AbortController();
    res.once("close", () => controller.abort());
    const text = await complete(modelConfig("completion", input.modelId), completionMessages(file.title, input), 1024, controller.signal);
    return { text };
  }
  if (path === "/api/agent" && input.mode !== "chat") fault("请通过 Agent 对话创建文件");
  const session = file.chatSessions?.find(s => s.id === input.chatId);
  if (!session && input.chatId === "legacy" && !file.chatSessions && path === "/api/agent/queue" && input.action === "list")
    return { items: [] };
  if (input.chatId !== undefined && !session) fault("会话不存在，请刷新工作区", 409);

  const storeId = chatStorageId(file);
  if (path === "/api/agent/pause") return pauseAgent(storeId, input.chatId, input.attemptId);
  if (path === "/api/agent/queue" || input.queued) {
    if (!session) fault("会话不存在", 404);
    const store = transcriptPath(storeId, session.id);
    if (path === "/api/agent/queue") return { items: await queueCommand(store, input) };
    const [head] = await messageQueue(store);
    if (head?.requestId === input.requestId)
      Object.assign(input, { question: head.question, refs: head.refs, modelId: head.modelId });
    else if ((await recoverableRequest(store))?.requestId !== input.requestId)
      fault("消息队列已更新", 409);
  }
  if (input.editIndex !== undefined && (!session || !Number.isSafeInteger(input.editIndex) ||
      input.editIndex < 0 || input.editIndex >= session.messages.length))
    fault("要编辑的消息不存在", 409);

  const live = req.headers.accept === "application/x-ndjson" ? agentStream(res) : null;
  try {
    const out = await runAgent({ doc: file, docs: files, session }, input, id => modelConfig("agent", id), live || undefined);
    const result = archiveResponse(file, out, input);
    if (live) live.end("result", result);
    return result;
  } catch (error) {
    if (!live) throw error;
    live.end("error", {
      error: error.status ? error.message : "服务执行失败，请检查服务状态后重试",
      ...(error.selectionExpired && { selectionExpired: true }),
    });
  }
}
