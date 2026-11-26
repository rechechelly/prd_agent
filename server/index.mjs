import { modelRoute } from "./models/routes.mjs";
import { profiles, modelConfig } from "./models/providers.mjs";
import { complete } from "./models/client.mjs";
import { completionMessages } from "./agent/prompts.mjs";
import { agentHistory } from "./agent-history.mjs";
import { agentStream } from "./agent-stream.mjs";
import {
  installSkill,
  removeSkill,
  skillPackage,
  migrateWritingRule,
} from "./skills.mjs";
import { findDelivery as findOutput } from "../src/workspace-files.mjs";
import {
  createFileShare,
  lookupFileShare,
  updateFileShares,
} from "./file-shares.mjs";
import { imageAttachment, uploadAttachment } from "./attachments.mjs";
import http from "node:http";
import fs from "node:fs/promises";
import { recordWorkspaceFiles } from "./delivery.mjs";
import { db, session, login, token, fault } from "./storage.mjs";
import {
  generationRuns,
  pendingDelivery,
  acknowledgeDeliveries,
} from "./generation-log.mjs";
import { runAgent, pauseAgent, agentCatalog } from "./agent.mjs";
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
  const share = db
    .prepare("SELECT token FROM shares WHERE doc=? AND version=?")
    .get(doc, version);
  if (share) notify(share.token);
  const file = db
    .prepare(
      "SELECT token FROM file_shares WHERE doc=? AND version=? AND file='prd'",
    )
    .get(doc, version);
  if (version === 0) {
    const plain = db
      .prepare(
        "SELECT token FROM file_shares WHERE doc=? AND version=0 AND file='document'",
      )
      .get(doc);
    if (plain) notify(plain.token);
  }
  if (file) notify(file.token);
}
function saveWorkspace(input) {
  const w = input.data;
  if (!Array.isArray(w?.docs) || !Array.isArray(w.folders))
    fault("工作区数据不完整");
  const current = row(),
    revision = current?.revision || 0;
  if (input.revision !== revision)
    fault("其他窗口已保存新版，请先保留本窗口修改，再刷新载入最新版本", 409);
  const changed = [];
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("INSERT OR REPLACE INTO state VALUES(1,?,?)").run(
      revision + 1,
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
    for (const s of db.prepare("SELECT token,doc,version FROM shares").all()) {
      const a = find(s.doc, s.version);
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
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  changed.forEach(notify);
  return { revision: revision + 1 };
}
const server = http.createServer(async (req, res) => {
  let live;
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
      const shared = lookupFileShare(key, filesOf(workspace()));
      if (shared) {
        const { ref, data } = shared;
        if (kind === "s" && method === "GET" && !action)
          return send(
            res,
            data.kind === "board" ? await fs.readFile(homepage) : sharePage,
            200,
            "text/html",
          );
        if (kind !== "api/public") fault("无此页面", 404);
        if (method === "GET" && action === "events")
          return stream(req, res, key);
        if (method === "GET" && !action)
          return send(res, {
            ...data,
            comments:
              ref.file === "prd" || data.kind === "document"
                ? listComments(ref.doc, ref.version)
                : [],
          });
        if (
          method === "POST" &&
          action === "comments" &&
          (ref.file === "prd" || data.kind === "document")
        ) {
          throttle("comment:" + req.socket.remoteAddress, 35, 60000);
          const input = await body(req);
          if (!lookupFileShare(key, filesOf(workspace())))
            fault("链接不存在", 404);
          addComment(ref.doc, ref.version, input);
          notifyComments(ref.doc, ref.version);
          return send(res, { ok: true });
        }
        fault("无此页面", 404);
      }
      const item = db
        .prepare(
          "SELECT doc,version,title,html,prd,revision FROM shares WHERE token=?",
        )
        .get(key);
      if (!item) fault("链接不存在", 404);
      if (kind === "s" && method === "GET" && !action)
        return send(res, sharePage, 200, "text/html");
      if (kind === "api/public" && method === "GET" && action === "events")
        return stream(req, res, key);
      if (kind === "api/public" && method === "GET" && !action)
        return send(res, {
          title: item.title,
          ...(item.html && item.prd
            ? { html: item.html, prd: item.prd }
            : {
                kind: item.html ? "html" : "prd",
                content: item.html || item.prd,
              }),
          revision: item.revision,
          comments: listComments(item.doc, item.version),
        });
      if (kind === "api/public" && method === "POST" && action === "comments") {
        throttle("comment:" + req.socket.remoteAddress, 35, 60000);
        const b = await body(req);
        if (
          !db.prepare("SELECT 1 FROM shares WHERE token=? AND prd!=''").get(key)
        )
          fault("链接不存在", 404);
        addComment(item.doc, item.version, b);
        notifyComments(item.doc, item.version);
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
      const b = await body(req),
        w = row();
      if (b.file !== undefined || b.version === undefined) {
        const ref = {
          doc: b.doc,
          version: b.version ?? 0,
          file: b.file ?? "document",
        };
        if (typeof ref.doc !== "string" || !Number.isSafeInteger(ref.version))
          fault("文件标识无效");
        const key = createFileShare(filesOf(workspace()), ref);
        return send(res, { url: origin + "/s/" + key, token: key });
      }
      const a = w && findOutput(JSON.parse(w.body).docs, b.doc, b.version);
      if (!a?.html || !a?.prd) fault("先生成并保存两份交付文件");
      let existing = db
        .prepare("SELECT token FROM shares WHERE doc=? AND version=?")
        .get(b.doc, b.version);
      if (!existing && b.lookup) return send(res, { url: null });
      if (!existing) {
        const key = token();
        db.prepare(
          "INSERT INTO shares(token,doc,version,title,html,prd) VALUES(?,?,?,?,?,?)",
        ).run(key, b.doc, b.version, a.title, a.html, a.prd);
        existing = { token: key };
      }
      return send(res, {
        url: origin + "/s/" + existing.token,
        token: existing.token,
        comments: listComments(b.doc, b.version),
      });
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
    if (p === "/api/agent/history" && method === "GET") {
      const file = filesOf(workspace()).find(
        (f) => f.id === url.searchParams.get("doc"),
      );
      const chatId = url.searchParams.get("chatId");
      if (
        !file ||
        !(file.chatSessions || [{ id: "legacy" }]).some((s) => s.id === chatId)
      )
        fault("会话不存在", 404);
      const id =
        file.origin?.file === "prd"
          ? JSON.stringify(["prd", file.origin.doc, file.origin.version])
          : file.id;
      return send(res, agentHistory(id, chatId, url.searchParams.get("tool")));
    }
    if ((p === "/api/agent" || p === "/api/agent/pause") && method === "POST") {
      const b = await body(req);
      // Active clients describe external requests in chat. Paused pre-1.0.1 turns
      // can still recover their original task-scoped credential from the bookmark.
      delete b.externalApi;
      const w = JSON.parse(row()?.body || "{}"),
        doc = filesOf(w).find((d) => d.id === b.doc);
      if (!doc) fault("文档不存在", 404);
      if (p === "/api/agent" && !["chat", "complete"].includes(b.mode))
        fault("请通过 Agent 对话创建文件");
      if (p === "/api/agent" && b.mode === "complete")
        return send(res, {
          text: await complete(
            modelConfig("completion", b.modelId),
            completionMessages(doc.title, b.before),
            160,
          ),
        });
      let target =
          doc.origin?.file === "prd"
            ? {
                ...doc,
                id: JSON.stringify(["prd", doc.origin.doc, doc.origin.version]),
              }
            : doc,
        file = doc;
      if (b.prdVersion !== undefined) {
        const output = findOutput(w.docs, doc.id, b.prdVersion);
        if (!output?.prd) fault("未找到指定版本的图文 PRD", 404);
        file = output;
        target = {
          id: JSON.stringify(["prd", doc.id, b.prdVersion]),
          title: doc.title + " / v" + b.prdVersion + " / 图文 PRD",
          html: output.prd,
        };
      }
      const session = file.chatSessions?.find((s) => s.id === b.chatId);
      if (b.chatId !== undefined && !session)
        fault("会话不存在，请刷新工作区", 409);
      if (p === "/api/agent/pause")
        return send(res, await pauseAgent(target.id, b.chatId, b.attemptId));
      if (
        b.editIndex !== undefined &&
        (!session ||
          !Number.isSafeInteger(b.editIndex) ||
          b.editIndex < 0 ||
          b.editIndex >= session.messages.length)
      )
        fault("要编辑的消息不存在", 409);
      if (req.headers.accept === "application/x-ndjson")
        live = agentStream(res);
      const completeChat = (result) =>
        live ? live.end("result", result) : send(res, result);
      const out = await runAgent(
        {
          doc: target,
          ownerId: doc.id,
          docs: filesOf(w),
          session,
        },
        b,
        modelConfig("agent", b.modelId),
        live,
      );
      if (out.status === "paused") return completeChat(out);
      if (out.workspaceFiles) {
        const { workspaceFiles, workspaceChanges, ...chat } = out;
        const delivery = recordWorkspaceFiles(
          doc.id,
          workspaceFiles,
          workspaceChanges,
          b.question,
        );
        const summary = [];
        if (delivery.files.length)
          summary.push(
            "已创建 " + delivery.files.map((f) => f.title).join("、"),
          );
        if (delivery.changes.length)
          summary.push(
            "已处理 " +
              delivery.changes.length +
              " 个文件的修改，正文和画布修改可在对应文件中预览",
          );
        return completeChat({
          ...chat,
          ...(chat.proposed != null && { base: chat.base ?? target.html }),
          answer: summary.join("。") + "。",
          delivery,
        });
      }
      return completeChat(
        out.proposed != null ? { ...out, base: out.base ?? target.html } : out,
      );
    }
    fault("无此页面", 404);
  } catch (e) {
    if (live)
      return live.end("error", {
        error: e.status ? e.message : "服务执行失败，请检查服务状态后重试",
      });
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
