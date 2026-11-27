// The snapshot defines the coordinate system: UTF-16 offsets for source strings,
// ProseMirror positions for rich text. Never translate one by counting visible text.
export function editOnlineFileBody(fileId, body, { range, content, oldText, append }, replaceRange) {
  if (range && (range.fileId !== fileId || (range.base !== undefined && range.base !== body)))
    throw Error("文件或正文已变化，请重新获取修改位置");
  const { from, to } = range ?? onlineSourceRange(body, oldText, append);
  const size = typeof body === "string" ? body.length : body.content.size;
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from || to > size)
    throw RangeError("修改位置超出正文范围");
  if (replaceRange) return replaceRange(from, to, content);
  return body.slice(0, from) + content + body.slice(to);
}

function onlineSourceRange(source, oldText, append) {
  if (oldText !== undefined) {
    const from = source.indexOf(oldText);
    if (!oldText || from < 0 || from !== source.lastIndexOf(oldText))
      throw Error("old_text 需要唯一匹配");
    return { from, to: from + oldText.length };
  }
  if (append) {
    const end = source.search(/<\/body\s*>/i);
    const from = end < 0 ? source.length : end;
    return { from, to: from };
  }
  return { from: 0, to: source.length };
}
