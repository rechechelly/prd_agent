import { defineTool } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { obj, str } from "@earendil-works/pi-schema";
import { toolDescriptions } from "../../shared/agent-catalog.mjs";
import { storedDocumentType } from "../../shared/workspace-files.mjs";
import { drawCanvasTool } from "../workspace/canvas-tools.mjs";
import { renderDelivery } from "../render.mjs";
import { discoverSkills } from "../skills.mjs";
import { taskFileTools } from "../runtime/file-tools.mjs";
import { taskBash } from "../runtime/task-environment.mjs";
export const toolReply = (text, isError = false) => ({
  output: [{ type: "text", text }],
  isError,
});
export function agentCatalog() {
  const { skills, warnings } = discoverSkills();
  return {
    tools: [
      ...CodingTools.tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
      ...Object.entries(toolDescriptions).map(([name, description]) => ({ name, description })),
    ],
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
  restoreImages,
  scope,
  skillSet,
  mountSkills,
  files,
  inputs,
  network,
  compactTool,
  env,
  writeCurrent,
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
          if (storedDocumentType(document.type) !== "文档" || storedDocumentType(page.type) !== "交互 HTML")
            throw Error("请指定文档和 HTML 文件的 ID");
          if (!document.html?.trim() || !page.html?.trim())
            throw Error("嵌入截图需要文档正文和 HTML 原型源码，请先写入内容");
          const result = await renderDelivery({
            prd: document.html,
            html: restoreImages(page.html),
          });
          return creation.tools
            .find((tool) => tool.name === "edit_online_file")
            .execute({ id: document.id, content: result.prd });
        } catch (error) {
          return toolReply(error.message, true);
        }
      },
    }),
    defineTool({
      name: "skill_load",
      description: toolDescriptions.skill_load,
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
    ["read", "read_online_file", "list_online_files", "skill_load", "compact_context"].includes(tool.name)
  ).concat(defineTool({
    name: "edit_online_file",
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
  return tools;
}
