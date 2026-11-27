import { arr } from "@earendil-works/pi-schema";
import { defineTextTool } from "../agent/text-tool.mjs";

// Keep the single-item contract and publish the same fields as the schema for each list item.
export function onlineBatchTool(workspace, { parameters, execute, readOnly = false, maxResultBytes = 50 * 1024, ...definition }) {
  const { required = [], ...schema } = parameters;
  return defineTextTool({
    ...definition,
    outputLimits: { maxBytes: maxResultBytes },
    ...(readOnly && { replay: "safe" }),
    parameters: {
      ...schema,
      properties: { ...parameters.properties, list: arr(parameters, { minItems: 1 }) },
    },
    async execute({ list, ...single }, _api, context) {
      if (list === undefined) {
        for (const key of required) {
          if (single[key] === undefined) throw Error("缺少参数 " + key);
        }
        return execute(workspace, single, 1);
      }
      if (!Array.isArray(list) || !list.length || Object.keys(single).length)
        throw Error("请通过非空 list 提交各项参数，或直接传入一项的参数");
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
