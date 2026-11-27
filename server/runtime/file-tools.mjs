import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createReadTool, createWriteTool, createEditTool } from "@earendil-works/pi-durable/tools";
import { defineTool } from "@earendil-works/pi-durable";
import { arr, obj, str } from "@earendil-works/pi-schema";
import { installSkill } from "../skills.mjs";
import { toolDescriptions } from "../../shared/agent-catalog.mjs";

const exec = promisify(execFile);
const helper = fileURLToPath(new URL("./task-files.py", import.meta.url));
const reply = (text, isError = false) => ({ output: [{ type: "text", text }], isError });

export function taskFileTools(work, inputs) {
  // The native tools work on private snapshots. Only the descriptor-relative transfer
  // touches shell-writable paths, including when scripts run concurrently with Pi.
  const stage = path.dirname(work);
  const pending = new Map();
  async function transfer(action, root, name, temp, signal, digest) {
    const args = ["-I", helper, action, root, name, temp];
    if (digest !== undefined) args.push(digest);
    try {
      const { stdout } = await exec("python3", args, { signal });
      return stdout.trim();
    } catch (error) {
      throw Error(error.stderr?.trim() || error.message);
    }
  }
  async function staged(fn) {
    const temp = await fs.mkdtemp(path.join(stage, "pi-file-"));
    try { return await fn(path.join(temp, "data")); }
    finally { await fs.rm(temp, { recursive: true, force: true }); }
  }
  function location(name, writing) {
    if (typeof name !== "string" || name.includes("\0") || name.split("/").includes(".."))
      throw Error("请使用任务目录内的路径");
    const relative = path.relative(work, path.resolve(work, name));
    if (!relative || relative.startsWith("../") || relative === "..") throw Error("路径超出本次任务目录");
    if (relative.startsWith("skills/")) {
      if (writing) throw Error("已加载技能为只读。请在任务目录中创建新的技能草稿。");
      return [path.join(inputs, "skills"), relative.slice(7)];
    }
    return [work, relative];
  }
  const tools = [createReadTool(), createWriteTool(), createEditTool()].map(native => ({
    ...native,
    description: toolDescriptions[native.name] + " " + native.description,
    async execute(args, api, context) {
      const writing = native.name !== "read";
      try {
        const [root, name] = location(args.path, writing);
        if (writing && Buffer.byteLength(JSON.stringify(args)) > 32 * 1024 * 1024) throw Error("文件过大");
        const key = path.join(root, name);
        const op = (pending.get(key) || Promise.resolve()).catch(() => {}).then(() => staged(async temp => {
          const digest = await transfer("snapshot", root, name, temp, context.abortSignal);
          let result;
          try {
            result = await native.execute({ ...args, path: temp }, api, context);
          } catch (error) {
            throw Error(error.message.replaceAll(temp, args.path));
          }
          if (writing && !result.isError) await transfer("commit", root, name, temp, context.abortSignal, digest);
          for (const part of result.output || [])
            if (part.type === "text") part.text = part.text.replaceAll(temp, args.path);
          if (result.details?.patch) result.details.patch = result.details.patch.replaceAll(temp, args.path);
          for (const entry of result.diagnostics || [])
            if (entry.message) entry.message = entry.message.replaceAll(temp, args.path);
          return result;
        }));
        pending.set(key, op);
        try { return await op; }
        finally { if (pending.get(key) === op) pending.delete(key); }
      } catch (error) { return reply(error.message.replaceAll(stage, "(任务目录)"), true); }
    },
  }));
  tools.push(defineTool({
    name: "install_skill", description: toolDescriptions.install_skill,
    parameters: obj({ name: str(), files: arr(str()) }),
    async execute({ name, files }, api, context) {
      try {
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || !files.includes("SKILL.md") || files.length > 256)
          throw Error("请提供技能目录名和包含 SKILL.md 的包内文件清单");
        const entries = [];
        let total = 0;
        for (const item of new Set(files)) {
          if (item.split("/").some(p => !p || p.startsWith("."))) throw Error("包内路径无效");
          const bytes = await staged(async temp => {
            const digest = await transfer("snapshot", work, name + "/" + item, temp, context.abortSignal);
            if (digest === "missing") throw Error("找不到草稿文件：" + item);
            return fs.readFile(temp);
          });
          if ((total += bytes.length) > 32 * 1024 * 1024) throw Error("技能包超过 32 MB");
          entries.push({ path: item, data: bytes.toString("base64") });
        }
        installSkill({ name, files: entries });
        return reply("已安装 " + name + "，后续请求可使用此技能。");
      } catch (error) { return reply(error.message, true); }
    },
  }));
  return tools;
}
