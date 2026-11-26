import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { db, fault } from "../storage.mjs";

db.exec(
  "CREATE TABLE IF NOT EXISTS chat_attachments(id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL)",
);
db.exec(
  "CREATE TABLE IF NOT EXISTS chat_images(id TEXT PRIMARY KEY, title TEXT NOT NULL, mime TEXT NOT NULL, bytes BLOB NOT NULL)",
);
export function imageAttachment(id, metadataOnly = false) {
  if (typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id))
    fault("图片引用无效");
  const image = db
    .prepare(
      metadataOnly
        ? "SELECT title,mime FROM chat_images WHERE id=?"
        : "SELECT title,mime,bytes FROM chat_images WHERE id=?",
    )
    .get(id);
  if (!image) fault("找不到这张图片，请重新粘贴", 404);
  return image;
}
function imageMime(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")))
    return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6)))
    return "image/gif";
  if (
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  )
    return "image/webp";
}
export function attachment(id) {
  if (typeof id !== "string") fault("附件引用无效");
  const item = db
    .prepare("SELECT title,content FROM chat_attachments WHERE id=?")
    .get(id);
  if (!item) fault("找不到此附件，请重新上传", 404);
  return item;
}
async function extract(ext, bytes) {
  const child = fork(new URL("./attachment-parser.mjs", import.meta.url), [], {
    serialization: "advanced",
    execArgv: ["--max-old-space-size=384"],
    env: {},
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 45000);
      child.once("exit", () => {
        clearTimeout(timer);
        reject(Error("附件解析中断或超时，请拆分文件后重试。"));
      });
      child.once("error", reject);
      child.once("message", (msg) =>
        msg.error ? reject(Error(msg.error)) : resolve(msg.text),
      );
      child.send({ ext, bytes }, (err) => {
        if (err) reject(err);
      });
    });
  } catch (e) {
    fault(e.message, 422);
  } finally {
    child.kill();
  }
}
export async function uploadAttachment(req, title) {
  const image =
    req.headers["content-type"]?.startsWith("image/") ||
    /\.(png|jpe?g|webp|gif)$/i.test(title);
  if (
    !title ||
    title.length > 255 ||
    (!image && !/\.(pdf|docx?|xlsx?)$/i.test(title))
  )
    fault("支持 PNG、JPEG、WebP、GIF 图片及 PDF、Word、Excel 文件", 415);
  const parts = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 20 * 1024 * 1024) fault("每个附件最多 20 MB", 413);
    parts.push(chunk);
  }
  if (!size) fault("文件为空");
  const bytes = Buffer.concat(parts);
  const id = createHash("sha256")
    .update(title)
    .update("\0")
    .update(bytes)
    .digest("hex");
  if (image) {
    const mime = imageMime(bytes);
    if (!mime) fault("无法识别图片，请粘贴 PNG、JPEG、WebP 或 GIF 图片", 415);
    db.prepare(
      "INSERT OR IGNORE INTO chat_images(id,title,mime,bytes) VALUES(?,?,?,?)",
    ).run(id, title, mime, bytes);
    return { kind: "image", id, title };
  }
  if (!db.prepare("SELECT 1 FROM chat_attachments WHERE id=?").get(id)) {
    const text = await extract(title.split(".").at(-1).toLowerCase(), bytes);
    db.prepare("INSERT OR IGNORE INTO chat_attachments VALUES(?,?,?)").run(
      id,
      title,
      text,
    );
  }
  return { kind: "upload", id, title };
}
