import { boardType, generatedFiles } from "../../shared/workspace-files.mjs";
import { sceneVersion } from "../../shared/canvas-model.mjs";
import { emptyHtml } from "./html-source";
import { proposedScene } from "./board";
import { lastVersion } from "../../shared/migrate-directory.mjs";

const editsBody = c => c.html !== undefined && c.html !== c.base.html;

function applyWorkspaceFiles(docs, folders, output, documentBody) {
  const all = new Map([...docs, ...folders].map((f) => [f.id, f]));
  const added = output.files
    .filter((f) => !all.has(f.id))
    .map(({ drawing, ...f }) => {
      if (boardType(f.type))
        f.scene = drawing ? proposedScene([], drawing) : [];
      else if (f.type === "交互 HTML") f.html ??= emptyHtml(f.title);
      else if (f.type === "文档") f.html = documentBody(f.html || "<p></p>");
      return f;
    });
  const changes = output.changes.filter(
    (c) => all.get(c.id)?.workspaceChangeRun !== output.runId,
  );
  const projected = new Map(all);
  for (const f of added) projected.set(f.id, f);
  for (const c of changes) {
    const f = all.get(c.id);
    if (
      !f ||
      f.title !== c.base.title ||
      (f.parent || "") !== c.base.parent ||
      (editsBody(c) && c.base.html !== undefined && (f.html || "") !== c.base.html) ||
      (c.base.scene !== undefined && sceneVersion(f.scene) !== c.base.scene)
    )
      throw Error("目标文件在任务期间已变更，请刷新并核对：" + c.base.title);
    projected.set(c.id, {
      ...f,
      ...(c.title !== undefined && { title: c.title }),
      ...(c.parent !== undefined && { parent: c.parent }),
    });
  }
  for (const id of [...added.map((f) => f.id), ...changes.map((c) => c.id)]) {
    const f = projected.get(id);
    const before = all.get(id);
    const pathChanged = !before || before.title !== f.title || (before.parent || "") !== (f.parent || "");
    if (
      pathChanged && [...projected.values()].some(
        (p) =>
          p.id !== id &&
          (p.parent || "") === (f.parent || "") &&
          p.title === f.title,
      )
    )
      throw Error("目标位置有同名文件：" + f.title);
    const seen = new Set([id]);
    let parent = f.parent;
    while (parent) {
      if (!projected.has(parent) || seen.has(parent))
        throw Error("目标父文件已变更：" + f.title);
      seen.add(parent);
      parent = projected.get(parent).parent;
    }
  }
  for (const f of added) {
    (f.type === "文件夹" ? folders : docs).push(f);
    all.set(f.id, f);
  }
  for (const c of changes) {
    const f = all.get(c.id);
    if (c.title !== undefined) f.title = c.title;
    if (c.parent !== undefined) f.parent = c.parent;
    // Older deliveries may contain an unchanged body alongside metadata.
    const bodyChanged = editsBody(c) && c.html !== (f.html || "");
    if (bodyChanged || c.drawing) {
      (f.externalReviews ||= []).push({
        ...(bodyChanged && { proposed: c.html, base: f.html }),
        ...(c.drawing && { canvasPatch: c.drawing, canvasBase: c.base.scene }),
      });
    }
    f.workspaceChangeRun = output.runId;
  }
  return [
    ...output.files.map((f) => f.id),
    ...output.changes.map((c) => c.id),
  ]
    .map((id) => all.get(id))
    .filter(Boolean);
}
export function applyDelivery(docs, folders, d, output, title, documentBody) {
  if (Array.isArray(output.files)) return applyWorkspaceFiles(docs, folders, output, documentBody);
  const existing =
    output.runId && docs.filter((f) => f.origin?.runId === output.runId);
  if (
    existing?.length &&
    ["prd", "html"].every(
      (k) => !output[k] || existing.some((f) => f.origin.file === k),
    )
  )
    return existing;
  const version = lastVersion(d) + 1,
    suffix = version > 1 ? " · v" + version : "";
  const children = generatedFiles(d, {
    ...output,
    version,
    fileNames: {
      prd: title + " · 图文 PRD" + suffix,
      html: title + " · 交互 HTML" + suffix,
    },
  });
  if (output.prd)
    children.find((c) => c.type === "文档").html = documentBody(output.prd);
  if (output.runId)
    for (const child of children) child.origin.runId = output.runId;
  docs.push(...children);
  d.lastOutputVersion = version;
  return children;
}
