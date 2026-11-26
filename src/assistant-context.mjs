import { boardType, findDelivery } from "./workspace-files.mjs";
import { describeCanvas } from "./canvas-model.mjs";
export const fileLabels = { html: "交互 HTML", prd: "图文 PRD" };
export const fileLabel = (output, key) =>
  output.fileNames?.[key] || fileLabels[key];
export const contextTransfer = "application/x-xuye-file";
export const fileKey = (ref) =>
  JSON.stringify([ref.id, ref.version ?? null, ref.file ?? null]);

export function resolveFile(docs, ref) {
  const doc = docs.find((d) => d.id === ref.id);
  if (!doc && !ref.file) return null;
  if (ref.file === undefined && ref.version === undefined)
    return {
      title: doc.title,
      content: boardType(doc.type)
        ? JSON.stringify(describeCanvas(doc.scene))
        : doc.html,
      type: doc.type,
    };
  if (!Object.hasOwn(fileLabels, ref.file)) return null;
  const output = findDelivery(docs, ref.id, ref.version);
  if (!output?.[ref.file]) return null;
  return {
    title:
      (doc?.title || output.title) +
      " / v" +
      output.version +
      " / " +
      fileLabel(output, ref.file),
    content: output[ref.file],
    type: fileLabels[ref.file],
  };
}
