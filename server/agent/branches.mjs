import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { fault } from "../storage.mjs";
import { removeTranscript } from "./queue.mjs";
import { agentHistory, transcriptPath, sessionStore } from "./history.mjs";
import { DEFAULT_CONTEXT_WINDOW } from "../../shared/chat-sessions.mjs";

// The queue and active submission are session-scoped Pi documents. Give a branch
// its own store and import only the visible transcript prefix, including compaction boundaries.
export async function forkSession(source, index, role, userEntry, currentFile) {
  const doc = source.storeDoc ?? source.sourceId, chat = source.storeChat ?? source.id;
  const path = transcriptPath(doc, chat);
  const turns = existsSync(path) ? agentHistory(doc, chat).turns : [];
  if (role === "user" && index === -1) {
    const t = turns.find(t => t.entry === userEntry);
    if (!t) fault("这条提问尚未提交到 Pi", 409);
    const saved = source.failedAttempts?.find(m => m.requestId === t.requestId);
    const before = source.messages.filter(m => (m.userEntry ?? m.answerEntry ?? Infinity) < t.entry);
    const question = { q: t.q, refsUsed: saved?.refsUsed || t.refsUsed, requestId: t.requestId,
      createdAt: t.createdAt, fileId: t.fileId || saved?.fileId || currentFile, userEntry };
    source = { ...source, messages: [...before, question] };
    index = before.length;
  }
  if (!Number.isSafeInteger(index) || !source.messages[index] || !["user","assistant"].includes(role))
    fault("请选择要分支的用户消息或助手回复");
  const branch = { id: randomUUID(), sourceId: source.sourceId, updatedAt: Date.now(),
    contextWindow: source.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    name: (source.name || source.messages[0].q).slice(0, 65) + " · 分支",
    messages: structuredClone(source.messages.slice(0, index + 1)) };
  const last = branch.messages.at(-1);
  if (role === "assistant" && last.userOnly) fault("该消息没有助手回复");

  for (const m of branch.messages) {
    const t = turns.findLast(t => (m.requestId && t.requestId === m.requestId) || (m.answerEntry && t.lastAssistant === m.answerEntry));
    m.userEntry ??= t?.entry;
    m.answerEntry ??= t?.answerEntry;
    // A branch inherits conversation context, not a second actionable review.
    delete m.proposed; delete m.canvasPatch; delete m.canvasBase; delete m.base;
    delete m.resolved;
    delete m.reviewChoices; delete m.reviewCurrent;
  }
  const cutoff = role === "user" ? last.userEntry : last.answerEntry;
  if (role === "user") {
    const { q, fileId, refsUsed, createdAt, requestId, userEntry } = last;
    branch.messages[index] = { q, fileId, refsUsed, createdAt, requestId, userEntry, userOnly: true };
  }
  if (!cutoff) {
    if (existsSync(path) && source.conversationId) fault("无法定位这条消息的 Pi 记录", 409);
    return branch; // Offline/imported chats rebuild context from their retained messages.
  }
  const src = await openNodeSqliteStorage(path);
  try {
    const entry = (await src.entry(cutoff, ctx))?.entry;
    if (entry?.kind !== "pi." + role) fault("分支节点不存在", 409);
    const dst = await Harness.open(await openNodeSqliteStorage(sessionStore(branch)), {
      registry: createRegistry(), models: createModels(),
    }, ctx);
    const ids = new Map();
    try {
      branch.conversationId = await dst.commit(async tx => {
        const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
        let cursor;
        do {
          const page = await src.scanEntries({ conversationId: entry.conversationId, maxEntryId: cutoff, order: "ascending" }, 128, cursor, ctx);
          for (const e of page.items) {
            if (!e.kind.startsWith("pi.")) continue;
            const draft = { kind: e.kind, model: e.model, data: e.data };
            if (e.head != null) draft.head = e.head === e.id ? "self" : ids.get(e.head);
            if (e.edits) draft.edits = e.edits.filter(v => ids.has(v.target)).map(v => ({ ...v, target: ids.get(v.target) }));
            ids.set(e.id, (await tx.appendEntry(conversation.id, draft)).id);
          }
          cursor = page.next;
        } while (cursor !== undefined);
        return conversation.id;
      }, ctx);
      const conversation = await dst.conversation(branch.conversationId, ctx);
      branch.messages[index].contextTokens = estimateContextTokens(await conversation.context(ctx)).tokens;
    } finally { await dst.close(ctx); }
    for (const m of branch.messages) {
      m.userEntry = ids.get(m.userEntry);
      m.answerEntry = ids.get(m.answerEntry);
    }
    return branch;
  } catch (error) {
    await removeTranscript(sessionStore(branch));
    throw error;
  } finally { await src.close(ctx); }
}
