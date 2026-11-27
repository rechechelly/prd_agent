import { defineTool } from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import { toolDescriptions } from "../../shared/agent-catalog.mjs";
import { drawCanvasTool } from "../workspace/canvas-tools.mjs";
import { renderDelivery } from "../render.mjs";
import { discoverSkills } from "../skills.mjs";
import { taskFileTools } from "../runtime/file-tools.mjs";
import { taskBash } from "../runtime/task-environment.mjs";
import { diagnostic } from "./stream.mjs";
export const toolReply = (text, isError = false) => ({
  output: [{ type: "text", text }],
  isError,
});
export function agentCatalog() {
  const { skills, warnings } = discoverSkills();
  return {
    tools: Object.entries(toolDescriptions).map(([name, description]) => ({
      name,
      description,
    })),
    skills: [...skills.values()].map(({ name, description, file }) => ({
      name,
      description,
      file,
    })),
    warnings,
  };
}

export function createAgentTools({
  creation,
  scope,
  skillSet,
  mountSkills,
  files,
  inputs,
  network,
  compactTool,
  toolCalls,
  env,
  writeCurrent,
  progress,
  pause,
}) {
  const availableTools = [
    ...creation.tools,
    ...taskFileTools(env.cwd, inputs),
    defineTool({
      name: "embed_view_screenshots",
      description: toolDescriptions.embed_view_screenshots,
      parameters: obj({ document_id: str(), html_id: str() }),
      async execute({ document_id, html_id }) {
        try {
          const document = creation.target(document_id),
            page = creation.target(html_id);
          if (document.type !== "文档" || page.type !== "交互 HTML")
            throw Error("请指定文档和 HTML 文件的 ID");
          const result = await renderDelivery({
            prd: document.html,
            html: page.html,
          });
          return creation.tools
            .find((tool) => tool.name === "edit_file")
            .execute({ id: document.id, content: result.prd });
        } catch (error) {
          return toolReply(error.message, true);
        }
      },
    }),
    defineTool({
      name: "skill_load",
      description:
        "按 available_skills 中的名称加载匹配任务的技能。返回 SKILL.md 正文和包内资料的基准路径。",
      parameters: obj({ name: str() }),
      async execute({ name }) {
        try {
          const instructions = skillSet.load(name);
          await mountSkills();
          return toolReply(instructions);
        } catch (error) {
          return toolReply(error.message, true);
        }
      },
    }),
    taskBash(network.vars),
    drawCanvasTool(creation),
    compactTool,
  ];
  const tools = scope ? availableTools.filter(tool =>
    ["read", "read_file", "list_file", "skill_load", "compact_context"].includes(tool.name)
  ).concat(defineTool({
    name: "edit_file",
    description: "仅替换本次划词选区。content 是完整的新选区片段，无需提供全文或目标 ID。保留文档片段中的原有标签。HTML 源码选区按原样替换。",
    parameters: obj({ content: str() }),
    async execute({ content }) {
      try {
        const value = scope.replace(files["current.html"], content);
        if (Buffer.byteLength(value) > 12_000_000) throw Error("单文件超过 12 MB");
        await writeCurrent(value);
        return toolReply("已在当前文件的指定选区提交修改，等待用户采用。");
      } catch (error) { return toolReply(error.message, true); }
    },
  })) : availableTools;
  return tools.map((tool) => ({
    ...tool,
    async execute(args, api, context) {
      const started = Date.now();
      const event = { name: tool.name, at: started, status: "running" };
      if (typeof args.path === "string") event.path = args.path.slice(0, 160);
      if (tool.name === "bash" && typeof args.command === "string")
        event.command = args.command.slice(0, 240);
      toolCalls.push(event);
      let action = tool.name;
      if (tool.name === "bash") {
        if (/playwright.*install.*chrom/i.test(args.command))
          action += " · 下载 Chromium";
        else if (/pip.* install /.test(args.command))
          action += " · 安装 Python 依赖";
      } else if (event.path) action += " · " + event.path;
      progress?.({ label: "正在执行 " + action, tool: true });
      try {
        const result = await tool.execute(args, api, context);
        event.status = result.isError ? "failed" : "done";
        const exitCode = result.structuredOutput?.exitCode;
        if (
          tool.name === "bash" &&
          typeof result.structuredOutput?.output === "string"
        ) {
          event.output = result.structuredOutput.output.slice(0, 600);
        }
        if (result.isError)
          event.error = diagnostic(
            result.diagnostics?.at(-1)?.message ||
              result.output?.find((o) => o.type === "text")?.text ||
              "工具执行失败",
          );
        if (Number.isInteger(exitCode)) event.exitCode = exitCode;
        return result;
      } catch (error) {
        event.status = "failed";
        event.error = diagnostic(error.message);
        throw error;
      } finally {
        event.duration = Date.now() - started;
        if (pause.signal.aborted && event.status === "failed")
          event.status = "interrupted";
        progress?.({
          label:
            action +
            (event.status === "interrupted"
              ? " 已中断"
              : event.error
                ? " 失败：" + event.error
                : " 完成"),
          tool: true,
        });
      }
    },
  }));
}
