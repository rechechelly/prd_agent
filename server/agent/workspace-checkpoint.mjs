import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { hook, ToolTask } from "@earendil-works/pi-durable";

// Only an immutable snapshot named by a committed Pi result can become a
// workspace proposal on recovery. A process may die between staging and commit.
export function workspaceCheckpoints(stage, input, draft) {
  let admission, previous;
  const hash = (text) => createHash("sha256").update(text).digest("hex");
  async function write(text) {
    const file = randomUUID() + ".json";
    await fs.writeFile(path.join(stage, file), text, { flag: "wx", mode: 0o600, flush: true });
    return file;
  }
  return {
    snapshot: () => write(JSON.stringify({ ...input, ...draft() })),
    bind(id) { admission = id; previous = hash(JSON.stringify(draft())); },
    resultHook: hook(ToolTask, {
      async afterTool(call, result) {
        if (call.parent || result.isError || !admission) return;
        const text = JSON.stringify(draft());
        const digest = hash(text);
        if (digest === previous) return;
        const file = await write(text);
        previous = digest;
        return { ...result, details: { ...result.details, workspaceCheckpoint: { admission, file } } };
      },
    }),
  };
}

export async function readWorkspaceCheckpoint(stage, identity, run) {
  const read = async file => JSON.parse(await fs.readFile(path.join(stage, file), "utf8"));
  const baseline = await read(run.snapshot);
  const file = committedSnapshot(identity, run);
  return file === run.snapshot ? baseline : { ...baseline, ...await read(file) };
}

export function committedSnapshot(identity, run) {
  if (!run.admission) return run.snapshot;
  const db = new DatabaseSync(identity, { readOnly: true });
  try {
    const row = db.prepare(`SELECT json_extract(record,'$.model[0].details.workspaceCheckpoint.file') AS file
      FROM entries WHERE conversation_id=? AND json_extract(record,'$.kind')='pi.tool-result'
      AND json_extract(record,'$.model[0].details.workspaceCheckpoint.admission')=?
      ORDER BY id DESC LIMIT 1`).get(run.conversationId, run.admission);
    if (row?.file && /^[a-f0-9-]{36}\.json$/i.test(row.file)) return row.file;
    return run.snapshot;
  } finally { db.close(); }
}
