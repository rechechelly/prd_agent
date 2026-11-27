import { fault } from "../storage.mjs";

export function completionMessages(title, { before, after, editableAfter, previous, codeLanguage, blockPath, atBlockEnd }) {
  const code = typeof codeLanguage === "string";
  return [
    {
      role: "system",
      content: [
        "你在用户的光标处提供一个短小、可直接采纳的编辑建议。before 是光标前的只读上下文，after 是光标后的上下文。editableAfter 是允许修改的连续后文。",
        '只返回一个 JSON 对象 {"keep":"","remove":"","insert":""}。keep 是从光标开始跳过的原文，remove 是紧随其后要删除的原文，二者拼接必须逐字匹配 editableAfter 的开头，包括空白。insert 是替换 remove 的新内容。只插入时 remove 为空，直接在光标处插入时 keep 也为空。用最小范围改动，遗漏或明显的错误可以纠正，保留其余内容。不要重复已有的后文。',
        code
          ? "insert 写原始代码，保持语言、缩进和换行，不要加 Markdown 围栏。"
          : "insert 使用 Markdown。根据上下文续写句子，也可以换行新增段落、标题、有序列表、表格或代码块。需要另起一段时保留开头的换行。",
        previous ? "用户要求换一版，请提供不同的建议。" : "",
      ].filter(Boolean).join("\n"),
    },
    {
      role: "user",
      content: JSON.stringify({
        title, before: String(before || "").slice(-3500), after: String(after || "").slice(0, 1000),
        editableAfter: String(editableAfter || "").slice(0, 1000),
        ...(typeof blockPath === "string" && { blockPath: blockPath.slice(0, 240), atBlockEnd: atBlockEnd === true }),
        ...(code && { codeLanguage: codeLanguage.slice(0, 80) }),
        ...(previous && { previousSuggestion: String(previous.insert ?? previous).slice(0, 4000) }),
      }),
    },
  ];
}

export function completionEdit(output, editableAfter = "") {
  let edit;
  try {
    const fenced = /^\s*`{3}(?:json)?\s*\n([\s\S]*?)\n`{3}\s*$/i.exec(output);
    edit = JSON.parse(fenced?.[1] ?? output);
  } catch {
    fault("补全模型返回的编辑建议不完整，请重新生成", 502);
  }
  if (!edit || typeof edit !== "object") fault("补全建议格式有误，请重新生成", 502);
  const { keep = "", remove, insert } = edit;
  if (![keep, remove, insert].every(s => typeof s === "string") ||
      !String(editableAfter).slice(0, 1000).startsWith(keep + remove) || remove === insert)
    fault("建议未匹配光标后的原文或没有变化，请重新生成", 502);
  return { keep, remove, insert };
}
