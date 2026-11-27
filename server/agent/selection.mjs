import { createHash } from "node:crypto";
import { fault } from "../storage.mjs";
import { maskImages } from "./context.mjs";
import { editOnlineFileBody } from "../../shared/online-file-edit.mjs";

// Boundaries are immutable during one submission. A changed or stale range must never
// fall back to searching the file for the same words.
export function selectionScope(refs, ownerId, doc) {
  const ranges = (refs || []).filter(ref => ref?.kind === "range");
  if (!ranges.length) return;
  const [{ id, start, end, digest }] = ranges;
  const source = doc.html || "";
  if (ranges.length !== 1 || typeof ranges[0].text !== "string" || id !== ownerId || !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) || start < 0 || end <= start || end > source.length ||
      digest !== createHash("sha256").update(source).digest("hex"))
    fault("选区来源或正文已变化，请重新划词后发送。", 409);
  const prefix = maskImages(source.slice(0, start));
  const fragment = maskImages(source.slice(start, end), prefix.images).html;
  const suffix = maskImages(source.slice(end), prefix.images).html;
  if (prefix.html + fragment + suffix !== maskImages(source).html)
    fault("选区跨越内嵌图片数据，请选择文字或完整的图片标签。");
  function read(html) {
    if (html.length < prefix.html.length + suffix.length || !html.startsWith(prefix.html) || !html.endsWith(suffix))
      throw Error("选区外的内容已有变更，请重新选择。");
    return html.slice(prefix.html.length, html.length - suffix.length);
  }
  return {
    fragment, read,
    replace(html, replacement) {
      const before = read(html);
      if (doc.type !== "交互 HTML") {
        // Preserve inline marks and block boundaries at both ends of a rich-text selection.
        const markup = /<!--[^]*?-->|<\/?[a-z][^>]*>/gi;
        const tags = before.match(markup) || [];
        const after = replacement.match(markup) || [];
        if (tags.length && !after.length) replacement += tags.join("");
        else if (JSON.stringify(tags) !== JSON.stringify(after))
          throw Error("请保留选区片段中的全部 HTML 标签和顺序，仅修改文字。");
      }
      return editOnlineFileBody(ownerId, html, [{
        range: { fileId: id, from: prefix.html.length, to: html.length - suffix.length }, content: replacement,
      }]);
    },
  };
}
