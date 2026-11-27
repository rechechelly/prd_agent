import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { directory, fault, db, setting, set } from "./storage.mjs";
import { parse } from "yaml";

const project = fileURLToPath(new URL("../", import.meta.url));
const managed = path.join(directory, "skills");
const validName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const escape = (s) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const frontmatter = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
function metadata(text, folder) {
  const header = frontmatter.exec(text);
  if (!header) throw Error("缺少 YAML frontmatter");
  const meta = parse(header[1]);
  const { name, description } = meta || {};
  if (
    typeof name !== "string" ||
    !validName.test(name) ||
    name.length > 64 ||
    name !== folder
  )
    throw Error("name 必须是与目录名相同的 kebab-case 名称（最多 64 字符）");
  if (
    typeof description !== "string" ||
    !description.trim() ||
    description.length > 1024
  )
    throw Error("description 缺失或超过 1024 字符");
  return meta;
}

export function discoverSkills() {
  const skills = new Map(),
    warnings = [];
  function register(dir) {
    if (
      path.dirname(dir) !== managed &&
      setting("skill-hidden:" + path.basename(dir))
    )
      return;
    const filename = path.join(dir, "SKILL.md");
    if (!fs.existsSync(filename)) return;
    try {
      if (!fs.lstatSync(filename).isFile()) throw Error("入口需要为普通文件");
      const text = fs.readFileSync(filename, "utf8").replace(/^\uFEFF/, "");
      const meta = metadata(text, path.basename(dir));
      const { name, description } = meta;
      if (skills.has(name)) {
        warnings.push(name + " 重名，已使用优先目录中的版本");
        return;
      }
      skills.set(name, {
        name,
        description: description.trim(),
        dir,
        file: "skills/" + name + "/SKILL.md",
        manual: meta["disable-model-invocation"] === true,
      });
    } catch (error) {
      warnings.push(path.basename(dir) + "：" + error.message);
    }
  }
  const roots = [
    managed,
    path.join(project, ".agents/skills"),
    path.join(project, "skills"),
    ...(process.env.XUYE_SKILL_DIRS || "")
      .split(path.delimiter)
      .filter(Boolean),
  ];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    if (!fs.statSync(root).isDirectory()) {
      warnings.push("技能搜索路径不是目录：" + root);
      continue;
    }
    for (const entry of fs
      .readdirSync(root, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) register(path.join(root, entry.name));
    }
  }

  return { skills, warnings };
}

export function skillRuntime(catalog, prior = []) {
  const previous = new Set(prior.filter((name) => catalog.skills.has(name)));
  const active = new Set();
  function contents(skill, rel) {
    const target = path.join(skill.dir, rel);
    if (!fs.existsSync(target)) return;
    const real = fs.realpathSync(target);
    if (
      !real.startsWith(fs.realpathSync(skill.dir) + path.sep) ||
      !fs.statSync(real).isFile()
    )
      return;
    return fs.readFileSync(real);
  }
  function load(name, { explicit = false } = {}) {
    const skill = catalog.skills.get(name);
    if (!skill || (skill.manual && !explicit))
      throw Error("技能不可自动加载或未安装：" + name);
    const source = contents(skill, "SKILL.md");
    if (!source) throw Error("技能入口不可读取：" + skill.file);
    const body = source
      .toString("utf8")
      .replace(/^\uFEFF/, "")
      .replace(frontmatter, "")
      .trim();
    if (!body) throw Error("技能正文为空：" + name);
    active.add(name);
    return (
      '<skill name="' +
      name +
      '" location="' +
      skill.file +
      '">\n包内引用相对于 skills/' +
      name +
      "/。\n\n" +
      body +
      "\n</skill>"
    );
  }
  function mountForShell(files, mounted) {
    for (const slug of new Set([...previous, ...active])) {
      if (mounted.has(slug)) continue;
      const skill = catalog.skills.get(slug);
      function walk(dir, prefix) {
        for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
          if (item.name.startsWith(".") || item.name === "node_modules")
            continue;
          const rel = prefix + item.name;
          if (item.isDirectory()) walk(path.join(dir, item.name), rel + "/");
          else if (item.isFile()) {
            const key = "skills/" + slug + "/" + rel;
            if (!Object.hasOwn(files, key)) files[key] = contents(skill, rel);
          }
        }
      }
      walk(skill.dir, "");
      mounted.add(slug);
    }
  }
  const advertised = [...catalog.skills.values()].filter((s) => !s.manual);
  const instructions =
    "以下目录只列技能元数据。任务匹配某项描述时，调用 skill_load({name}) 获取并遵循技能正文。读完 SKILL.md 后，按其中的相对路径用 read 读取已加载包的参考文件或脚本，用 bash 执行脚本和处理 Excel 等二进制资源。显式 /skill:name 指定的技能会随任务展开。\n<available_skills>\n" +
    advertised
      .map(
        (s) =>
          "<skill><name>" +
          s.name +
          "</name><description>" +
          escape(s.description) +
          "</description><location>" +
          s.file +
          "</location></skill>",
      )
      .join("\n") +
    "\n</available_skills>";
  return { load, mountForShell, instructions, active };
}

