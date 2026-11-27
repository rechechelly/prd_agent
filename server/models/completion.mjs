import { fault } from "../storage.mjs";
import { complete } from "./client.mjs";

export function completionMessages(title, { before, after, editableAfter, previous, codeLanguage, blockPath, atBlockEnd }) {
  const code = typeof codeLanguage === "string";
  return [
    {
      role: "system",
      content: [
        "你在用户的光标处提供一个短小、可直接采纳的编辑建议。before 是光标前的只读上下文，after 是光标后的上下文。editableAfter 是允许修改的连续后文。",
        '如果光标前有半个词、未完成的句子或代码，优先补齐；如果后文有明显错误，给出最小修正。返回 JSON，对象的三个字符串依次表示跳过的后文 keep、删除的原文 remove、写入的内容 insert。keep + remove 必须逐字匹配 editableAfter 的开头，包括空白。',
        '例如光标前是“点此查”，后面缺少宾语，可返回 {"keep":"","remove":"","insert":"看详情"}。如果后文是“请确人。”，可返回 {"keep":"请确","remove":"人","insert":"认"}。不要复述已有后文。上下文完整且没有合适建议时返回 null。',
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
  if (edit === null) return null;
  if (typeof edit !== "object") fault("补全建议格式有误，请重新生成", 502);
  const { keep = "", remove, insert } = edit;
  if (![keep, remove, insert].every(s => typeof s === "string"))
    fault("补全建议缺少文本字段，请重新生成", 502);
  if (remove === insert) return null;
  if (!String(editableAfter).slice(0, 1000).startsWith(keep + remove))
    fault("补全建议与光标后的原文不匹配，请重新生成", 502);
  return { keep, remove, insert };
}

export async function suggestCompletion(config, title, input, signal) {
  const messages = completionMessages(title, input);
  const request = () => complete(config, messages, 1024, signal);
  const first = await request();
  let feedback;
  try {
    const edit = completionEdit(first, input.editableAfter);
    if (edit || input.trigger !== "manual") return edit;
    feedback = "用户主动请求了补全。请再检查光标处能否自然续写或纠错；确实没有合适建议时返回 null。";
  } catch (error) {
    feedback = error.message + "。请核对三个字段和可编辑后文，无法给出可靠修改时返回 null。";
  }
  signal?.throwIfAborted();
  messages.push({ role: "assistant", content: first }, { role: "user", content: feedback });
  return completionEdit(await request(), input.editableAfter);
}
