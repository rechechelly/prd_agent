import {
  findDelivery,
  boardType,
  folderListing,
} from "../shared/workspace-files.mjs";
import { db, token, fault } from "./storage.mjs";
import { fileLabel } from "../shared/assistant-context.mjs";

db.exec(`CREATE TABLE IF NOT EXISTS file_shares (
  token TEXT PRIMARY KEY, doc TEXT NOT NULL, version INTEGER NOT NULL, file TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1, UNIQUE(doc,version,file))`);

function content(docs, { doc, version, file }) {
  const owner = docs?.find((d) => d.id === doc);
  if (!owner && file === "document") return;
  if (file === "document" && version === 0) {
    if (owner.detachedSource) return;
    if (owner.type === "交互 HTML")
      return { title: owner.title, kind: "html", content: owner.html ?? "" };
    if (owner.type === "文件夹")
      return {
        title: owner.title,
        kind: "folder",
        content: folderListing(owner, docs),
      };
    if (boardType(owner.type)) {
      const scene = (owner.scene || []).filter((e) => !e.isDeleted);
      const ids = new Set(scene.map((e) => e.fileId).filter(Boolean));
      const files = Object.fromEntries(
        Object.entries(owner.files || {}).filter(([id]) => ids.has(id)),
      );
      return { title: owner.title, kind: "board", scene, files };
    }
    return {
      title: owner.title,
      kind: "document",
      content: owner.html || "<p></p>",
    };
  }
  const output = findDelivery(docs, doc, version);
  if ((file === "html" || file === "prd") && typeof output?.[file] === "string")
    return {
      title: fileLabel(output, file),
      kind: file,
      content: output[file],
    };
}
export function createFileShare(docs, ref) {
  if (!content(docs, ref)) fault("文件不存在", 404);
  let row = db
    .prepare(
      "SELECT token FROM file_shares WHERE doc=? AND version=? AND file=?",
    )
    .get(ref.doc, ref.version, ref.file);
  if (!row) {
    row = { token: token() };
    db.prepare(
      "INSERT INTO file_shares(token,doc,version,file) VALUES(?,?,?,?)",
    ).run(row.token, ref.doc, ref.version, ref.file);
  }
  return row.token;
}
export function lookupFileShare(key, docs) {
  const ref = db
    .prepare("SELECT doc,version,file,revision FROM file_shares WHERE token=?")
    .get(key);
  if (!ref) return;
  const data = content(docs, ref);
  if (data) return { ref, data: { ...data, revision: ref.revision } };
}
export function updateFileShares(before, after, changed) {
  for (const ref of db.prepare("SELECT * FROM file_shares").all()) {
    const next = content(after, ref);
    if (!next)
      db.prepare("DELETE FROM file_shares WHERE token=?").run(ref.token);
    else if (JSON.stringify(content(before, ref)) !== JSON.stringify(next))
      db.prepare(
        "UPDATE file_shares SET revision=revision+1 WHERE token=?",
      ).run(ref.token);
    else continue;
    changed.push(ref.token);
  }
}
