import fs from "node:fs/promises";

const root = new URL("../public/deliveries/", import.meta.url);
const types = {
  "prototype.html": "text/html; charset=utf-8",
  "prd.html": "text/html; charset=utf-8",
  "preview.png": "image/png",
};
const htmlPolicy = [
  "sandbox allow-scripts allow-forms",
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src data:",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

export async function serveStaticDelivery(pathname, response) {
  const route = pathname.match(
    /^\/deliveries\/([a-z][a-z0-9-]{0,63})\/(v[1-9]\d{0,5})\/(prototype\.html|prd\.html|preview\.png)$/,
  );
  if (!route) return false;
  const [, project, version, file] = route;
  let content;
  try {
    content = await fs.readFile(
      new URL(project + "/" + version + "/" + file, root),
    );
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  response.setHeader("Content-Type", types[file]);
  if (file.endsWith(".html"))
    response.setHeader("Content-Security-Policy", htmlPolicy);
  response.end(content);
  return true;
}
