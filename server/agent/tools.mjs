import { defineTextTool } from "./text-tool.mjs";
import { defineOnlineTool, onlineBatchTool } from "../workspace/batch-tool.mjs";
import { onlineFileTools } from "../workspace/file-tools.mjs";
import { contentVersion } from "../workspace/online-files.mjs";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { obj, str } from "@earendil-works/pi-schema";
import { toolDescriptions } from "../../shared/agent-catalog.mjs";
import { storedDocumentType } from "../../shared/workspace-files.mjs";
import { drawCanvasTool } from "../workspace/canvas-tools.mjs";
import { renderDelivery } from "../render.mjs";
import { discoverSkills } from "../skills.mjs";
import { taskFileTools } from "../runtime/file-tools.mjs";
import { taskBash } from "../runtime/task-environment.mjs";
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
  workspace,
  restoreImages,
  scope,
  skillSet,
  mountSkills,
  inputs,
  network,
  compactTool,
  env,
}) {
  const availableTools = [
    ...onlineFileTools(workspace),
    ...taskFileTools(env.cwd, inputs),
    onlineBatchTool(workspace, {
      name: "embed_view_screenshots",
      description: toolDescriptions.embed_view_screenshots,
      addressHint: "传入 document_id 和 html_id，分别指定目标文档和 HTML 原型的文件 ID。",
      parameters: obj({ document_id: str(), html_id: str() }),
      async execute(draft, { document_id, html_id }) {
        const document = draft.target(document_id),
          page = draft.target(html_id);
        if (storedDocumentType(document.type) !== "文档" || storedDocumentType(page.type) !== "交互 HTML")
          throw Error("请指定文档和 HTML 文件的 ID");
        if (!document.html?.trim() || !page.html?.trim())
          throw Error("嵌入截图需要文档正文和 HTML 原型源码，请先写入内容");
        const result = await renderDelivery({
          prd: document.html,
          html: restoreImages(page.html),
        });
        return draft.edit({ id: document.id, replace_all: true, base_version: contentVersion(document.html), content: result.prd });
      },
    }),
    defineTextTool({
      name: "skill_load",
      description: toolDescriptions.skill_load,
      parameters: obj({ name: str() }),
      async execute({ name }) {
        const instructions = skillSet.load(name);
        await mountSkills();
        return instructions;
      },
    }),
    taskBash(network.vars),
    drawCanvasTool(workspace),
    compactTool,
  ];
  if (!scope) return availableTools;
  const scopedTools = availableTools.filter(tool =>
    ["read", "read_online_file", "list_online_files", "skill_load", "compact_context"].includes(tool.name)
  );
  scopedTools.push(defineOnlineTool({
    name: "edit_online_file",
    description: "仅替换本次划词选区。content 是完整的新选区片段，无需提供全文或目标 ID。保留文档片段中的原有标签。HTML 源码选区按原样替换。",
    parameters: obj({ content: str() }),
    addressHint: "划词模式只传 content，目标由本次选择的文字绑定。",
    execute({ content }) {
      const { id, html } = workspace.target(scope.fileId);
      return workspace.edit({ id, content: scope.replace(html, content), replace_all: true, base_version: contentVersion(html) });
    },
  }));
  return scopedTools;
}
