import { arr, obj, oneOf, opt, str, int, bool } from "@earendil-works/pi-schema";
import { onlineFileTypes } from "../../shared/workspace-files.mjs";
import { toolDescriptions } from "../../shared/agent-catalog.mjs";
import { defineTextTool } from "../agent/text-tool.mjs";
import { onlineBatchTool } from "./batch-tool.mjs";

const selector = {
  id: opt(str({ description: "在线文件 ID，与 path 二选一" })),
  path: opt(str({ description: "相对于在线工作区根目录的文件树路径，例如 需求/原型" })),
};

export function onlineFileTools(workspace) {
  return [
    onlineBatchTool(workspace, {
      name: "write_online_file",
      description: toolDescriptions.write_online_file,
      parameters: obj({
        path: str(),
        type: oneOf(Object.keys(onlineFileTypes)),
        parent_id: opt(
          str({
            description: "在线父文件 ID；省略时从工作区根目录创建",
          }),
        ),
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
      parameters: obj({ ...selector, version: opt(int()), file: opt(oneOf(["prd", "html"])), offset: opt(int()), limit: opt(int()) }),
      maxResultBytes: 256 * 1024,
      execute: (target, args, count) => target.read(args, Math.floor(40000 / count)),
    }),
    defineTextTool({
      name: "edit_online_file",
      description: toolDescriptions.edit_online_file,
      parameters: obj({
        ...selector,
        title: opt(str()),
        parent_id: opt(str()),
        content: opt(str({ description: "单处替换或追加的内容。整篇替换另传 replace_all:true 和 base_version。" })),
        replace_all: opt(bool({ description: "整篇替换时显式设为 true。" })),
        base_version: opt(str({ description: "整篇替换目标在 read_online_file 最近读取结果中的 content_version。" })),
        append: opt(bool({ description: "向文档末尾追加，保留已有正文。" })),
        old_text: opt(str()),
        list: opt(arr(obj({ old_text: str({ description: "原文中唯一匹配的非空片段。" }), new_text: str() }), { minItems: 1 })),
      }),
      execute: workspace.edit,
    }),
    defineTextTool({
      name: "list_online_files",
      replay: "safe",
      description: toolDescriptions.list_online_files,
      parameters: obj({ ...selector, offset: opt(int()), limit: opt(int()) }),
      execute: workspace.list,
    }),
  ];
}
