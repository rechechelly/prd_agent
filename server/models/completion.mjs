import { cursorEdits } from "../../shared/online-file-edit.mjs";
import { fault } from "../storage.mjs";
import { complete } from "./client.mjs";

export function completionMessages(title, input) {
  const { before, after, editableAfter, codeLanguage, blockPath, cursorAt, atFileEnd, previous } = input;
  const code = typeof codeLanguage === "string";
  return [
    {
      role: "system",
      content: [
        "你是编辑器中的光标补全。根据标题和上下文写出下一小段自然、有用的内容。before 是只读前文，after 是后文参考，只允许在光标处插入或修改 editableAfter。",
        '只返回纯 JSON 对象 {"list":[{"old_text":"","new_text":"..."}]}，不写解释或外层 Markdown 围栏。old_text 为空表示在光标插入，最多一项。其余 old_text 必须在原始 editableAfter 中逐字唯一匹配，各项互不重叠。删除时 new_text 为空。',
        'new_text 将完整替代 old_text。保留原文中正确的文字，插入时不要把整句当作锚点。例如光标后的“户点击保存”缺少首字，返回 {"list":[{"old_text":"","new_text":"用"}]}。',
        "补齐未完成的词句或代码，留意已有后文，避免重复。文末或空行可根据前文和标题接着写下一句、下一段或下一个条目。无需续写或纠错时返回 {\"list\":[]}。",
        code
          ? "cursorAt 表示当前代码行内的位置。new_text 是可直接插入的原始代码，保留语言、缩进、空白和换行。"
          : "cursorAt 表示当前段落内的位置。new_text 使用 Markdown。句中续写直接接字，需要另起段落或列表时保留开头的换行。",
        input.format === "list" ? "可一次修正多处有根据的错误，保持建议简短。" : "最多返回一项。",
        input.trigger === "manual" ? "用户主动请求建议，请给出有上下文依据的下一步。遇到完整句号可以另起一句，避免虚构需求和事实。" : "",
        previous ? "用户要求换一版，请给出与上次不同的建议。" : "",
      ].filter(Boolean).join("\n"),
    },
    {
      role: "user",
      content: JSON.stringify({
        title: String(title || "").slice(0, 240), before: String(before || "").slice(-3500),
        after: String(after || "").slice(0, 1000), editableAfter: String(editableAfter || "").slice(0, 1000),
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
    edits = cursorEdits(suffix, JSON.parse(output)?.list);
  } catch (error) {
    // A well-formed suggestion can still have no applicable range at this caret.
    if (!(error instanceof RangeError))
      fault(error instanceof SyntaxError ? "补全模型未返回有效 JSON" : "补全建议无效：" + error.message, 502);
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
