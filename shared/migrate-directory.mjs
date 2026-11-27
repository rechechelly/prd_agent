import { boardType, generatedFiles, storedDocumentType } from "./workspace-files.mjs";


export function lastVersion(d) {
  return Math.max(
    d.lastOutputVersion || 0,
    ...(d.outputs || []).map((a) => a.version),
  );
}

export function migrateDirectory(docs, folders) {
  let migrated = false;
  const groups = new Map();
  const locations = [...docs, ...folders];
  for (const owner of docs)
    for (const output of owner.outputs || []) {
      const key = owner.id + "-" + output.version;
      groups.set(key, output.location?.parent ?? owner.id);
      for (const file of ["html", "prd"].filter(key => output[key])) {
        const location = output.fileLocations?.[file];
        if (location) locations.push(location);
        else if (output.location) {
          (output.fileLocations ||= {})[file] = { ...output.location };
          locations.push(output.fileLocations[file]);
          migrated = true;
        }
      }
      if (output.location) {
        delete output.location;
        migrated = true;
      }
    }
  for (const item of locations) {
    const seen = new Set();
    while (groups.has(item.parent) && !seen.has(item.parent)) {
      seen.add(item.parent);
      item.parent = groups.get(item.parent);
      migrated = true;
    }
  }
  for (const source of [...docs]) {
    if (
      boardType(source.type) ||
      (!source.scene && !source.files && !source.view)
    )
      continue;
    const board = {
      id: crypto.randomUUID(),
      title: source.title + " · 草图",
      type: "原型画布",
      parent: source.id,
      html: "",
    };
    for (const prop of ["scene", "files", "view"]) {
      if (prop in source) {
        board[prop] = source[prop];
        delete source[prop];
      }
    }
    docs.push(board);
    migrated = true;
  }
  for (const folder of folders)
    if (folder.type !== "文件夹") {
      folder.type = "文件夹";
      migrated = true;
    }
  for (const d of [...docs]) {
    if (d.outputs) {
      d.lastOutputVersion = lastVersion(d);
      for (const out of d.outputs) docs.push(...generatedFiles(d, out));
      delete d.outputs;
      migrated = true;
    }
    if (d.detachedSource) {
      docs.splice(docs.indexOf(d), 1);
      migrated = true;
      continue;
    }
    const type = storedDocumentType(d.type) ?? "文档";
    if (type !== d.type) {
      d.type = type;
      migrated = true;
    }
  }
  return migrated;
}
