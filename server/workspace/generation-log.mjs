import { createHash, randomUUID } from "node:crypto";
import { db, transaction } from "../storage.mjs";

db.exec(`
CREATE TABLE IF NOT EXISTS generation_runs (
  id TEXT PRIMARY KEY,
  doc TEXT NOT NULL,
  started INTEGER NOT NULL,
  record TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pending_deliveries(run TEXT PRIMARY KEY, doc TEXT NOT NULL, content TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS generation_runs_doc_started ON generation_runs(doc, started DESC);
UPDATE generation_runs SET record=json_set(record, '$.status', 'interrupted')
WHERE json_extract(record, '$.status')='running';
`);

// Retrying delivery of a settled Pi submission must not create another review.
export function recordWorkspaceFiles(owner, files, changes, question, chatId, conversationId, receipt) {
  const id = receipt == null ? randomUUID() : createHash("sha256")
    .update(JSON.stringify([owner, chatId || "legacy", conversationId, receipt]))
    .digest("hex");
  return transaction(() => {
    if (db.prepare("SELECT 1 FROM generation_runs WHERE id=?").get(id))
      return pendingDelivery(id, owner);
    const now = Date.now();
    const record = { id, started: now, finished: now, stage: "delivery", status: "done", tools: [] };
    const output = { files, changes, question };
    db.prepare("INSERT INTO generation_runs VALUES(?,?,?,?)").run(id, owner, now, JSON.stringify(record));
    db.prepare("INSERT INTO pending_deliveries VALUES(?,?,?)").run(id, owner, JSON.stringify(output));
    return { ...output, runId: id };
  });
}

export function generationRuns(doc) {
  return db
    .prepare(
      "SELECT record, p.run IS NOT NULL AS recoverable FROM generation_runs g LEFT JOIN pending_deliveries p ON p.run=g.id WHERE g.doc=? ORDER BY g.started DESC",
    )
    .all(doc)
    .filter((r, i) => i < 20 || r.recoverable)
    .map(({ record, recoverable }) => ({
      ...JSON.parse(record),
      recoverable: !!recoverable,
    }));
}

export function pendingDelivery(id, doc) {
  const row = db
    .prepare("SELECT content FROM pending_deliveries WHERE run=? AND doc=?")
    .get(id, doc);
  return row && { ...JSON.parse(row.content), runId: id };
}
// Run in the workspace save transaction so a failed save leaves the recovery copy available.
export function acknowledgeDeliveries(files) {
  for (const { run, doc, html, prd, manifest, changes } of db
    .prepare(
      "SELECT run,doc,json_extract(content,'$.files') AS manifest,json_extract(content,'$.changes') AS changes,json_type(content,'$.html') IS NOT NULL AS html,json_type(content,'$.prd') IS NOT NULL AS prd FROM pending_deliveries",
    )
    .all()) {
    const archived = files.filter(
      (f) => f.origin?.runId === run && f.origin?.doc === doc,
    );
    if (
      !files.some((f) => f.id === doc) ||
      (manifest
        ? JSON.parse(manifest).every((item) =>
            files.some((f) => f.id === item.id),
          ) &&
          JSON.parse(changes || "[]").every((item) =>
            files.some((f) => f.id === item.id && f.workspaceChangeRun === run),
          )
        : [...(html ? ["html"] : []), ...(prd ? ["prd"] : [])].every((k) =>
            archived.some((f) => f.origin.file === k),
          ))
    )
      db.prepare("DELETE FROM pending_deliveries WHERE run=?").run(run);
  }
}
