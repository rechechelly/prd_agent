import { mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createSession, defineDoc, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { fault } from "../storage.mjs";

// One Pi database per workbench chat. A session-scoped document also survives
// conversation forks. The queue is consumed in the same commit as pi.user.
const Queue = defineDoc({
  kind: "xuye.message-queue", version: 1, scope: "session",
  initial: () => ({ items: [] }), checkpointWhen: () => true,
});
// The SDK owns task and submission state. This document only associates its
// current submission with the host's staging area for online-file previews.
export const WorkspaceRun = defineDoc({
  kind: "xuye.workspace-run", version: 1, scope: "session",
  initial: () => ({ current: null }), checkpointWhen: () => true,
});
export const WorkspaceAnswer = defineDoc({
  kind: "xuye.workspace-answer", version: 1, scope: "session",
  initial: () => ({ result: null }), checkpointWhen: () => true,
});
const writers = new Map();
const locks = new Map();
async function exclusive(path, action) {
  const previous = locks.get(path) || Promise.resolve();
  const run = previous.then(action);
  const settled = run.catch(() => {});
  locks.set(path, settled);
  try { return await run; }
  finally { if (locks.get(path) === settled) locks.delete(path); }
}
export function openChatHarness(path, options) {
  return exclusive(path, async () => {
    const harness = await Harness.open(await openNodeSqliteStorage(path), options, ctx);
    writers.set(path, harness);
    return harness;
  });
}
export function closeChatHarness(path, harness) {
  return exclusive(path, async () => {
    writers.delete(path);
    await harness.close(ctx);
  });
}
export function workspaceSnapshot(path, document = WorkspaceRun) {
  return exclusive(path, async () => {
    if (!existsSync(path)) return;
    const writer = writers.get(path);
    const store = writer || createSession(await openNodeSqliteStorage(path));
    try { return await store.snapshot(document, ctx); }
    finally { if (!writer) await store.close(ctx); }
  });
}
export async function messageQueue(path, action = "list", input = {}) {
  return exclusive(path, async () => {
    const writer = writers.get(path);
    if (!writer && action === "list" && !existsSync(path)) return [];
    if (!writer) await mkdir(dirname(path), { recursive: true });
    const store = writer || createSession(await openNodeSqliteStorage(path));
    try {
      if (action !== "list") await store.commit(async tx => {
        const queue = await tx.doc(Queue);
        const index = queue.items.findIndex(item => item.requestId === input.requestId);
        if (action === "add") {
          if (index < 0 && (await tx.doc(WorkspaceRun)).current?.requestId !== input.requestId)
            queue.items.push(input);
        } else if (action === "rejectSelection") {
          if (index >= 0) queue.items.splice(index, 1);
        } else if (action === "prioritize") {
          if (index < 0) fault("这条消息已离开队列", 409);
          if (index > 0) {
            const item = JSON.parse(JSON.stringify(queue.items[index]));
            queue.items.splice(index, 1);
            queue.items.unshift(item);
          }
        } else fault("未知的队列操作");
      }, ctx);
      return (await store.snapshot(Queue, ctx))?.items || [];
    } finally { if (!writer) await store.close(ctx); }
  });
}
export async function consumeQueued(tx, id) {
  const queue = await tx.doc(Queue);
  if (queue.items[0]?.requestId !== id) fault("消息队列已更新，请重试", 409);
  queue.items.shift();
}

// Serialize removal with short-lived queue readers as well as the durable writer.
export function removeTranscript(path) {
  return exclusive(path, async () => {
    if (writers.has(path)) fault("请先暂停正在运行的会话", 409);
    for (const suffix of ["", "-wal", "-shm"]) await rm(path + suffix, { force: true });
  });
}
