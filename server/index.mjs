import { modelRoute } from "./models/routes.mjs";
import { profiles } from "./models/providers.mjs";
import { agentRoute } from "./agent/routes.mjs";
import {
  installSkill,
  removeSkill,
  skillPackage,
  migrateWritingRule,
} from "./skills.mjs";
import { findDelivery as findOutput, storedDocumentType } from "../shared/workspace-files.mjs";
import {
  fileShareState,
  lookupShare,
  legacyShareToken,
  shareTokens,
  updateFileShares,
} from "./sharing/files.mjs";
import { imageAttachment, uploadAttachment } from "./attachments/attachments.mjs";
import http from "node:http";
import fs from "node:fs/promises";
import { db, session, login, fault, transaction } from "./storage.mjs";
import {
  generationRuns,
  pendingDelivery,
  acknowledgeDeliveries,
} from "./workspace/generation-log.mjs";
import { agentCatalog } from "./agent/tools.mjs";
import { sharePage, loginPage } from "./pages.mjs";
import { listComments, addComment, pruneComments } from "./prd-comments.mjs";
import { serveStaticDelivery } from "./static-delivery.mjs";
const homepage = new URL("../叙页产品需求工作台.html", import.meta.url),
  clients = new Map(),
  limits = new Map();
const port = Number(process.env.PORT || 4317),
  host = process.env.HOST || "127.0.0.1";
const origin =
  process.env.XUYE_ORIGIN?.replace(/\/+$/, "") ||
  "http://" + (host === "0.0.0.0" ? "localhost" : host) + ":" + port;
