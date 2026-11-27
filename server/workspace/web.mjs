import { createReadStream, readFileSync, existsSync } from "node:fs";
import { loginPage, sharePage } from "../pages.mjs";

const root = new URL("../../.web/", import.meta.url);
const shell = readFileSync(new URL("index.html", root), "utf8");
const escape = s => s.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
export function filePage(base, kind, shareToken) {
  const page = kind === "login" ? loginPage : kind === "review" ? sharePage : shell;
  const context = '<base href="' + escape(base) + '">' +
    (shareToken ? '<meta name="public-token" content="' + escape(shareToken) + '">' : '');
  return page.replace(/<meta charset=/i, () => context + "<meta charset=");
}
export function serveAsset(name, req, res) {
  if (!/^\/assets\/[a-f0-9]{16}\.(js|css)$/.test(name)) return false;
  const compressed = /\bgzip\b/.test(req.headers["accept-encoding"] || "");
  const file = new URL(name.slice(8) + (compressed ? ".gz" : ""), root);
  if (!existsSync(file)) return false;
  res.writeHead(200, { "Content-Type": name.endsWith(".js") ? "application/javascript" : "text/css",
    "Cache-Control": "public, max-age=31536000, immutable", Vary: "Accept-Encoding",
    ...(compressed && { "Content-Encoding": "gzip" }) });
  createReadStream(file).on("error", () => res.destroy()).pipe(res);
  return true;
}
