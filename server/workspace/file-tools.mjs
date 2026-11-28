import { arr, nullable, obj, oneOf, opt, str, int, bool } from "@earendil-works/pi-schema";
import { onlineFileTypes } from "../../shared/workspace-files.mjs";
import { toolDescriptions } from "../../shared/agent-catalog.mjs";
import { defineOnlineTool, onlineBatchTool } from "./batch-tool.mjs";

const id = str({ pattern: "\\S", description: "在线文件 ID，单项必填" });
const parentId = nullable(str({ pattern: "\\S" }), { description: "父节点 ID；根目录传 null" });

export function onlineFileTools(workspace) {
  return [
    onlineBatchTool(workspace, {
      name: "write_online_file",
      description: toolDescriptions.write_online_file,
      addressHint: "请传 parent_id、title 和 type。根目录传 parent_id:null，title 只填单个名称。",
      parameters: obj({
        parent_id: parentId,
        title: str({ minLength: 1 }),
        type: oneOf(Object.keys(onlineFileTypes)),
        content: opt(
          str({
            description:
              "文档富文本 HTML、单文件 HTML 源码或画布 JSON（含 elements 数组）；省略创建空文件。",
          }),
        ),
      }),
      execute: (target, args) => target.create(args),
    }),
    onlineBatchTool(workspace, {
      name: "read_online_file",
      readOnly: true,
      description: toolDescriptions.read_online_file,
      parameters: obj({ id, version: opt(int()), file: opt(oneOf(["prd", "html"])), offset: opt(int()), limit: opt(int()) }),
      maxResultBytes: 256 * 1024,
      execute: (target, args, count) => target.read(args, Math.floor(40000 / count)),
    }),
    defineOnlineTool({
      name: "edit_online_file",
      description: toolDescriptions.edit_online_file,
      addressHint: "请传目标文件 id；移动时 parent_id 为父节点 ID，移到根目录用 null。",
      parameters: obj({
        id,
        title: opt(str()),
        parent_id: opt(parentId),
        content: opt(str({ description: "单处替换或追加的内容。整篇替换另传 replace_all:true 和 base_version。" })),
        replace_all: opt(bool({ description: "整篇替换时显式设为 true。" })),
        base_version: opt(str({ description: "整篇替换目标在 read_online_file 最近读取结果中的 content_version。" })),
        append: opt(bool({ description: "向文档末尾追加，保留已有正文。" })),
        old_text: opt(str()),
        list: opt(arr(obj({ old_text: str({ description: "原文中唯一匹配的非空片段。" }), new_text: str() }), { minItems: 1 })),
      }),
      execute: workspace.edit,
    }),
    defineOnlineTool({
      name: "list_online_files",
      replay: "safe",
      description: toolDescriptions.list_online_files,
      addressHint: "请传 parent_id；列根目录用 {parent_id:null}，列某个节点的后代时传该节点 ID。",
      parameters: obj({ parent_id: parentId, offset: opt(int()), limit: opt(int()) }),
      execute: workspace.list,
    }),
  ];
}