const cookiePath = new URL(origin).pathname.replace(/\/+$/, "") + "/";
const secure = origin.startsWith("https:") ? "; Secure" : "";
function throttle(id, count, window) {
  const now = Date.now();
  let entry = limits.get(id);
  if (!entry || entry.end < now) {
    entry = { n: 0, end: now + window };
    limits.set(id, entry);
  }
  if (++entry.n > count) fault("请求太频繁，请稍后重试", 429);
}
setInterval(() => {
  for (const [k, v] of limits) if (v.end < Date.now()) limits.delete(k);
}, 60000).unref();
function send(res, data, status = 200, mime = "application/json") {
  res.writeHead(status, { "Content-Type": mime + "; charset=utf-8" });
  res.end(mime === "application/json" ? JSON.stringify(data) : data);
}
async function body(req) {
  if (!req.headers["content-type"]?.startsWith("application/json"))
    fault("需要 JSON 请求", 415);
  let n = 0;
  const chunks = [];
  for await (const chunk of req) {
    n += chunk.length;
    if (n > 50e6) fault("工作区超出单次保存大小", 413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks));
  } catch {
    fault("请求格式不正确");
  }
}
function notify(token) {
  for (const r of clients.get(token) || []) r.write("data: changed\n\n");
}
function notifyShare(key, docs) {
  const subscribers = clients.get(key);
  if (!subscribers?.size) return;
  if (lookupShare(key, docs)) notify(key);
  else for (const response of subscribers) response.end("data: changed\n\n");
}
function stream(req, res, key) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "x-accel-buffering": "no",
  });
  res.write(": connected\n\n");
  if (!clients.has(key)) clients.set(key, new Set());
  clients.get(key).add(res);
  const timer = setInterval(() => res.write(": keepalive\n\n"), 20000);
  res.on("close", () => {
    clearInterval(timer);
    clients.get(key)?.delete(res);
    if (!clients.get(key)?.size) clients.delete(key);
  });
}
const row = () => db.prepare("SELECT * FROM state WHERE id=1").get();
const filesOf = (w) => [
  ...(w?.docs || []),
  ...(w?.folders || []).map((f) => ({ ...f, type: "文件夹" })),
];
const workspace = () => JSON.parse(row()?.body || "{}");
const commentsKey = (doc, version) => "comments:" + doc + ":" + version;
function notifyComments(doc, version) {
  notify(commentsKey(doc, version));
  for (const key of shareTokens(filesOf(workspace()), { doc, version, file: "prd" })) notify(key);
}
function saveWorkspace(input) {
  const w = input.data;
  if (!Array.isArray(w?.docs) || !Array.isArray(w.folders))
    fault("工作区数据不完整");
  const changed = [];
  const revision = transaction(() => {
    const current = row();
    const previous = current?.revision || 0;
    if (input.revision !== previous)
      fault("其他窗口已保存新版，请先保留本窗口修改，再刷新载入最新版本", 409);
    for (const file of w.docs) {
      const type = file && typeof file === "object" && !Array.isArray(file) && storedDocumentType(file.type);
      if (!type) fault("在线文件类型仅支持文档、原型画布和 HTML，文件夹请保存到文件夹列表");
      file.type = type;
    }
    for (const folder of w.folders) {
      if (!folder || typeof folder !== "object" || Array.isArray(folder) ||
          (folder.type != null && folder.type !== "文件夹")) fault("文件夹类型无效");
      folder.type = "文件夹";
    }
    db.prepare("INSERT OR REPLACE INTO state VALUES(1,?,?)").run(
      previous + 1,
      JSON.stringify(w),
    );
    const find = (id, version) => findOutput(w.docs, id, version);
    updateFileShares(
      current ? filesOf(JSON.parse(current.body)) : [],
      filesOf(w),
      changed,
    );
    acknowledgeDeliveries(filesOf(w));
    pruneComments(find);
    return previous + 1;
  });
  const docs = filesOf(w);
  changed.forEach(key => notifyShare(key, docs));
  return { revision };
}
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost"),
      p = url.pathname,
      method = req.method;
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    if (!["GET", "POST"].includes(method)) fault("不支持此方法", 405);
    if (
      method === "POST" &&
      req.headers.origin &&
      req.headers.origin !== new URL(origin).origin
    )
      fault("来源与工作区地址不一致", 403);
    if (method === "GET" && p.startsWith("/deliveries/")) {
      if (await serveStaticDelivery(p, res)) return;
      fault("交付文件不存在", 404);
    }
    const auth = session(req.headers.cookie);
    if (p === "/" && method === "GET")
      return send(
        res,
        auth ? await fs.readFile(homepage) : loginPage,
        200,
        "text/html",
      );
    if (p === "/api/login" && method === "POST") {
      throttle("login:" + req.socket.remoteAddress, 18, 5 * 60000);
      const b = await body(req);
      const s = login(b.username, b.password, !!b.remember);
      res.setHeader(
        "Set-Cookie",
        "xuye=" +
          s.id +
          "; Path=" +
          cookiePath +
          "; HttpOnly; SameSite=Strict" +
          secure +
          (b.remember ? "; Max-Age=" + s.seconds : ""),
      );
      return send(res, { ok: true });
    }
    const pub = p.match(
      /^\/(s|api\/public)\/([\w-]{43})(?:\/(comments|events))?$/,
    );
    if (pub) {
      const [, kind, key, action] = pub;
      const shared = lookupShare(key, filesOf(workspace()));
      if (!shared) fault("链接不存在", 404);
      const { ref, data, canComment } = shared;
      if (kind === "s" && method === "GET" && !action)
        return send(res, data.kind === "board" ? await fs.readFile(homepage) : sharePage, 200, "text/html");
      if (kind !== "api/public") fault("无此页面", 404);
      if (method === "GET" && action === "events") return stream(req, res, key);
      if (method === "GET" && !action)
        return send(res, { ...data, comments: canComment ? listComments(ref.doc, ref.version) : [] });
      if (method === "POST" && action === "comments" && canComment) {
        throttle("comment:" + req.socket.remoteAddress, 35, 60000);
        const input = await body(req);
        if (!lookupShare(key, filesOf(workspace()))?.canComment) fault("链接不存在", 404);
        addComment(ref.doc, ref.version, input);
        notifyComments(ref.doc, ref.version);
        return send(res, { ok: true });
      }
      fault("无此页面", 404);
    }
    if (!auth) fault("请登录后再继续", 401);
    const imageRoute = /^\/api\/attachments\/([a-f0-9]{64})$/.exec(p);
    if (imageRoute && method === "GET") {
      const image = imageAttachment(imageRoute[1]);
      res.writeHead(200, { "Content-Type": image.mime });
      return res.end(image.bytes);
    }
    if (p === "/api/attachments" && method === "POST")
      return send(
        res,
        await uploadAttachment(req, url.searchParams.get("name")),
      );
    if (p === "/api/logout" && method === "POST") {
      db.prepare("DELETE FROM sessions WHERE token=?").run(auth);
      res.setHeader(
        "Set-Cookie",
        "xuye=; Path=" +
          cookiePath +
          "; HttpOnly; SameSite=Strict; Max-Age=0" +
          secure,
      );
      return send(res, { ok: true });
    }
    if (p === "/api/workspace") {
      if (method === "GET") {
        const w = row();
        return send(res, {
          revision: w?.revision || 0,
          data: w ? JSON.parse(w.body) : null,
          ...profiles(),
        });
      }
      return send(res, saveWorkspace(await body(req)));
    }
    if (p === "/api/prd-comments" || p === "/api/prd-comments/events") {
      const id = url.searchParams.get("doc"),
        version = Number(url.searchParams.get("version"));
      const input = method === "POST" ? await body(req) : null;
      if (!findOutput(workspace().docs, id, version)?.prd)
        fault("PRD 不存在", 404);
      if (p.endsWith("/events") && method === "GET")
        return stream(req, res, commentsKey(id, version));
      if (p.endsWith("/events")) fault("无此页面", 404);
      if (method === "GET")
        return send(res, { comments: listComments(id, version) });
      addComment(id, version, input, "产品经理");
      notifyComments(id, version);
      return send(res, { ok: true });
    }
    if (p === "/api/skills/import" && method === "POST")
      return send(res, installSkill(await body(req)));
    if (p === "/api/skills/delete" && method === "POST")
      return send(res, removeSkill(await body(req)));
    if (p === "/api/skills/export" && method === "GET") {
      const name = url.searchParams.get("name");
      const files = skillPackage(name);
      const {
        default: { CFB },
      } = await import("xlsx");
      const zip = CFB.utils.cfb_new();
      for (const file of files)
        CFB.utils.cfb_add(zip, name + "/" + file.path, file.data);
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="' + name + '.zip"',
      );
      res.setHeader("Content-Type", "application/zip");
      return res.end(
        CFB.write(zip, { type: "buffer", fileType: "zip", compression: true }),
      );
    }
    if (p === "/api/agent-catalog" && method === "GET")
      return send(res, agentCatalog());
    if (
      p === "/api/models" ||
      p.startsWith("/api/models/") ||
      p.startsWith("/api/providers/")
    )
      return send(res, await modelRoute(p, method, () => body(req)));
    if (p === "/api/share" && method === "POST") {
      const b = await body(req);
      const docs = filesOf(workspace());
      const ref = { doc: b.doc, version: b.version ?? 0, file: b.file ?? "document" };
      if (typeof ref.doc !== "string" || !Number.isSafeInteger(ref.version)) fault("文件标识无效");
      if (b.enabled !== undefined && typeof b.enabled !== "boolean") fault("分享状态无效");
      let key;
      const legacy = b.file === undefined && ref.version > 0;
      if (legacy) {
        if (b.enabled !== undefined) fault("切换分享状态时请指定 prd 或 html 文件");
        key = legacyShareToken(docs, ref.doc, ref.version, b.lookup);
      } else {
        key = fileShareState(docs, ref, b.lookup ? undefined : (b.enabled ?? true));
        if (!b.lookup) for (const link of shareTokens(docs, ref)) notifyShare(link, docs);
      }
      return send(res, { enabled: !!key, token: key, url: key ? origin + "/s/" + key : null,
        ...(legacy && key && { comments: listComments(ref.doc, ref.version) }) });
    }
    if (p === "/api/pending-delivery" && method === "GET") {
      const id = url.searchParams.get("doc");
      const pair =
        filesOf(workspace()).some((f) => f.id === id) &&
        pendingDelivery(url.searchParams.get("run"), id);
      if (!pair) fault("没有待恢复的生成文件", 404);
      return send(res, pair);
    }
    if (p === "/api/generation-runs" && method === "GET") {
      const id = url.searchParams.get("doc");
      if (!filesOf(workspace()).some((d) => d.id === id))
        fault("文档不存在", 404);
      return send(res, { runs: generationRuns(id) });
    }
    if (p === "/api/agent" || p.startsWith("/api/agent/")) {
      const input = method === "POST" ? await body(req) : undefined;
      const result = await agentRoute(url, req, res, filesOf(workspace()), input);
      if (!res.writableEnded && !res.destroyed) send(res, result);
      return;
    }
    fault("无此页面", 404);
  } catch (e) {
    if (!res.headersSent)
      send(
        res,
        { error: e.status ? e.message : "服务执行失败，请检查服务状态后重试" },
        e.status || 500,
      );
    else res.end();
  }
});
migrateWritingRule();
server.listen(port, host, () => console.log("叙页工作台 " + origin));
