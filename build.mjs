import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const esbuild = require("esbuild");
const modules = path.dirname(
  path.dirname(require.resolve("react/package.json")),
);
const dist = path.join(modules, "@excalidraw/excalidraw/dist/prod");
const bundle = await esbuild.build({
  entryPoints: ["src/main.js"],
  outfile: "app.js",
  bundle: true,
  minify: true,
  write: false,
  format: "iife",
  target: "es2022",
  conditions: ["production"],
  nodePaths: [modules],
  define: {
    "process.env.NODE_ENV": '"production"',
    "import.meta.url": "location.href",
  },
  metafile: true,
  legalComments: "inline",
  loader: {
    ".woff2": "dataurl",
    ".woff": "dataurl",
    ".ttf": "dataurl",
  },
  logLevel: "warning",
});
const js = bundle.outputFiles.find((f) => f.path.endsWith(".js")).text;
const css =
  fs
    .readFileSync(path.join(dist, "index.css"), "utf8")
    .replace(
      /url\("(\.\/fonts\/[^"]+)"\)/g,
      (_, f) =>
        "url(data:font/woff2;base64," +
        fs.readFileSync(path.join(dist, f)).toString("base64") +
        ")",
    ) +
  "\n" +
  bundle.outputFiles.find((f) => f.path.endsWith(".css")).text;
const licenses = new Map();
for (const name of Object.keys(bundle.metafile.inputs)) {
  let dir = path.dirname(path.resolve(name));
  while (
    dir.includes("node_modules") &&
    !fs.existsSync(path.join(dir, "package.json"))
  )
    dir = path.dirname(dir);
  if (!dir.includes("node_modules") || licenses.has(dir)) continue;
  const files = fs
    .readdirSync(dir)
    .filter(
      (f) =>
        /^(license|licence|copying)([.-].*)?$/i.test(f) &&
        fs.statSync(path.join(dir, f)).isFile(),
    );
  if (files.length)
    licenses.set(
      dir,
      files.map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n"),
    );
}
const notices = Array.from(
  licenses,
  ([dir, license]) => path.basename(dir) + "\n" + license,
).join("\n\n");
const html = fs
  .readFileSync("src/shell.html", "utf8")
  .replace("/* APP_CSS */", () => css)
  .replace("/* APP_JS */", () => js.replace(/<\/script/gi, "<\\/script"))
  .replace(
    /<\/body>\s*<\/html>\s*$/,
    () =>
      '<script type="text/plain" id="third-party-notices">' +
      notices.replace(/<\/script/gi, "<\\/script") +
      "</script></body></html>",
  );
fs.writeFileSync("叙页产品需求工作台.html", html);