export function installSkill({ name, files }) {
  if (
    typeof name !== "string" ||
    !validName.test(name) ||
    name.length > 64 ||
    !Array.isArray(files) ||
    !files.length
  )
    fault("请选择包含 SKILL.md 的技能文件夹");
  if (discoverSkills().skills.has(name)) fault("同名技能已安装：" + name, 409);
  const root = path.join(directory, "skills");
  fs.mkdirSync(root, { recursive: true });
  const stage = fs.mkdtempSync(path.join(directory, "skill-install-"));
  try {
    for (const file of files) {
      if (
        typeof file.path !== "string" ||
        file.path.includes("\\") ||
        file.path.includes("\0") ||
        file.path.split("/").some((s) => !s || s.startsWith(".")) ||
        typeof file.data !== "string"
      )
        fault("技能文件路径或内容无效");
      const dest = path.join(stage, file.path);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, Buffer.from(file.data, "base64"), { flag: "wx" });
    }
    try {
      metadata(
        fs
          .readFileSync(path.join(stage, "SKILL.md"), "utf8")
          .replace(/^\uFEFF/, ""),
        name,
      );
    } catch (e) {
      fault(
        "技能格式无效：" +
          (e.code === "ENOENT" ? "文件夹顶层缺少 SKILL.md" : e.message),
      );
    }
    fs.renameSync(stage, path.join(root, name));
    return { name };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

// Upgrade existing personal writing rules once, before the first workspace save.
export function migrateWritingRule() {
  if (setting("migrated-skill-rules")) return;
  const name = "prd-writing";
  const rule = db
    .prepare(
      "SELECT json_extract(body, '$.rule') AS rule FROM state WHERE id=1",
    )
    .get()?.rule;
  const skill = discoverSkills().skills.get(name);
  if (
    rule?.trim() &&
    skill?.dir === path.join(project, "skills", name) &&
    rule.trim() !==
      fs
        .readFileSync(path.join(skill.dir, "generation-prompt.txt"), "utf8")
        .trim()
  ) {
    const stage = fs.mkdtempSync(path.join(directory, "skill-upgrade-"));
    try {
      fs.cpSync(skill.dir, stage, { recursive: true });
      fs.writeFileSync(path.join(stage, "generation-prompt.txt"), rule);
      fs.mkdirSync(managed, { recursive: true });
      fs.renameSync(stage, path.join(managed, name));
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
    }
  }
  set("migrated-skill-rules", "1");
}

export function removeSkill({ name }) {
  const skill = discoverSkills().skills.get(name);
  if (!skill) fault("技能未安装", 404);
  // Hide lower-priority copies, including when a replacement is later removed.
  set("skill-hidden:" + name, "1");
  if (skill.dir === path.join(managed, name)) {
    const trash = fs.mkdtempSync(path.join(directory, "skill-remove-"));
    try {
      fs.renameSync(skill.dir, path.join(trash, name));
    } finally {
      fs.rmSync(trash, { recursive: true, force: true });
    }
  }
  return { name };
}

export function skillPackage(name) {
  const skill = discoverSkills().skills.get(name);
  if (!skill) fault("技能未安装", 404);
  const files = [];
  function visit(dir, prefix) {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      if (item.name.startsWith(".") || item.name === "node_modules") continue;
      const entry = path.join(dir, item.name);
      const rel = prefix + item.name;
      if (item.isDirectory()) visit(entry, rel + "/");
      else if (item.isFile())
        files.push({ path: rel, data: fs.readFileSync(entry) });
    }
  }
  visit(skill.dir, "");
  return files;
}
