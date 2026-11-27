import { createHash } from "node:crypto";
import { fileKey, resolveFile } from "../../shared/assistant-context.mjs";
import { attachment, attachmentBytes, imageAttachment } from "../attachments/attachments.mjs";
import { fault } from "../storage.mjs";
export function maskImages(html, images = []) {
  return {
    html: html.replace(/data:image\/[\w.+-]+;base64,[a-z\d+/=]+/gi, (s) => {
      images.push(s);
      return "xuye-asset-" + images.length;
    }),
    images,
  };
}
export function prepareReferences(docs, refs, files, scope) {
  if (!Array.isArray(refs)) fault("引用格式有误");
  const list = [],
    pictures = [],
    seen = new Set(),
    assets = new Map();
  // Keep the initial message small. All selected sources remain readable in full.
  let remaining = 16000,
    pictureBytes = 0;
  for (const ref of refs) {
    if (!ref || typeof ref !== "object") fault("引用格式有误");
    let title, content, file, originalFile;
    if (ref.kind === "range") {
      if (ref.historyOnly || !scope) continue;
      file = "selection-target.html";
      files[file] = scope.fragment;
      list.push({ title: ref.title, fileId: ref.id, start: ref.start, end: ref.end, unit: "UTF-16，原始源码，左闭右开",
        file, text: ref.text.slice(0, 2000), fragment: scope.fragment.slice(0, 4000) });
      continue;
    }
    if (ref.kind === "image") {
      const key = "upload-" + ref.id;
      if (seen.has(key)) continue;
      seen.add(key);
      const image = imageAttachment(ref.id, ref.historyOnly);
      file = key + "." + image.mime.split("/")[1];
      list.push({
        title: image.title,
        file,
        ...(ref.historyOnly && { historyOnly: true }),
      });
      if (ref.historyOnly) {
        files[file] = () => imageAttachment(ref.id).bytes;
        continue;
      }
      pictureBytes += image.bytes.length;
      if (pictureBytes > 20 * 1024 * 1024)
        fault("本次提问的图片合计超过 20 MB，请分次发送。", 413);
      files[file] = Buffer.from(image.bytes);
      pictures.push({
        type: "image",
        mimeType: image.mime,
        data: files[file].toString("base64"),
      });
      continue;
    }
    if (ref.kind === "upload") {
      const key = "upload-" + ref.id;
      if (seen.has(key)) continue;
      seen.add(key);
      const item = attachment(ref.id);
      ({ title, content } = item);
      if (item.hasOriginal) {
        originalFile = key + "." + title.split(".").at(-1).toLowerCase();
        files[originalFile] = () => attachmentBytes(ref.id);
      }
      file = key + ".txt";
    } else if (ref.kind === "file") {
      const source = resolveFile(docs, ref);
      if (!source) fault("引用的文件已删除，请移除引用后重试", 409);
      const key = fileKey(ref);
      if (seen.has(key)) continue;
      seen.add(key);
      title = source.title;
      const stem =
        "xuye-ref-" +
        createHash("sha256").update(key).digest("hex").slice(0, 20);
      let i = 0;
      const imageFiles = [];
      content = (source.content || "").replace(
        /data:image\/([\w.+-]+);base64,([a-z\d+/=]+)/gi,
        (url, mime, data) => {
          const image = stem + "-" + ++i + "." + mime.toLowerCase();
          imageFiles.push(image);
          files[image] = Buffer.from(data, "base64");
          assets.set(image, url);
          return image;
        },
      );
      const reader = { id: ref.id, ...(ref.version !== undefined && { version: ref.version, file: ref.file }) };
      const reference = { title, read_online_file: reader };
      if (imageFiles.length) reference.imageFiles = imageFiles;
      if (!ref.historyOnly && content.length <= remaining) {
        reference.content = content;
        remaining -= content.length;
      }
      list.push(reference);
      continue;
    } else {
      if (typeof ref.text !== "string") fault("选区引用缺少正文");
      title = String(ref.title || "选区");
      content = ref.text.slice(0, 12000);
      file = "selection-" + (list.length + 1) + ".txt";
    }
    files[file] = content;
    const reference = { title, file, ...(originalFile && { originalFile }) };
    if (!ref.historyOnly && content.length <= remaining) {
      reference.content = content;
      remaining -= content.length;
    }
    list.push(reference);
  }
  return { list, assets, pictures };
}
