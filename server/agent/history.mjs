import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { directory, fault } from "../storage.mjs";
import { generatedId } from "../../shared/workspace-files.mjs";

// Historically a generated PRD kept its conversations under the delivery version.
// Only that original workspace file owns the old store. A copy has its own file ID.
export function chatStorageId(file) {
  const origin = file.origin;
  if (origin?.file === "prd" && file.id === generatedId(origin.doc, origin.version, "prd"))
    return JSON.stringify(["prd", origin.doc, origin.version]);
  return file.id;
}

export function transcriptPath(docId, sessionId) {
  const key =
    !sessionId || sessionId === "legacy"
      ? docId + "#chat"
      : JSON.stringify([docId, "chat", sessionId]);
  return path.join(
    directory,
    "agent",
    createHash("sha256").update(key).digest("hex") + ".sqlite",
  );
}

// Host-only entries have no model payload. Admission and consumption of a pause
// bookmark can therefore share a Pi transaction without inserting a user turn.
export const pauseKind = "xuye.request-control";
export function pausedRequest(file) {
  if (!existsSync(file)) return;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db
      .prepare(
        "SELECT conversation_id, json_extract(record,'$.data') AS data FROM entries WHERE json_extract(record,'$.kind')=? ORDER BY id DESC LIMIT 1",
      )
      .get(pauseKind);
    const data = row && JSON.parse(row.data);
    if (data?.status === "paused")
      return { ...data, conversationId: row.conversation_id };
  } finally {
    db.close();
  }
}

function userInput(text) {
  const boundary = text.lastIndexOf("\n用户：");
  if (boundary < 0) return;
  const prefix = text.slice(0, boundary);
  const refsAt = Math.max(
    prefix.lastIndexOf("\n引用："),
    prefix.lastIndexOf("需要参考的资料："),
  );
  let refsUsed = [];
  if (refsAt >= 0) {
    try {
      const list = JSON.parse(prefix.slice(prefix.indexOf("：", refsAt) + 1));
      refsUsed = list.flatMap(({ title, file, historyOnly }) => {
        const match = /^upload-([a-f0-9]{64})\.(png|jpeg|webp|gif)$/i.exec(
          file,
        );
        return match && !historyOnly
          ? [{ kind: "image", id: match[1], title }]
          : [];
      });
    } catch {}
  }
  return { q: text.slice(boundary + 4), refsUsed };
}

