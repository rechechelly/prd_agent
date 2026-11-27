import { randomUUID } from "node:crypto";
import { db, fault, transaction } from "../storage.mjs";
import { migrateDirectory } from "../../shared/migrate-directory.mjs";
import { migrateExternalReviews } from "./migrate-reviews.mjs";
import { relatedFiles } from "../../shared/chat-sessions.mjs";
import { forkSession } from "../agent/branches.mjs";
import { removeTranscript } from "../agent/queue.mjs";
import { chatStorageId, sessionStore } from "../agent/history.mjs";

export const filesOf = w => [...(w?.docs || []), ...(w?.folders || [])];
let cached;
export function workspaceRow() {
  if (cached) return cached;
  const row = db.prepare("SELECT revision,body FROM state WHERE id=1").get();
  cached = { revision: row?.revision || 0, data: row ? JSON.parse(row.body) : null };
  return cached;
}
export function replaceWorkspace(revision, data) {
  db.prepare("INSERT OR REPLACE INTO state VALUES(1,?,?)").run(revision, JSON.stringify(data));
}
export function invalidateWorkspace() { cached = undefined; }

export function migrateWorkspace() {
  const { revision, data } = workspaceRow();
  if (!data || Array.isArray(data.chats)) return;
  migrateDirectory(data.docs, data.folders);
  data.chats = [];
  for (const file of filesOf(data)) {
    file.key = randomUUID();
    migrateExternalReviews(file);
    for (const old of file.chatSessions || (file.messages?.length ? [{ id: "legacy", messages: file.messages }] : [])) {
      const messages = old.messages || [];
      for (const m of messages) {
        m.fileId = file.id;
        if (m.refs?.length && (m.answerEntry || m.toolCalls?.length)) m.written = m.refs;
      }
      data.chats.push({ ...old, id: randomUUID(), sourceId: file.id, storeDoc: chatStorageId(file),
        storeChat: old.id, messages, updatedAt: old.updatedAt || messages.at(-1)?.createdAt || 0 });
    }
    delete file.chatSessions;
    delete file.selectedChat;
    delete file.messages;
  }
  transaction(() => replaceWorkspace(revision + 1, data));
  invalidateWorkspace();
}

export const fileSummary = ({ id, key, title, type, parent, position, origin }) =>
  ({ id, key, title, type, parent, position, origin, deferred: true });
export function workspaceIndex(data) {
  if (!data) return null;
  return { completionEnabled: data.completionEnabled, docs: data.docs.map(fileSummary),
    folders: data.folders.map(fileSummary), chats: data.chats.map(s =>
      ({ id: s.id, fileIds: relatedFiles(s), updatedAt: s.updatedAt, lastAskedAt: s.lastAskedAt, deferred: true })) };
}
export function fileDetail(data, id) {
  const file = filesOf(data).find(f => f.id === id);
  if (!file) fault("文件不存在", 404);
  return { file, chats: data.chats.filter(s => relatedFiles(s).includes(id)) };
}

// A directory rename/move can update a record whose body was never loaded.
export function expandWorkspace(input, previous) {
  if (!Array.isArray(input?.docs) || !Array.isArray(input.folders) || !Array.isArray(input.chats))
    fault("工作台版本已更新，请刷新后继续", 409);
  const oldFiles = new Map(filesOf(previous).map(f => [f.id, f]));
  const oldChats = new Map((previous?.chats || []).map(s => [s.id, s]));
  const seen = new Set(), keys = new Set();
  function expand(file) {
    if (!file || typeof file.id !== "string" || !file.id || seen.has(file.id)) fault("文件编号无效或重复");
    seen.add(file.id);
    const prior = oldFiles.get(file.id);
    if (file.deferred) {
      if (!prior) fault("文件已变更，请刷新", 409);
      file = { ...prior, title: file.title, parent: file.parent, position: file.position };
    }
    const key = prior?.key || (/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(file.id) ? file.id : randomUUID());
    if (keys.has(key)) fault("文件地址重复");
    keys.add(key);
    return { ...file, key };
  }
  const chatIds = new Set();
  const chats = input.chats.map(s => {
    if (!s || typeof s.id !== "string" || !s.id || chatIds.has(s.id)) fault("会话编号无效或重复");
    chatIds.add(s.id);
    if (s.deferred && !oldChats.has(s.id)) fault("会话已变更，请刷新", 409);
    if (s.deferred) return oldChats.get(s.id);
    const prior = oldChats.get(s.id);
    if (!Array.isArray(s.messages) || typeof s.sourceId !== "string" ||
        prior && prior.sourceId !== s.sourceId) fault("会话数据无效");
    return { ...s, storeDoc: prior?.storeDoc, storeChat: prior?.storeChat };
  });
  return { completionEnabled: input.completionEnabled, docs: input.docs.map(expand), folders: input.folders.map(expand), chats };
}

export async function branchWorkspace(input) {
  const read = () => {
    const row = workspaceRow();
    if (input.revision !== row.revision) fault("工作区已更新，请刷新后再创建分支", 409);
    return row.data;
  };
  const data = read();
  const session = data?.chats.find(s => s.id === input.chatId && relatedFiles(s).includes(input.doc));
  if (!session) fault("会话不存在", 404);
  const branch = await forkSession(session, input.index, input.role, input.entry, input.doc);
  const revision = input.revision + 1;
  try {
    transaction(() => {
      const current = read();
      replaceWorkspace(revision, { ...current, chats: [...current.chats, branch] });
    });
    invalidateWorkspace();
    return { revision, branch };
  } catch (error) {
    await removeTranscript(sessionStore(branch));
    throw error;
  }
}
