import { toolReply } from "../agent/text-tool.mjs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ok, getOrThrow } from "@earendil-works/pi-durable/env";
import { createReadTool, createWriteTool, createEditTool } from "@earendil-works/pi-durable/tools";
import { managedSkillDirectory } from "../skills.mjs";

const exec = promisify(execFile);
const helper = fileURLToPath(new URL("./task-files.py", import.meta.url));
const maxFileBytes = 32 * 1024 * 1024;

export function taskFileTools(work, inputs) {
  // The native tools work on private snapshots. Only the descriptor-relative transfer
  // touches shell-writable paths, including when scripts run concurrently with Pi.
  const stage = path.dirname(work);
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
  function location(name, writing) {
    if (typeof name !== "string" || name.includes("\0") || name.split("/").includes(".."))
      throw Error("请使用任务目录内的路径");
    const relative = path.relative(work, path.resolve(work, name));
    if (!relative || relative.startsWith("../") || relative === "..") throw Error("路径超出本次任务目录");
    if (relative.startsWith(".agents/skills/"))
      return [managedSkillDirectory, relative.slice(".agents/skills/".length)];
    if (relative.startsWith("skills/")) {
      if (writing) throw Error("此包为只读资源。请在 .agents/skills/ 下创建或修改工作区技能。");
      return [path.join(inputs, "skills"), relative.slice(7)];
    }
    return [work, relative];
  }
  // Pi resolves the model's original arguments and serializes mutations by canonical
  // path. Only this environment translates validated task paths into private files.
  function fileEnvironment(host, tempDir, writing, signal) {
    const snapshots = new Map();
    async function snapshot(file) {
      if (!snapshots.has(file)) {
        const [root, name] = location(file, writing);
        const temp = path.join(tempDir, String(snapshots.size));
        const digest = await transfer("snapshot", root, name, temp, signal);
        snapshots.set(file, { root, name, temp, digest });
      }
      return snapshots.get(file);
    }
    return {
      id: host.id,
      async absolutePath(file, context) {
        const absolute = getOrThrow(await host.absolutePath(file, context));
        location(absolute, writing);
        return ok(absolute);
      },
      canonicalPath(file) { return ok(path.join(...location(file, writing))); },
      async exists(file) { return ok((await snapshot(file)).digest !== "missing"); },
      async openBinaryReader(file, options, context) {
        return host.openBinaryReader((await snapshot(file)).temp, options, context);
      },
      async fileInfo(file, context) { return host.fileInfo((await snapshot(file)).temp, context); },
      async readTextFile(file, context) { return host.readTextFile((await snapshot(file)).temp, context); },
      async writeFile(file, content, context) {
        if (Buffer.byteLength(content) > maxFileBytes) throw Error("文件过大");
        const { root, name, temp, digest } = await snapshot(file);
        const result = await host.writeFile(temp, content, context);
        if (result.ok) await transfer("commit", root, name, temp, signal, digest);
        return result;
      },
    };
  }
  return [createReadTool(), createWriteTool(), createEditTool()].map(native => ({
    ...native,
    async execute(args, api, context) {
      const writing = native.name !== "read";
      if (writing && Buffer.byteLength(JSON.stringify(args)) > maxFileBytes) return toolReply("文件过大", true);
      const temp = await fs.mkdtemp(path.join(stage, "pi-file-"));
      try {
        const env = fileEnvironment(api.env, temp, writing, context.abortSignal);
        return await native.execute(args, Object.create(api, { env: { value: env } }), context);
      } catch (error) {
        return toolReply(error.message.replaceAll(temp, "(任务文件)").replaceAll(stage, "(任务目录)"), true);
      } finally {
        await fs.rm(temp, { recursive: true, force: true });
      }
    },
  }));
}
