import { cursorEdits } from "../../shared/online-file-edit.mjs";
import { fault } from "../storage.mjs";
import { complete } from "./client.mjs";

export function completionMessages(title, input) {
  const { before, after, editableAfter, codeLanguage, blockPath, cursorAt, atFileEnd, previous } = input;
  const code = typeof codeLanguage === "string";
  const suffix = String(editableAfter || "").slice(0, 1000);
  const canCorrect = /\S/.test(suffix);
  return [
    {
      role: "system",
      content: [
        '你是编辑器中的光标补全。光标位于 before 和 after 之间。只返回纯 JSON。续写时返回 {"insert":"要插入的内容"}，只写缺少的部分，由编辑器直接插入光标处。无需建议时返回 {"insert":""}。',
        canCorrect
          ? '只有需要修改已有文字时才返回 {"list":[{"old_text":"原文","new_text":"修正内容"}]}。每项 old_text 须在 editableAfter 内逐字唯一匹配，彼此不重叠。重复文字要带上能区分目标的相邻原文，在 new_text 中保留这些上下文。'
          : "此处仅可插入。保留光标两侧已有的文字和换行。",
        code
          ? 'cursorAt 表示当前代码行内的位置。保留源码缩进和换行。例如 before 以 <title 结尾、下一行已有 <style>，可返回 {"insert":">页面标题</title>"}。'
          : "cursorAt 表示当前段落内的位置。使用 Markdown，句中续写直接接字，另起段落或列表时保留开头的换行。boundary 表示可编辑后文结束处的节点类型。图片是独立节点，只在当前文字处续写，不生成图片或引用图片里的内容。",
        canCorrect && input.format !== "list" ? "最多返回一项修正。" : "",
        code ? "返回前把建议放回 before 和 after 之间检查语法，保留补全所需的结束符。如果后文没有结束标签的 >，在建议中补齐。" : "",
        input.trigger === "manual" ? (code ? "用户主动请求代码补全，请优先补齐光标处的语法。"
          : "用户主动请求建议，请给出有上下文依据的下一步。遇到完整句号可以另起一句，避免虚构需求和事实。") : "",
        previous ? "用户要求换一版，请给出与上次不同的建议。" : "",
      ].filter(Boolean).join("\n"),
    },
    {
      role: "user",
      content: JSON.stringify({
        title: String(title || "").slice(0, 240), before: String(before || "").slice(-3500),
        after: String(after || "").slice(0, 1000), ...(canCorrect && { editableAfter: suffix }),
        ...(typeof input.boundary === "string" && { boundary: input.boundary.slice(0, 40) }),
        ...(typeof blockPath === "string" && { blockPath: blockPath.slice(0, 240) }),
        ...(typeof cursorAt === "string" && { cursorAt: cursorAt.slice(0, 12), atFileEnd: atFileEnd === true }),
        ...(code && { codeLanguage: codeLanguage.slice(0, 80) }),
        ...(previous && { previousSuggestion: JSON.stringify(previous).slice(0, 4000) }),
      }),
    },
  ];
}

export async function suggestCompletion(config, title, input, signal) {
  const output = await complete(config, completionMessages(title, input), 1024, signal, { json: true });
  const suffix = String(input.editableAfter || "").slice(0, 1000);
  let edits;
  try {
    const response = JSON.parse(output);
    const keys = Object.keys(response ?? {});
    if (keys.length === 1 && keys[0] === "insert" && typeof response.insert === "string") {
      edits = response.insert ? [{ from: 0, to: 0, content: response.insert }] : [];
    } else {
      if (keys.length !== 1 || keys[0] !== "list") throw Error("请返回 insert 字符串或 list 修改数组");
      edits = cursorEdits(suffix, response.list, String(input.before || "").slice(-3500));
    }
  } catch (error) {
    if (!(error instanceof RangeError))
      fault(error instanceof SyntaxError ? "补全模型未返回有效 JSON" : "补全建议无效：" + error.message, 502);
    if (input.format === "list") return { list: [], reason: error.message };
    edits = [];
  }
  if (input.format === "list") return { list: edits.map(({ from, to, content }) => ({
    old_text: suffix.slice(from, to), new_text: content,
  })) };
  // Cached editors predate list support and display a single suggestion.
  const first = edits[0];
  if (input.editableAfter === undefined) return { text: first?.content ?? "" };
  return { edit: first ? {
    keep: suffix.slice(0, first.from), remove: suffix.slice(first.from, first.to), insert: first.content,
  } : null };
}
