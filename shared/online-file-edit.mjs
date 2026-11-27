// Every position belongs to the same snapshot: UTF-16 offsets for source strings,
// ProseMirror positions for editor transactions.
export function editOnlineFileBody(fileId, body, edits, replaceRange) {
  const size = typeof body === "string" ? body.length : body.content.size;
  const matches = edits.map(({ range, content, oldText, append }, index) => {
    if (range && (range.fileId !== fileId || (range.base !== undefined && range.base !== body)))
      throw Error("文件或正文已变化，请重新获取修改位置");
    const { from, to } = range ?? onlineSourceRange(body, oldText, append, index);
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from || to > size)
      throw RangeError("修改位置超出正文范围");
    return { from, to, content, index };
  }).sort((a, b) => a.from - b.from);
  for (let i = 1; i < matches.length; i++) {
    if (matches[i].from < matches[i - 1].to)
      throw Error(`第 ${matches[i - 1].index + 1} 项和第 ${matches[i].index + 1} 项修改重叠，请合并`);
  }
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

function onlineSourceRange(source, oldText, append, index) {
  if (oldText !== undefined) {
    const from = source.indexOf(oldText);
    if (!oldText || from < 0 || from !== source.lastIndexOf(oldText))
      throw Error(`第 ${index + 1} 项的 old_text 需要在原文中唯一匹配`);
    return { from, to: from + oldText.length };
  }
  if (append) {
    const end = source.search(/<\/body\s*>/i);
    const from = end < 0 ? source.length : end;
    return { from, to: from };
  }
  return { from: 0, to: source.length };
}
