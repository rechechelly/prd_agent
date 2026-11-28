export function textEditOperations(list, insertionRange) {
  if (!Array.isArray(list)) throw Error("修改建议需要 list 数组");
  return list.map((item, index) => {
    if (typeof item?.old_text !== "string" || typeof item.new_text !== "string")
      throw Error(`第 ${index + 1} 项需要 old_text 和 new_text 字符串`);
    if (Object.keys(item).some(key => key !== "old_text" && key !== "new_text"))
      throw Error(`第 ${index + 1} 项仅支持 old_text 和 new_text`);
    if (item.old_text === "" && insertionRange) return { range: insertionRange, content: item.new_text };
    return { oldText: item.old_text, content: item.new_text };
  });
}

const retryAtCaret = "请把光标移到目标文字前，双按 Tab 重新生成。";

// Every position belongs to one snapshot: UTF-16 offsets for source strings,
// ProseMirror positions for editor transactions.
function resolveBodyEdits(fileId, body, edits, atCaret = false) {
  const size = typeof body === "string" ? body.length : body.content.size;
  const matches = edits.map(({ range, content, oldText, append }, index) => {
    if (range && (range.fileId !== fileId || (range.base !== undefined && range.base !== body)))
      throw Error("文件或正文已变化，请重新获取修改位置");
    const { from, to } = range ?? onlineSourceRange(body, oldText, append, index, atCaret);
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from || to > size)
      throw RangeError("修改位置超出正文范围");
    return { from, to, content, index };
  }).sort((a, b) => a.from - b.from || a.to - b.to);
  for (let i = 1; i < matches.length; i++) {
    if (matches[i].from < matches[i - 1].to ||
        (matches[i].from === matches[i - 1].from && matches[i].to === matches[i - 1].to))
      throw new RangeError(`第 ${matches[i - 1].index + 1} 项和第 ${matches[i].index + 1} 项修改重叠。` +
        (atCaret ? retryAtCaret : "请合并重叠的替换。"));
  }
  return matches;
}

// A model may quote both sides of the caret. Keep only the writable part
// when the quoted text has exactly one alignment and preserves the entire left side.
function withoutCaretPrefix(edit, before, suffix, insertion) {
  const { oldText, content } = edit;
  if (!oldText || !before || suffix.includes(oldText)) return edit;
  const left = before.slice(-oldText.length);
  const window = left + suffix.slice(0, oldText.length - 1);
  const start = window.indexOf(oldText);
  if (start < 0 || window.indexOf(oldText, start + 1) >= 0) return edit;
  const prefix = left.slice(start);
  if (!content.startsWith(prefix)) return edit;
  const remaining = oldText.slice(prefix.length);
  const replacement = content.slice(prefix.length);
  return remaining ? { oldText: remaining, content: replacement } : { range: insertion, content: replacement };
}

// The suffix starts at the caret. Only completion may insert at its empty anchor.
export function cursorEdits(suffix, list, before = "") {
  const insertion = { from: 0, to: 0 };
  const edits = textEditOperations(list, insertion).map(edit => withoutCaretPrefix(edit, before, suffix, insertion));
  return resolveBodyEdits(undefined, suffix, edits, true)
    .filter(edit => suffix.slice(edit.from, edit.to) !== edit.content);
}

export function editOnlineFileBody(fileId, body, edits, replaceRange) {
  const matches = resolveBodyEdits(fileId, body, edits);
  if (replaceRange) {
    for (const { from, to, content } of matches.reverse()) replaceRange(from, to, content);
    return;
  }
  const parts = [];
  let offset = 0;
  for (const { from, to, content } of matches) {
    parts.push(body.slice(offset, from), content);
    offset = to;
  }
  parts.push(body.slice(offset));
  return parts.join("");
}

function onlineSourceRange(source, oldText, append, index, atCaret) {
  if (oldText !== undefined) {
    const field = `第 ${index + 1} 项的 old_text`;
    if (!oldText) throw new RangeError(field + " 为空。请复制目标处的非空原文。");
    const from = source.indexOf(oldText);
    const scope = atCaret ? "在光标后的可编辑文本中" : "在当前原文中";
    if (from < 0)
      throw new RangeError(`${field} ${scope}匹配 0 处。` +
        (atCaret ? retryAtCaret : "请重新读取目标片段，按原文复制空白、换行和标点。"));
    const second = source.indexOf(oldText, from + 1);
    if (second >= 0) {
      const { count, offsets } = repeatedMatches(source, oldText, from, second);
      const advice = atCaret ? retryAtCaret + "以下位置相对于光标。" :
        "请在 old_text 中补充目标前后的原文，直到仅匹配一处，并在 new_text 中原样保留这些定位文字。offset 可用于定向读取。";
      throw new RangeError(`${field} ${scope}匹配 ${count} 处。${advice}⟦ ⟧ 标记命中内容，列按 UTF-16 计。\n` +
        matchExamples(source, oldText, offsets).join("\n"));
    }
    return { from, to: from + oldText.length };
  }
  if (append) {
    const end = source.search(/<\/body\s*>/i);
    const from = end < 0 ? source.length : end;
    return { from, to: from };
  }
  return { from: 0, to: source.length };
}

function repeatedMatches(source, text, first, second) {
  const offsets = [first, second];
  let count = 2;
  // Count overlapping occurrences in linear time, including long repeated HTML blocks.
  const borders = new Uint32Array(text.length);
  function advance(matched, char) {
    while (matched && text[matched] !== char) matched = borders[matched - 1];
    return text[matched] === char ? matched + 1 : matched;
  }
  for (let i = 1; i < text.length; i++) borders[i] = advance(borders[i - 1], text[i]);
  let matched = borders[text.length - 1];
  for (let i = second + text.length; i < source.length; i++) {
    matched = advance(matched, source[i]);
    if (matched === text.length) {
      if (offsets.length < 3) offsets.push(i + 1 - text.length);
      count++;
      matched = borders[matched - 1];
    }
  }
  return { count, offsets };
}

function matchExamples(source, text, offsets) {
  const excerpt = text.length > 40 ? text.slice(0, 20) + "…" + text.slice(-20) : text;
  const breaks = source.matchAll(/\r\n|[\r\n]/g);
  let next = breaks.next().value, line = 1, lineStart = 0;
  return offsets.map(offset => {
    while (next && next.index + next[0].length <= offset) {
      lineStart = next.index + next[0].length;
      line++;
      next = breaks.next().value;
    }
    const end = offset + text.length;
    const snippet = source.slice(Math.max(0, offset - 24), offset) + "⟦" + excerpt + "⟧" + source.slice(end, end + 24);
    return `第 ${line} 行第 ${offset - lineStart + 1} 列（offset ${offset}） ${JSON.stringify(snippet)}`;
  });
}
