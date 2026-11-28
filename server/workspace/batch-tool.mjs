import { arr, compile } from "@earendil-works/pi-schema";
import { defineTextTool } from "../agent/text-tool.mjs";

const defaultHint = "请传在线文件 id。可用 list_online_files({parent_id:null}) 查询 ID。";

// Pi coerces inputs before execution. Check addressing on the original call so e.g.
// a boolean parent cannot become null (the root), and stale selectors get a useful error.
export function defineOnlineTool({ parameters, addressHint = defaultHint, batch = false, execute, ...definition }) {
  const itemValidator = compile(parameters);
  function checkItem(item, location) {
    if (itemValidator.check(item)) return;
    const errors = itemValidator.errors(item);
    const error = errors.find(e => e.keyword === "additionalProperties")
      ?? errors.find(e => e.keyword === "required" || /\/(?:id|title|parent_id|document_id|html_id)$/.test(e.path));
    if (error) {
      const field = location + error.path.replaceAll("/", ".").replace(/^\./, "");
      const reason = error.keyword === "additionalProperties" ? "不支持字段 " :
        error.keyword === "required" ? "缺少必填字段 " : "字段值无效 ";
      throw Error(reason + field + "。" + addressHint);
    }
  }
  function prepare(args) {
    if (batch && args && Object.hasOwn(args, "list")) {
      const other = Object.keys(args).filter(k => k !== "list");
      if (other.length) throw Error("批量调用的顶层只接受 list，请移除 " + other.join("、") + "。" + addressHint);
      if (!Array.isArray(args.list) || !args.list.length)
        throw Error("list 需要至少一组参数。" + addressHint);
      args.list.forEach((item, i) => checkItem(item, `list[${i}].`));
    } else checkItem(args, "");
    return args;
  }
  const { required, ...single } = parameters;
  return defineTextTool({
    ...definition,
    parameters: batch ? {
      ...single,
      description: `单项必传 ${required.join("、")}；批量调用只传 list，各项使用相同参数。`,
      properties: { ...single.properties, list: arr(parameters, { minItems: 1 }) },
    } : parameters,
    prepareArguments: prepare,
    execute: (args, ...rest) => execute(prepare(args), ...rest),
  });
}

export function onlineBatchTool(workspace, { parameters, execute, readOnly = false, maxResultBytes = 50 * 1024, ...definition }) {
  return defineOnlineTool({
    ...definition, parameters, batch: true,
    outputLimits: { maxBytes: maxResultBytes },
    ...(readOnly && { replay: "safe" }),
    async execute({ list, ...single }, _api, context) {
      if (list === undefined) return execute(workspace, single, 1);
      async function run(target) {
        const results = [];
        let bytes = 2; // JSON array brackets
        for (const [index, item] of list.entries()) {
          context?.abortSignal?.throwIfAborted();
          try {
            const result = await execute(target, item, list.length);
            bytes += Buffer.byteLength(JSON.stringify(result)) + (index ? 1 : 0);
            if (bytes > maxResultBytes) throw Error("返回数据过长，请减少批次项数或读取范围");
            results.push(result);
          } catch (error) {
            throw Error(`第 ${index + 1} 项失败：${error.message}`);
          }
        }
        context?.abortSignal?.throwIfAborted();
        return results;
      }
      return readOnly ? run(workspace) : workspace.transaction(run);
    },
  });
}