const fullToolValue = (key, value) => {
  if (
    /^(api[_-]?key|authorization|password|secret|access[_-]?token)$/i.test(key)
  )
    return "[已隐藏]";
  return typeof value === "string"
    ? value
        .replace(/(Bearer\s+)\S+|\bsk-[\w.-]{8,}/gi, "[已隐藏]")
        .replace(
          /((?:api[_-]?key|password|access[_-]?token)\s*[:=]\s*["']?)[^"',\s}]+/gi,
          "$1[已隐藏]",
        )
        .replace(/data:image\/[\w.+-]+;base64,[a-z0-9+/=]+/gi, "[内嵌图片]")
    : value;
};

function toolDetail(db, entry, index) {
  const row = db
    .prepare(
      "SELECT conversation_id, record FROM entries WHERE id=? AND json_extract(record,'$.kind')='pi.assistant'",
    )
    .get(entry);
  const block = row && JSON.parse(row.record).model[0].content[index];
  if (block?.type !== "toolCall") fault("工具调用不存在", 404);
  const nextAssistant = db
    .prepare(
      "SELECT min(id) AS id FROM entries WHERE conversation_id=? AND id>? AND json_extract(record,'$.kind')='pi.assistant'",
    )
    .get(row.conversation_id, entry);
  const record = db
    .prepare(
      "SELECT record FROM entries WHERE conversation_id=? AND id>? AND id<coalesce(?,9223372036854775807) AND json_extract(record,'$.kind')='pi.tool-result' AND json_extract(record,'$.model[0].toolCallId')=? ORDER BY id LIMIT 1",
    )
    .get(row.conversation_id, entry, nextAssistant.id, block.id);
  const entryRecord = record && JSON.parse(record.record);
  const m = entryRecord?.model[0];
  const interrupted = entryRecord?.data?.diagnostics?.some(
    ({ code }) => ["aborted", "abandoned", "interrupted"].includes(code),
  );
  const result = m?.content.map((part) =>
    part.type === "text"
      ? part.text
      : part.type === "image" &&
          /^image\/(png|jpeg|gif|webp)$/.test(part.mimeType)
        ? { type: "image", mimeType: part.mimeType, data: part.data }
        : { type: part.type, mimeType: part.mimeType },
  );
  return JSON.parse(
    JSON.stringify(
      {
        input: block.arguments,
        result,
        status: interrupted
          ? "interrupted"
          : m
            ? m.isError
              ? "failed"
              : "done"
            : "pending",
      },
      fullToolValue,
    ),
  );
}

export function agentHistory(docId, sessionId, tool) {
  const file = transcriptPath(docId, sessionId);
  if (!existsSync(file)) {
    if (tool != null) fault("工具调用不存在", 404);
    return { turns: [] };
  }
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    if (tool !== null && tool !== undefined) {
      if (!/^\d+:\d+$/.test(tool)) fault("工具记录编号无效");
      return toolDetail(db, ...tool.split(":").map(Number));
    }
    const turns = [],
      active = new Map(),
      byEntry = new Map(),
      calls = new Map();
    // Select metadata only. Tool arguments, output and image bytes are loaded on expansion.
    const rows =
      db.prepare(`SELECT id, conversation_id AS conv, json_extract(record,'$.kind') AS kind,
      json_extract(record,'$.model[0].timestamp') AS stamp,
      CASE WHEN json_extract(record,'$.kind')='pi.user' THEN json_extract(record,'$.model[0].content[0].text') END AS prompt,
      CASE WHEN json_extract(record,'$.kind')='pi.assistant' THEN
        (SELECT json_group_array(json_object('idx',j.key,'id',json_extract(j.value,'$.id'),'name',json_extract(j.value,'$.name')))
         FROM json_each(entries.record,'$.model[0].content') j WHERE j.type='object' AND json_extract(j.value,'$.type')='toolCall') END AS tools,
      json_extract(record,'$.model[0].toolCallId') AS callId, json_extract(record,'$.model[0].isError') AS failed,
      EXISTS (SELECT 1 FROM json_each(entries.record,'$.data.diagnostics') d WHERE json_extract(d.value,'$.code') IN ('aborted','abandoned','interrupted')) AS interrupted,
      json_extract(record,'$.model[0].durationMs') AS elapsed FROM entries ORDER BY id`);
    for (const r of rows.iterate()) {
      if (r.kind === "pi.user") {
        const user = userInput(r.prompt || "");
        if (user && !user.q.includes("\n宿主续写：")) {
          const turn = {
            ...user,
            entry: r.id,
            createdAt: r.stamp,
            toolCalls: [],
            submissions: [],
          };
          turns.push(turn);
          active.set(r.conv, turn);
        } else if (user && turns.at(-1)?.q === user.q.split("\n宿主续写：")[0])
          active.set(r.conv, turns.at(-1));
        if (active.has(r.conv)) byEntry.set(r.id, active.get(r.conv));
      }
      const turn = active.get(r.conv);
      if (!turn) continue;
      if (r.kind === "pi.assistant") {
        turn.lastAssistant = r.id;
        for (const t of JSON.parse(r.tools || "[]")) {
          const call = {
            name: t.name,
            key: r.id + ":" + t.idx,
            status: "running",
          };
          calls.set(r.conv + ":" + t.id, call);
          turn.toolCalls.push(call);
        }
      } else if (r.kind === "pi.tool-result") {
        const call = calls.get(r.conv + ":" + r.callId);
        if (call)
          Object.assign(call, {
            status: r.interrupted
              ? "interrupted"
              : r.failed
                ? "failed"
                : "done",
            duration: r.elapsed,
          });
      }
    }
    const current = new Map();
    for (const r of db
      .prepare("SELECT record FROM submissions ORDER BY id")
      .iterate()) {
      const s = JSON.parse(r.record),
        turn = byEntry.get(s.entry) || current.get(s.conversationId);
      if (!turn) continue;
      current.set(s.conversationId, turn);
      if (!turn.requestId) turn.requestId = s.requestId;
      turn.submissions.push({
        id: s.id,
        status: s.status,
        reason: s.reason,
        detail: s.detail && fullToolValue("", s.detail),
      });
      turn.status = s.status;
      turn.reason = s.reason;
      if (s.answer) turn.answerEntry = s.answer;
    }
    for (const t of turns) {
      if (t.status === "unanswered")
        for (const call of t.toolCalls)
          if (call.status === "running") call.status = "interrupted";
    }
    const byRequest = new Map(turns.map((t) => [t.requestId, t]));
    for (const row of db
      .prepare(
        "SELECT json_extract(record,'$.data') AS data FROM entries WHERE json_extract(record,'$.kind')=? ORDER BY id",
      )
      .iterate(pauseKind)) {
      const data = JSON.parse(row.data),
        turn = byRequest.get(data.requestId);
      if (!turn) continue;
      if (data.status === "resumed") delete turn.control;
      else turn.control = data.status;
      if (data.editIndex !== undefined) turn.editIndex = data.editIndex;
      if (data.refs) turn.refsUsed = data.refs;
    }
    return { turns };
  } finally {
    db.close();
  }
}
