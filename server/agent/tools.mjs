import { createReadTool } from "@earendil-works/pi-durable/tools";
import { defineTool } from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import path from "node:path";
import { toolDescriptions } from "../../src/agent-catalog.mjs";
import { drawCanvasTool } from "../canvas-tools.mjs";
import { renderDelivery } from "../render.mjs";
import { discoverSkills } from "../skills.mjs";
import { imageAttachment } from "../attachments.mjs";
import { taskBash, readScratchFile } from "../task-environment.mjs";
import { diagnostic } from "../agent-stream.mjs";
const resourceReader = createReadTool();
const readResource = {
  ...resourceReader,
  name: "read_resource",
  description:
    "读取附件、选区、引用图片，以及已加载技能的参考文件；path 使用提示提供的资源名，offset、limit 按行计。",
};
export const toolReply = (text, isError = false) => ({
  output: [{ type: "text", text }],
  isError,
});
export function agentCatalog() {
  const { skills, warnings } = discoverSkills();
  return {
    tools: Object.entries(toolDescriptions).map(([name, description]) => ({
      name,
      description: name === "bash" ? taskBash().description : description,
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
  skillSet,
  mountSkills,
  images,
  references,
  files,
  inputs,
  network,
  compactTool,
  toolCalls,
  doc,
  env,
  writeCurrent,
  progress,
  pause,
}) {
  const availableTools = [
    ...creation.tools,
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
    {
      ...readResource,
      async execute(args, api, context) {
        const name = path.posix.resolve("/", args.path).slice(1);
        if (/^skills\/[^/]+\/SKILL\.md$/.test(name))
          return toolReply(
            "加载技能正文请调用 skill_load，并传入技能名称。",
            true,
          );
        const asset = /^xuye-asset-([1-9]\d*)$/.exec(name);
        if (asset) {
          const url = images[Number(asset[1]) - 1];
          if (!url) return toolReply("当前文档没有这张配图。", true);
          const [, mimeType, data] = /^data:([^;]+);base64,(.*)$/is.exec(url);
          return { output: [{ type: "image", mimeType, data }] };
        }
        if (references.olderImages.has(name)) {
          const image = imageAttachment(references.olderImages.get(name));
          return {
            output: [
              {
                type: "image",
                mimeType: image.mime,
                data: Buffer.from(image.bytes).toString("base64"),
              },
            ],
          };
        }
        const resource = name.startsWith("skills/")
          ? skillSet.resource(name)
          : Object.hasOwn(files, name) &&
            /^(?:upload-|selection-|xuye-ref-)/.test(name);
        if (!resource)
          return toolReply(
            "请用 read_file 读取工作区文件或交付草稿，list_file 查看目录。",
            true,
          );
        return readResource.execute(
          { ...args, path: path.join(inputs, name) },
          api,
          context,
        );
      },
    },
    taskBash(network.vars),
    drawCanvasTool(creation),
    compactTool,
  ];
  return availableTools.map((tool) => ({
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
        if (
          tool.name === "bash" &&
          doc.type === "交互 HTML" &&
          !result.isError
        ) {
          // Only the named working copy is a draft. Other shell files are scratch.
          let scratch;
          try {
            scratch = await readScratchFile(env, "current.html");
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
          }
          if (scratch && scratch.html !== files["current.html"]) {
            await writeCurrent(scratch.html);
            progress?.({ label: "当前 HTML 修改已进入待审阅草稿" });
            result.diagnostics = [
              ...(result.diagnostics || []),
              {
                severity: "info",
                code: "html_draft",
                message:
                  "current.html 已同步为待审阅修改。完成必要检查后即可答复并交付此草稿。",
              },
            ];
          }
        }
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
