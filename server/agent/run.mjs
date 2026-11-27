import { toolDescriptions } from "../../shared/agent-catalog.mjs";
import { selectionScope } from "./selection.mjs";
import { maskImages, prepareReferences } from "./context.mjs";
import { conversationFor } from "./conversation.mjs";
import { createAgentTools, toolReply } from "./tools.mjs";
import { runtimeModels } from "./model.mjs";
import { loopPolicy, CompactionBoundary } from "./policy.mjs";
import {
  agentInstructions,
  agentInput,
  continuationInput,
  continueProse,
  correctToolResult,
} from "./prompts.mjs";
import { agentHistory, chatStorageId, pausedRequest, pauseKind, transcriptPath } from "./history.mjs";
import { diagnostic, toolProgress } from "./stream.mjs";
import { workspaceCreation } from "../workspace/create-file.mjs";
import { discoverSkills, skillRuntime } from "../skills.mjs";
import { boardType } from "../../shared/workspace-files.mjs";
import { sceneVersion } from "../../shared/canvas-model.mjs";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  createStage,
  taskEnvironment,
} from "../runtime/task-environment.mjs";
import { openTaskNetwork } from "../runtime/task-network.mjs";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { obj, str, opt } from "@earendil-works/pi-schema";
import {
  AssistantEntry,
  createRegistry,
  defineExtension,
  defineTool,
  GenerationTask,
  CompactionTask,
  hook,
  hookTask,
} from "@earendil-works/pi-durable";
import { openChatHarness, closeChatHarness, consumeQueued, messageQueue, WorkspaceRun, WorkspaceAnswer, workspaceSnapshot } from "./queue.mjs";
import { readWorkspaceCheckpoint, workspaceCheckpoints } from "./workspace-checkpoint.mjs";
import { directory, fault, seal, unseal } from "../storage.mjs";
const active = new Map();
const validId = (id) => typeof id === "string" && /^[a-f0-9-]{36}$/i.test(id);
const paused = Symbol("paused");
export async function pauseAgent(docId, sessionId, attemptId) {
  const identity = transcriptPath(docId, sessionId);
  const run = active.get(identity);
  if (!run && validId(attemptId) && pausedRequest(identity)?.attemptId === attemptId)
    return { status: "paused" };
  if (!validId(attemptId) || !run || run.attemptId !== attemptId)
    fault("这次请求已结束或已切换，请查看会话记录", 409);
  run.pause.abort();
  return run.finished;
}
export async function recoverableRequest(identity) {
  const run = active.get(identity);
  if (run?.disconnected()) await run.finished;
  else if (run) return;
  return (await workspaceSnapshot(identity))?.current;
}
export async function runAgent(
  { doc, docs, session },
  req,
  p,
  { progress, signal } = {},
) {
  const ownerId = doc.id;
  const identity = transcriptPath(chatStorageId(doc), session?.id);
  if (active.has(identity)) fault("这篇文档的助手正在运行", 409);
  const requestId = validId(req.requestId) ? req.requestId : randomUUID();
  const attemptId = validId(req.attemptId) ? req.attemptId : requestId;
  const pause = new AbortController();
  let finish;
  active.set(identity, {
    attemptId,
    pause,
    disconnected: () => signal?.aborted,
    finished: new Promise((resolve) => {
      finish = resolve;
    }),
  });
  let h,
    stage,
    network,
    savePause,
    admitted = false,
    keepStage = false,
    didPause = false;
  try {
    const folder = path.join(directory, "agent");
    await fs.mkdir(folder, { recursive: true });
    const record = (await workspaceSnapshot(identity))?.current;
    if (record?.status === "completed" && record.requestId === requestId)
      return (await workspaceSnapshot(identity, WorkspaceAnswer)).result;
    const bookmark = record?.status === "submitted" ? record : pausedRequest(identity);
    const recovering = bookmark?.status === "submitted" && requestId === bookmark.requestId;
    if (typeof p === "function") p = p(recovering ? bookmark.modelId : req.modelId);
    if (!recovering && req.resumeFrom !== bookmark?.requestId &&
        !(record?.status === "completed" && req.resumeFrom === record.requestId))
      fault("暂停状态已变化，请刷新会话后继续", 409);
    const continuing = !!bookmark && req.requestId === bookmark.requestId;
    let saved;
    if (bookmark) {
      keepStage = true;
      stage = path.join(directory, "agent-work", bookmark.stage);
      saved = await readWorkspaceCheckpoint(stage, identity, bookmark);
      doc = {
        ...doc,
        html: saved.baseHtml,
        ...(saved.baseScene && { scene: saved.baseScene }),
      };
      req = {
        ...req,
        editIndex: saved.editIndex,
        ...(continuing && { question: saved.question, refs: saved.refs }),
      };
      if (continuing && saved.externalApi && !req.externalApi)
        req.externalApi = JSON.parse(unseal(saved.externalApi));
    } else stage = await createStage();
    const { html, images } = maskImages(doc.html || ""),
      files = Object.create(null);
    let scope;
    try {
      scope = selectionScope(req.refs, ownerId, doc);
    } catch (error) {
      if (req.queued && error.status) {
        await messageQueue(identity, "rejectSelection", { requestId });
        error.selectionExpired = true;
      }
      throw error;
    }
    const baseImageCount = images.length;
    images.push(...(saved?.extraImages || []));
    files["current.html"] = saved?.current ?? html;
    images.forEach((data, index) => {
      files["xuye-asset-" + (index + 1)] = Buffer.from(
        data.slice(data.indexOf(",") + 1),
        "base64",
      );
    });
    const catalog = discoverSkills();
    const priorSkills = (session?.messages || [])
      .slice(0, req.editIndex ?? session?.messages?.length)
      .flatMap((m) => m.skillsUsed || []);
    const skillSet = skillRuntime(catalog, priorSkills);
    for (const name of saved?.skills || [])
      if (catalog.skills.has(name)) skillSet.active.add(name);
    const earlierRefs = saved?.earlierRefs || [];
    if (saved && !continuing) earlierRefs.push(...saved.refs);
    const references = prepareReferences(
      docs,
      [
        ...earlierRefs.map((ref) => {
          const selectedAgain =
            ref.kind === "image" &&
            (req.refs || []).some((r) => r.kind === "image" && r.id === ref.id);
          return { ...ref, historyOnly: !selectedAgain };
        }),
        ...(req.refs || []),
        ...(session?.messages || [])
          .slice(0, req.editIndex ?? session?.messages?.length)
          .flatMap((m) =>
            (m.refsUsed || [])
              .filter((r) => r.kind === "upload" || r.kind === "image")
              .map((r) => ({ ...r, historyOnly: true })),
          ),
      ],
      files, scope,
    );
    function restoreImages(s) {
      return s
        .replace(/xuye-asset-(\d+)/g, (m, i) => images[i - 1] || m)
        .replace(
          /xuye-ref-[a-f0-9]{20}-\d+\.[a-z0-9.+-]+/gi,
          (name) => references.assets.get(name) || name,
        );
    }
    const { env, inputs, mountSkills, writeSnapshot } = await taskEnvironment(
      stage,
      files,
      skillSet,
      !!saved,
    );
    if (saved) await writeSnapshot("current.html", files["current.html"]);
    network = await openTaskNetwork(stage, req.externalApi);
    const { models, deepseek } = runtimeModels(p);
    const toolCalls = continuing
      ? agentHistory(chatStorageId(doc), session?.id).turns.findLast(t => t.requestId === requestId)?.toolCalls.filter(c => c.status !== "running") || saved.toolCalls || []
      : [];
    const canvas = boardType(doc.type),
      drawing = { patch: saved?.drawing };
    async function writeCurrent(value) {
      const count = images.length;
      if (scope) scope.read(value);
      const masked = maskImages(value, images).html;
      for (let i = count; i < images.length; i++)
        await writeSnapshot(
          "xuye-asset-" + (i + 1),
          Buffer.from(images[i].split(",")[1], "base64"),
        );
      await writeSnapshot("current.html", masked);
      files["current.html"] = masked;
    }
    const creation = workspaceCreation(
      docs,
      ownerId,
      {
        read: () => ({
          html: files["current.html"],
          ...(canvas && { scene: doc.scene, drawing: drawing.patch }),
        }),
        writeDrawing: (patch) => {
          drawing.patch = patch;
        },
        write: writeCurrent,
      },
    );
    const hasFiles = () =>
      creation.entries.length > 0 || creation.changes.length > 0;
    if (saved) {
      creation.entries.push(...saved.entries);
      creation.changes.push(...saved.changes);
    }
    const answerFragments = continuing ? saved.fragments : [];
    const work = workspaceCheckpoints(stage, {
      question: req.question, refs: req.refs || [], earlierRefs, editIndex: req.editIndex,
      externalApi: req.externalApi ? seal(JSON.stringify(req.externalApi)) : undefined,
      baseHtml: doc.html || "", baseScene: canvas ? doc.scene : undefined,
    }, () => ({
      current: files["current.html"], extraImages: images.slice(baseImageCount),
      entries: creation.entries, changes: creation.changes, drawing: drawing.patch,
      skills: [...skillSet.active], fragments: answerFragments,
    }));
    let compactRequest;
    let lastCompactRound = -3;
    const compactTool = defineTool({
      name: "compact_context",
      description: toolDescriptions.compact_context,
      parameters: obj({ focus: opt(str()) }),
      async execute({ focus }) {
        if (rounds.size - lastCompactRound < 2)
          return toolReply("刚检查过压缩，请先继续当前任务。", true);
        lastCompactRound = rounds.size;
        compactRequest =
          focus || "保留用户要求、已完成操作、目标文件和剩余工作";
        return toolReply("已请求检查可压缩历史，将在下一次推理前处理。");
      },
    });
    const taskTools = createAgentTools({
      creation,
      restoreImages,
      scope,
      skillSet,
      mountSkills,
      files,
      inputs,
      network,
      compactTool,
      env,
      writeCurrent,
    });
    const registry = createRegistry();
    const rounds = new Set();
    let compactions = 0,
      correctionCount = 0;
    const explicitCreation =
      /(?:新建|创建|生成|做一?个|写一?份).{0,35}(?:html|prd|文档|交互原型|画布|文件夹)/i.test(
        req.question || "",
      ) &&
      !/(?:如何|怎么|能否|是否|不要|不用|不需要).{0,18}(?:新建|创建|生成|写|做)/.test(
        req.question || "",
      );
    const requestedDocumentUpdate =
      /(?:写(?:入|回|进)|追加|更新|插入|汇总|记录|添加|放)(?:.{0,16})(?:当前|这篇|这份|在线)?文档|文档(?:中|里|末尾).{0,8}(?:追加|添加|插入|更新)/.test(
        req.question || "",
      );
    function missingWrite(message) {
      return (
        (explicitCreation ||
          (requestedDocumentUpdate &&
            message?.content?.some(
              (v) =>
                v.type === "text" &&
                /已(?:经)?(?:完成|处理|更新|添加|写入|插入|追加)|已提交/.test(
                  v.text,
                ),
            ))) &&
        !hasFiles() &&
        !drawing.patch &&
        files["current.html"] === html &&
        !message?.content?.some(
          (v) =>
            v.type === "text" &&
            /[？?]|请(?:先)?(?:确认|提供|补充)/.test(v.text),
        )
      );
    }

    const ext = defineExtension({
      name: "documents",
      tools: taskTools,
      tasks: [CompactionBoundary],
      hooks: [
        toolProgress(toolCalls, progress),
        work.resultHook,
        hook(CompactionTask, {
          beforeCompact() {
            compactions++;
            progress?.({ label: "正在压缩较早的会话上下文" });
          },
        }),
        hook(GenerationTask, {
          afterTools(assistant) {
            rounds.add(assistant);
            if (compactRequest !== undefined)
              return { tasks: [hookTask(CompactionBoundary, null)] };
          },
          onYield(message) {
            if (message.stopReason !== "stop") return;
            if (
              correctionCount < loopPolicy.maxCorrections &&
              (missingWrite(message) || toolCalls.at(-1)?.status === "failed")
            ) {
              correctionCount++;
              progress?.({ label: "正在核对工具结果并修正" });
              return {
                continue: scope ? "查看工具结果。答疑直接回答，修改使用 edit_online_file 的 content 替换指定选区；请保留选区内标签。" : correctToolResult,
              };
            }
          },
        }),
      ],
    });
    registry.install(ext);
    h = await openChatHarness(
      identity,
      {
        models,
        registry,
        env: () => env,
        settings: loopPolicy.settings,
      },
    );
    const ownership = { ownership: { kind: "ownerless" } };
    let root = bookmark
      ? await h.conversation(bookmark.conversationId, ctx)
      : await conversationFor(h, session, req.editIndex);
    if (bookmark?.status === "submitted" && !recovering) {
      await root.abort(ctx);
      await root.waitForIdle(ctx);
    }
    const config = {
      model: { provider: "workspace", modelId: p.model },
      ...(deepseek && { thinkingLevel: "off" }),
      extensions: [ext],
      tools: taskTools,
      maxTurns: loopPolicy.maxTurns,
      instructions: agentInstructions({
        canvas,
        skills: skillSet.instructions,
        doc,
        scoped: !!scope,
        hasPictures: !!references.pictures.length,
        externalApi: req.externalApi,
      }),
    };
    const named = /^\s*\/skill:([a-z0-9-]+)(?=\s|$)/.exec(
      req.question || "",
    )?.[1];
    if (named && !catalog.skills.has(named)) fault("未安装技能：" + named);
    let skillContext = "";
    if (named) {
      skillContext = skillSet.load(named, { explicit: true }) + "\n";
      await mountSkills();
    }
    await root.configure(config, ctx);
    const { prompt, content } = agentInput({
      canvas,
      doc,
      docs,
      ownerId,
      html: files["current.html"],
      req,
      references,
      skillContext,
      images,
    });
    const checkpoint = recovering ? bookmark.checkpoint :
      (await root.entries({}, 1, undefined, ctx)).items[0]?.id;
    async function observeSubmission(submission) {
      const conversation = root;
      const abort = () => {
        void conversation.abort(ctx).catch(() => {});
      };
      signal?.addEventListener("abort", abort, { once: true });
      pause.signal.addEventListener("abort", abort, { once: true });
      if (signal?.aborted || pause.signal.aborted) abort();
      let watch;
      try {
        progress?.({ label: "正在等待模型响应" });
        if (progress) {
          let previous = "",
            lastPartial = 0;
          const update = (view) => {
            const state = view.docs["pi.live"]?.generation;
            if (!state) {
              previous = "";
              return;
            }
            const text =
              state.message?.content
                ?.filter((c) => c.type === "text")
                .map((c) => c.text)
                .join("") || "";
            const label = state.retry
              ? "模型请求失败，正在重试：" + diagnostic(state.retry.error)
              : text
                ? "正在生成回复"
                : state.message?.content?.length
                  ? "模型正在生成"
                  : "正在等待模型响应";
            const partial = text.slice(-480);
            if (
              previous === label + partial ||
              (partial && Date.now() - lastPartial < 500)
            )
              return;
            previous = label + partial;
            if (partial) lastPartial = Date.now();
            progress({ label, partial });
          };
          watch = await conversation.watch(ctx, { min: 1, max: 1 });
          update(watch.value);
          watch.start(async (call) => {
            if (call.kind === "value") update(call.value);
          });
        }
        const result = await submission.wait(ctx);
        if ((pause.signal.aborted || signal?.aborted) && result.reason === "aborted") {
          await conversation.waitForIdle(ctx);
          throw paused;
        }
        return result;
      } finally {
        signal?.removeEventListener("abort", abort);
        pause.signal.removeEventListener("abort", abort);
        await watch?.stop();
      }
    }
    async function waitSubmission(submission) {
      let result = await observeSubmission(submission);
      while (compactRequest !== undefined && result.status === "done") {
        const focus = compactRequest;
        compactRequest = undefined;
        progress?.({ label: "正在压缩较早的对话" });
        const taskId = await root.compact(focus, ctx);
        const abort = () => {
          void root.abort(ctx).catch(() => {});
        };
        pause.signal.addEventListener("abort", abort, { once: true });
        signal?.addEventListener("abort", abort, { once: true });
        if (pause.signal.aborted || signal?.aborted) abort();
        let task;
        try {
          task = await h.waitForTask(taskId, ctx);
          if (pause.signal.aborted || signal?.aborted) {
            await root.waitForIdle(ctx);
            throw paused;
          }
        } finally {
          pause.signal.removeEventListener("abort", abort);
          signal?.removeEventListener("abort", abort);
        }
        const outcome = task.state.outcome;
        let note = "当前历史较短，没有可压缩的旧消息。";
        if (outcome.status !== "completed") note = "压缩未完成，已有工作保留。";
        else if (outcome.result?.submissionId !== undefined) {
          const placed = await h.submission(outcome.result.submissionId, ctx);
          const receipt = await placed?.wait(ctx);
          note =
            receipt?.status === "done" || receipt?.status === "placed"
              ? "较早对话已压缩。"
              : "压缩摘要未采用。";
        }
        const next = await admit(
          {
            type: "input",
            requestId: randomUUID(),
            content: [{ type: "text", text: note + "继续完成用户原任务。" }],
          },
        );
        result = await observeSubmission(next);
      }
      return result;
    }
    let associated = recovering ? bookmark : undefined;
    async function admit(draft, initial = false) {
      const admission = randomUUID();
      const snapshot = await work.snapshot();
      work.bind(admission);
      const next = {
        status: "submitted", admission, snapshot, requestId,
        stage: path.basename(stage), conversationId: root.id,
        ...(p.modelId && { modelId: p.modelId }),
        refs: req.refs || [],
        ...(req.editIndex !== undefined && { editIndex: req.editIndex }),
        ...(checkpoint !== undefined && { checkpoint }),
      };
      const id = await root.commit(async (tx) => {
        if (initial && req.queued) await consumeQueued(tx, requestId);
        const id = await root.submit(tx, draft);
        (await tx.doc(WorkspaceRun)).current = { ...next, submissionId: id };
        if (initial && bookmark) await tx.appendEntry(root.id, {
          kind: pauseKind, data: {
            requestId: bookmark.requestId, status: continuing ? "resumed" : "followed",
          },
        });
        return id;
      }, ctx);
      associated = { ...next, submissionId: id };
      keepStage = admitted = true;
      return h.submission(id, ctx);
    }
    savePause = async () => {
      await root.commit(async tx => {
        (await tx.doc(WorkspaceRun)).current = null;
        await tx.appendEntry(root.id, {
          kind: pauseKind, data: {
            status: "paused", requestId, attemptId, stage: associated.stage,
            snapshot: associated.snapshot, admission: associated.admission,
            ...(req.editIndex !== undefined && { editIndex: req.editIndex }), refs: req.refs || [],
          },
        });
      }, ctx);
    };
    let sub;
    if (recovering) {
      work.bind(bookmark.admission);
      keepStage = admitted = true;
      sub = await h.submission(bookmark.submissionId, ctx);
      const receipt = await sub.status(ctx);
      if (receipt.status === "unanswered" && receipt.reason === "aborted")
        sub = await admit({ type: "continue", requestId: attemptId });
      else h.resume();
    } else {
      sub = await admit(continuing
        ? { type: "continue", requestId: attemptId === requestId ? randomUUID() : attemptId }
        : { type: "input", content, requestId }, true);
    }
    progress?.({ label: "请求已提交", canPause: true });
    let settled = await waitSubmission(sub);
    const answerModel = async () =>
      settled.answer
        ? (
            await root.commit(
              (tx) => tx.entry(AssistantEntry, settled.answer),
              ctx,
            )
          )?.model?.[0]
        : undefined;
    const answerText = (model) =>
      model?.content
        ?.filter((v) => v.type === "text")
        .map((v) => v.text)
        .join("")
        .trim() || "";
    let modelReply = await answerModel();
    const attemptedDrawing = () =>
      toolCalls.some((t) => t.name === "draw_online_canvas" || t.name === "draw_canvas") ||
      modelReply?.content?.some(
        (v) => v.type === "toolCall" && v.name === "draw_online_canvas",
      );
    // A length-stopped tool batch was never executed by Pi. Retry from a clean
    // transcript and the accepted workspace drafts, not the incomplete arguments.
    let lastState,
      stalls = 0;
    for (let attempt = 1; ; attempt++) {
      const cut = modelReply?.stopReason === "length";
      if (settled.status !== "done") break;
      const emptyResult =
        !hasFiles() &&
        !drawing.patch &&
        files["current.html"] === html &&
        (!answerText(modelReply) || (canvas && attemptedDrawing()));
      if (!cut && !emptyResult) break;
      const prose =
        !canvas &&
        !hasFiles() &&
        files["current.html"] === html &&
        cut &&
        answerText(modelReply) &&
        !modelReply.content.some((v) => v.type === "toolCall");
      const state = createHash("sha256")
        .update(
          JSON.stringify([
            creation.entries,
            creation.changes,
            files["current.html"],
            drawing.patch,
          ]),
        )
        .digest("hex");
      stalls = state === lastState ? stalls + 1 : 0;
      if (
        prose
          ? answerFragments.length >= loopPolicy.maxProseContinuations
          : stalls >= loopPolicy.maxStalledContinuations
      )
        fault("自动续写后仍未完成，未收到完整结果。本次处理已停止。", 502);
      lastState = state;
      progress?.({
        label: cut ? "输出达到单次上限，正在续写" : "正在检查尚未完成的操作",
      });
      let resume;
      if (prose) {
        answerFragments.push(
          modelReply.content
            .filter((v) => v.type === "text")
            .map((v) => v.text)
            .join(""),
        );
        resume = [
          {
            type: "text",
            text: continueProse,
          },
        ];
      } else {
        root = checkpoint
          ? await root.fork(checkpoint, ownership, ctx)
          : await h.createConversation(ownership, ctx);
        await root.configure(config, ctx);
        resume = continuationInput(cut, prompt, content, !!scope);
      }
      const retry = await admit({ type: "input", requestId: randomUUID(), content: resume });
      settled = await waitSubmission(retry);
      modelReply = await answerModel();
    }
    if (hasFiles() && toolCalls.at(-1)?.status === "failed")
      fault(
        "最后一次文件操作未成功，未提交这一批改动。请核对请求中的路径或文件名。",
        409,
      );
    if (settled.status !== "done") {
      const detail = diagnostic(settled.detail || modelReply?.errorMessage);
      fault(
        "模型任务未完成（" +
          String(settled.reason || settled.status) +
          "）" +
          (detail ? " · " + detail : "") +
          (references.pictures.length && /image|vision|multimodal/i.test(detail)
            ? "。请检查模型是否支持图片输入。"
            : ""),
        502,
      );
    }
    if (!canvas && !hasFiles() && modelReply?.stopReason === "length")
      fault("模型在自动续写后仍达到单次输出上限，本轮未能交付完整结果。", 502);
    const text =
      answerFragments.length && answerText(modelReply)
        ? (
            answerFragments.join("") +
            modelReply.content
              .filter((v) => v.type === "text")
              .map((v) => v.text)
              .join("")
          ).trim()
        : answerText(modelReply);
    if (
      canvas &&
      !hasFiles() &&
      !drawing.patch &&
      (attemptedDrawing() || !text || modelReply?.stopReason === "length")
    ) {
      const reason =
        modelReply?.stopReason === "length"
          ? "模型输出达到上限"
          : "未收到有效的绘图指令";
      fault(
        "未生成画布预览（" + reason + "），可以重新发送或缩小绘制范围。",
        502,
      );
    }
    if (
      !canvas &&
      !hasFiles() &&
      files["current.html"] === html &&
      (!text || modelReply?.stopReason === "length")
    )
      fault("模型输出中断，本轮未写入文档，也没有完整答复。请重新发送。", 502);
    if (missingWrite(modelReply))
      fault("Agent 未提交请求的文件改动，请检查当前会话的要求后重试。", 502);
    const answer =
      text ||
      (drawing.patch
        ? "画布修改已生成，可在左侧预览后采用。"
        : "已生成正文修改，可预览后采用。");
    const out = {
      answer,
      ...(hasFiles() && {
        workspaceFiles: creation.entries.map((f) =>
          typeof f.html === "string" ? { ...f, html: restoreImages(f.html) } : f,
        ),
        workspaceChanges: creation.changes.map((f) =>
          typeof f.html === "string" ? { ...f, html: restoreImages(f.html) } : f,
        ),
      }),
      conversationId: root.id,
      answerEntry: settled.answer,
      compactions,
      skillsUsed: [...skillSet.active],
      ...(drawing.patch && {
        canvasPatch: drawing.patch,
        canvasBase: sceneVersion(doc.scene),
      }),
      toolCalls,
      proposed:
        files["current.html"] !== html ? restoreImages(files["current.html"]) : null,
      ...(files["current.html"] !== html && { base: doc.html || "" }),
    };
    // A lost HTTP response can be retrieved by request ID without re-executing the model.
    await root.commit(async tx => {
      (await tx.doc(WorkspaceAnswer)).result = JSON.parse(JSON.stringify(out));
      (await tx.doc(WorkspaceRun)).current = { status: "completed", requestId, refs: req.refs || [],
        ...(req.editIndex !== undefined && { editIndex: req.editIndex }) };
    }, ctx);
    keepStage = false;
    return out;
  } catch (error) {
    if (error !== paused) {
      if (admitted) {
        const current = (await h.snapshot(WorkspaceRun, ctx))?.current;
        const sub = current && await h.submission(current.submissionId, ctx);
        const state = await sub?.status(ctx);
        if (state?.status === "done" || state?.status === "unanswered") {
          await h.commit(async tx => { (await tx.doc(WorkspaceRun)).current = null; }, ctx);
          keepStage = false;
        }
      }
      throw error;
    }
    await savePause();
    keepStage = didPause = true;
    return { status: "paused", requestId };
  } finally {
    try {
      if (h) await closeChatHarness(identity, h);
    } finally {
      network?.close();
      active.delete(identity);
      finish({ status: didPause ? "paused" : "ended" });
      if (stage && !keepStage)
        await fs.rm(stage, { recursive: true, force: true });
    }
  }
}
