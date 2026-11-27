import {
  findDelivery,
  boardType,
  folderListing,
} from "../../shared/workspace-files.mjs";
import { db, token, fault } from "../storage.mjs";
import { fileLabel } from "../../shared/assistant-context.mjs";

db.exec(`CREATE TABLE IF NOT EXISTS file_shares (
  token TEXT PRIMARY KEY, doc TEXT NOT NULL, version INTEGER NOT NULL, file TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1, UNIQUE(doc,version,file))`);

if (!db.prepare("PRAGMA table_info(file_shares)").all().some((c) => c.name === "enabled"))
  db.exec("ALTER TABLE file_shares ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1");

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
// A materialized delivery and its historical (owner, version, part) reference
// identify one file. Retain previously issued tokens, including version-0 PRD aliases.
function canonicalRef(docs, ref) {
  if (ref.version === 0 && ["document", "prd"].includes(ref.file)) {
    const node = docs.find(f => f.id === ref.doc);
    if (node?.origin?.version > 0) return node.origin;
    return { ...ref, file: "document" };
  }
  return ref;
}

const rowFor = db.prepare("SELECT token,enabled FROM file_shares WHERE doc=? AND version=? AND file=?");
function rowsFor(docs, ref) {
  const refs = [ref];
  if (ref.file === "document") refs.push({ ...ref, file: "prd" });
  else for (const node of docs) {
    const origin = node.origin;
    if (origin?.doc === ref.doc && origin.version === ref.version && origin.file === ref.file)
      refs.push({ doc: node.id, version: 0, file: "document" }, { doc: node.id, version: 0, file: "prd" });
  }
  return refs.map(r => rowFor.get(r.doc, r.version, r.file)).filter(Boolean);
}

const legacyFor = db.prepare("SELECT * FROM shares WHERE doc=? AND version=?");
function legacyEnabled(docs, link) {
  if (!link) return false;
  const parts = link.version === 0 ? ["document"] : ["html", "prd"];
  return parts.every(file => rowsFor(docs, { doc: link.doc, version: link.version, file }).every(row => row.enabled));
}

export function shareTokens(docs, ref) {
  const canonical = canonicalRef(docs, ref);
  return [...rowsFor(docs, canonical), legacyFor.get(canonical.doc, canonical.version)].filter(Boolean).map(r => r.token);
}

export function fileShareState(docs, requested, enabled) {
  if (!content(docs, requested)) fault("文件不存在", 404);
  const ref = canonicalRef(docs, requested);
  const rows = rowsFor(docs, ref);
  const pair = legacyFor.get(ref.doc, ref.version);
  if (enabled === undefined) {
    if (rows.length) return rows.every(r => r.enabled) ? rows[0].token : null;
    return legacyEnabled(docs, pair) ? pair.token : null;
  }
  if (rows.length) {
    db.prepare("UPDATE file_shares SET enabled=?,revision=revision+1 WHERE enabled!=? AND token IN (SELECT value FROM json_each(?))")
      .run(Number(enabled), Number(enabled), JSON.stringify(rows.map(r => r.token)));
    return enabled ? rows[0].token : null;
  }
  const key = token();
  db.prepare("INSERT INTO file_shares(token,doc,version,file,enabled) VALUES(?,?,?,?,?)")
    .run(key, ref.doc, ref.version, ref.file, Number(enabled));
  return enabled ? key : null;
}

export function lookupShare(key, docs) {
  const row = db.prepare("SELECT doc,version,file,revision FROM file_shares WHERE enabled=1 AND token=?").get(key);
  if (row) {
    const ref = canonicalRef(docs, row);
    if (rowsFor(docs, ref).some(r => !r.enabled)) return;
    const data = content(docs, ref);
    if (data) {
      const part = ref.file === "html" && docs.find(f => f.origin?.doc === ref.doc && f.origin.version === ref.version && f.origin.file === "html");
      const commentRef = part ? { doc: part.id, version: 0 } : ref;
      return { ref: commentRef, data: { ...data, revision: row.revision }, canComment: true };
    }
  } else {
    const pair = db.prepare("SELECT * FROM shares WHERE token=?").get(key);
    if (!legacyEnabled(docs, pair)) return;
    const { doc, version, title, html, prd, revision } = pair;
    const data = html && prd ? { html, prd } : { kind: html ? "html" : "prd", content: html || prd };
    return { ref: { doc, version }, data: { ...data, title, revision }, canComment: !!prd };
  }
}

export function legacyShareToken(docs, doc, version, lookup) {
  const output = findDelivery(docs, doc, version);
  if (!output?.html || !output?.prd) fault("先生成并保存两份交付文件");
  const pair = legacyFor.get(doc, version);
  if (pair) return legacyEnabled(docs, pair) ? pair.token : null;
  if (lookup || !legacyEnabled(docs, { doc, version })) return null;
  const key = token();
  db.prepare("INSERT INTO shares(token,doc,version,title,html,prd) VALUES(?,?,?,?,?,?)")
    .run(key, doc, version, output.title, output.html, output.prd);
  return key;
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
  for (const s of db.prepare("SELECT token,doc,version FROM shares").all()) {
    const a = findDelivery(after, s.doc, s.version);
    if (!a?.html && !a?.prd) {
      db.prepare("DELETE FROM comments WHERE token=?").run(s.token);
      db.prepare("DELETE FROM shares WHERE token=?").run(s.token);
      changed.push(s.token);
      continue;
    }
    const r = db
      .prepare(
        "UPDATE shares SET title=?,html=?,prd=?,revision=revision+1 WHERE token=? AND (title!=? OR html!=? OR prd!=?)",
      )
      .run(
        a.title,
        a.html || "",
        a.prd || "",
        s.token,
        a.title,
        a.html || "",
        a.prd || "",
      );
    if (r.changes) changed.push(s.token);
  }
}
