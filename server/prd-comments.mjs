import { db, fault, set, setting, transaction } from "./storage.mjs";

db.exec(`
CREATE TABLE IF NOT EXISTS prd_comments (
  id INTEGER PRIMARY KEY,
  doc TEXT NOT NULL,
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  body TEXT NOT NULL,
  stamp INTEGER NOT NULL,
  anchor TEXT
);
CREATE INDEX IF NOT EXISTS prd_comments_delivery ON prd_comments(doc,version,id);
`);
if (
  !db
    .prepare("PRAGMA table_info(prd_comments)")
    .all()
    .some((c) => c.name === "parent_id")
)
  db.exec(
    "ALTER TABLE prd_comments ADD COLUMN parent_id INTEGER REFERENCES prd_comments(id) ON DELETE CASCADE",
  );
if (!setting("prd_comments_v1")) {
  transaction(() => {
    db.exec(`INSERT OR IGNORE INTO prd_comments(id,doc,version,name,body,stamp)
      SELECT c.id, s.doc, s.version, c.name,c.body,c.stamp
      FROM comments c JOIN shares s ON s.token=c.token`);
    set("prd_comments_v1", "1");
  });
}

export function listComments(doc, version) {
  return db
    .prepare(
      "SELECT id,name,body,stamp,anchor,parent_id AS parentId FROM prd_comments WHERE doc=? AND version=? ORDER BY id",
    )
    .all(doc, version)
    .map((c) => ({ ...c, anchor: c.anchor ? JSON.parse(c.anchor) : null }));
}

export function addComment(doc, version, input, author) {
  const message = typeof input?.body === "string" ? input.body.trim() : "";
  if (typeof message !== "string" || !message || message.length > 2000)
    fault("请输入 1 至 2000 字的评论");
  const parent = input.parentId ?? null;
  if (author && parent === null) fault("请选择要回复的评论");
  if (
    parent !== null &&
    (!author ||
      !Number.isSafeInteger(parent) ||
      !db
        .prepare(
          "SELECT 1 FROM prd_comments WHERE id=? AND doc=? AND version=? AND parent_id IS NULL",
        )
        .get(parent, doc, version))
  )
    fault("回复的评论不存在");
  let anchor = null;
  if (parent === null && input.anchor != null) {
    const { exact, prefix, suffix, start } = input.anchor;
    if (
      typeof exact !== "string" ||
      !exact.trim() ||
      exact.length > 1000 ||
      typeof prefix !== "string" ||
      prefix.length > 48 ||
      typeof suffix !== "string" ||
      suffix.length > 48 ||
      !Number.isSafeInteger(start) ||
      start < 0
    )
      fault("请选择不超过 1000 字的 PRD 片段");
    anchor = JSON.stringify({ exact, prefix, suffix, start });
  }
  const name =
    author ||
    String(input.name || "")
      .trim()
      .slice(0, 40) ||
    "访客";
  db.prepare(
    "INSERT INTO prd_comments(doc,version,name,body,stamp,anchor,parent_id) VALUES (?,?,?,?,?,?,?)",
  ).run(doc, version, name, message, Date.now(), anchor, parent);
}

export function pruneComments(findArtifact) {
  for (const { doc, version } of db
    .prepare("SELECT DISTINCT doc,version FROM prd_comments")
    .all())
    if (!findArtifact(doc, version))
      db.prepare("DELETE FROM prd_comments WHERE doc=? AND version=?").run(
        doc,
        version,
      );
}
