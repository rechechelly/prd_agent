import fs from "node:fs/promises";
import path from "node:path";
import { directory } from "../storage.mjs";
import { managedSkillDirectory } from "../skills.mjs";
import { fileURLToPath } from "node:url";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { FileError, ok, err } from "@earendil-works/pi-durable/env";
import { createBashTool } from "@earendil-works/pi-durable/tools";

export function taskBash(network) {
  return createBashTool({
    prepare(execution) {
      execution.inheritEnv = false;
      execution.env = {
        PATH:
          path.join(execution.cwd, ".python-packages", "bin") +
          ":/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin",
        PIP_NO_INPUT: "1",
        HOME: execution.cwd,
        PIP_TARGET: path.join(execution.cwd, ".python-packages"),
        PYTHONPATH: path.join(execution.cwd, ".python-packages"),
        PIP_DISABLE_PIP_VERSION_CHECK: "1",
        ...(process.platform === "darwin" && {
          PIP_USE_DEPRECATED: "legacy-certs",
        }),
        ...network,
        TASK_WORKSPACE_SKILLS: managedSkillDirectory,
        TMPDIR: execution.cwd,
        LANG: "en_US.UTF-8",
      };
    },
  });
}

// Keep Pi's full-output spill files readable by subsequent sandboxed commands.
class TaskEnvironment extends NodeExecutionEnv {
  async createTempDir(prefix, context) {
    if (context.abortSignal?.aborted)
      return super.createTempDir(prefix, context);
    try {
      return ok(await fs.mkdtemp(path.join(this.cwd, prefix || "tmp-")));
    } catch (error) {
      return err(new FileError("io", error.message, this.cwd, error));
    }
  }
}

export async function createStage() {
  const parent = path.join(directory, "agent-work");
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  return fs.mkdtemp(path.join(await fs.realpath(parent), "run-"));
}

export async function taskEnvironment(stage, files, skills, resumed = false) {
  const work = path.join(stage, "work"),
    inputs = path.join(stage, "inputs");
  await fs.mkdir(work, { recursive: resumed });
  await fs.mkdir(path.join(inputs, "skills"), { recursive: true });
  for (const [name, data] of Object.entries(files)) {
    await fs.writeFile(path.join(inputs, name), typeof data === "function" ? data() : data);
    try {
      await fs.copyFile(
        path.join(inputs, name),
        path.join(work, name),
        fs.constants.COPYFILE_EXCL,
      );
    } catch (error) {
      if (!resumed || error.code !== "EEXIST") throw error;
    }
  }
  if (process.platform === "linux")
    await fs.copyFile(
      new URL("./task-net-bridge.py", import.meta.url),
      path.join(inputs, "network.py"),
    );
  // The stable alias lives in protected inputs; its target is the sole writable
  // directory shared by tasks in this workspace. Other workspaces use their own XUYE_DATA.
  await fs.mkdir(managedSkillDirectory, { recursive: true, mode: 0o700 });
  if (!(await fs.lstat(managedSkillDirectory)).isDirectory()) throw Error("工作区技能需要存放在独立目录中");
  const agentDirectory = path.join(inputs, ".agents");
  await fs.mkdir(agentDirectory, { recursive: true });
  async function mountLink(target, link) {
    try { await fs.symlink(target, link); }
    catch (error) {
      if (error.code !== "EEXIST" || await fs.readlink(link) !== target) throw error;
    }
  }
  await mountLink(managedSkillDirectory, path.join(agentDirectory, "skills"));
  await mountLink(agentDirectory, path.join(work, ".agents"));
  if (!resumed)
    await fs.symlink(path.join(inputs, "skills"), path.join(work, "skills"));
  const env = new TaskEnvironment({
    cwd: work,
    shellPath: fileURLToPath(new URL("./task-shell", import.meta.url)),
  });
  const mounted = new Set();
  async function mountSkills() {
    const resources = Object.create(null);
    skills.mountForShell(resources, mounted);
    for (const [name, data] of Object.entries(resources)) {
      const dest = path.join(inputs, name);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, data, { mode: 0o700 });
    }
  }
  await mountSkills();
  async function writeSnapshot(name, data) {
    // Stage outside the shell-writable directory and atomically replace its entry.
    const temp = path.join(inputs, ".snapshot");
    await fs.writeFile(temp, data);
    await fs.rename(temp, path.join(work, name));
  }
  return { env, inputs, mountSkills, writeSnapshot };
}
