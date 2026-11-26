import { describeCanvas } from "./canvas-model.mjs";

export const boardType = (type) => type === "画布" || type === "原型画布";
export const generatedId = (doc, version, file) =>
  doc + "-" + version + "-" + file;

export function generatedFiles(owner, output) {
  const keys = [...new Set([...(output.fileOrder || []), "prd", "html"])];
  return keys
    .filter((key) => ["prd", "html"].includes(key) && output[key])
    .map((key) => {
      const origin = { doc: owner.id, version: output.version, file: key };
      const isPrd = key === "prd";
      const file = {
        id: generatedId(owner.id, output.version, key),
        type: isPrd ? "文档" : "交互 HTML",
        title: output.fileNames?.[key] || (isPrd ? "图文 PRD" : "交互 HTML"),
        html: output[key],
        parent: owner.id,
        ...output.fileLocations?.[key],
        origin,
      };
      if (isPrd)
        for (const field of ["chatSessions", "selectedChat", "messages"])
          if (output[field] !== undefined) file[field] = output[field];
      return file;
    });
}

// Versions are still used by historical public URLs, comments and Pi conversations.
export function findDelivery(docs = [], id, version) {
  const owner = docs.find((d) => d.id === id);
  if (version === 0)
    return owner && !boardType(owner.type) && owner.type !== "交互 HTML"
      ? { prd: owner.html || "<p></p>", title: owner.title }
      : null;
  const previous = owner?.outputs?.find((o) => o.version === version);
  if (previous) return previous;
  const parts = docs.filter(
    (d) => d.origin?.doc === id && d.origin.version === version,
  );
  if (!parts.length) return null;
  const output = {
    title: owner?.title || parts[0].title,
    fileNames: {},
    version,
  };
  for (const file of parts) {
    output[file.origin.file] = file.html;
    output.fileNames[file.origin.file] = file.title;
  }
  return output;
}

const escape = (s) =>
  String(s ?? "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
export function folderContents(folder, files) {
  const seen = new Set([folder.id]),
    items = [];
  function visit(parent) {
    for (const file of files.filter((f) => f.parent === parent)) {
      if (seen.has(file.id)) continue;
      seen.add(file.id);
      items.push(file);
      visit(file.id);
    }
  }
  visit(folder.id);
  return items;
}
export function generationContent(file, files) {
  if (boardType(file.type))
    return (
      "<h1>" +
      escape(file.title) +
      "</h1><pre>" +
      escape(JSON.stringify(describeCanvas(file.scene))) +
      "</pre>"
    );
  if (file.type !== "文件夹") return file.html || "<p></p>";
  return (
    "<h1>" +
    escape(file.title) +
    "</h1>" +
    folderContents(file, files)
      .map(
        (child) =>
          "<h2>" +
          escape(child.title) +
          "</h2>" +
          (child.type === "文件夹"
            ? ""
            : boardType(child.type)
              ? generationContent(child, [])
              : child.html || ""),
      )
      .join("")
  );
}
export function folderListing(folder, files) {
  return (
    "<ul>" +
    folderContents(folder, files)
      .map((child) => "<li>" + escape(child.title) + "</li>")
      .join("") +
    "</ul>"
  );
}
