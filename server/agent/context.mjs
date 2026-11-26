import { createHash } from "node:crypto";
import { fileKey, resolveFile } from "../../src/assistant-context.mjs";
import { attachment, imageAttachment } from "../attachments.mjs";
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
export function prepareReferences(docs, refs, files) {
  if (!Array.isArray(refs)) fault("引用格式有误");
  const list = [],
    pictures = [],
    olderImages = new Map(),
    seen = new Set(),
    assets = new Map();
  // Keep the initial message small. All selected sources remain readable in full.
  let remaining = 16000,
    pictureBytes = 0;
  for (const ref of refs) {
    if (!ref || typeof ref !== "object") fault("引用格式有误");
    let title, content, file;
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
        olderImages.set(file, ref.id);
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
      ({ title, content } = attachment(ref.id));
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
      file = stem + ".html";
      let i = 0;
      content = source.content.replace(
        /data:image\/([\w.+-]+);base64,([a-z\d+/=]+)/gi,
        (url, mime, data) => {
          const image = stem + "-" + ++i + "." + mime.toLowerCase();
          files[image] = Buffer.from(data, "base64");
          assets.set(image, url);
          return image;
        },
      );
    } else {
      if (typeof ref.text !== "string") fault("选区引用缺少正文");
      title = String(ref.title || "选区");
      content = ref.text.slice(0, 12000);
      file = "selection-" + (list.length + 1) + ".txt";
    }
    files[file] = content;
    const reference = { title, file };
    if (!ref.historyOnly && content.length <= remaining) {
      reference.content = content;
      remaining -= content.length;
    }
    list.push(reference);
  }
  return { list, assets, pictures, olderImages };
}
