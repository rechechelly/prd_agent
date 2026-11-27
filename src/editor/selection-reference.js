// Serialize markers in an isolated transaction. The live selection and undo history stay intact.
import { DOMSerializer, DOMParser as SchemaParser } from "@tiptap/pm/model";
import { elementFromString } from "@tiptap/core";
import { diffChars } from "diff";

function sourceOffset(parts, offset, rightEdge) {
  let canonical = 0, source = 0;
  for (const part of parts) {
    const length = part.value.length;
    if (!part.added && !part.removed &&
        (rightEdge ? offset > canonical && offset <= canonical + length
                   : offset >= canonical && offset < canonical + length))
      return source + offset - canonical;
    if (!part.added) canonical += length;
    if (!part.removed) source += length;
  }
}

export function documentRange(editor, source, selection) {
  const { doc, schema } = editor.state;
  const pieces = [];
  doc.nodesBetween(selection.from, selection.to, (node, pos) => {
    if (node.isText) pieces.push({
      from: Math.max(selection.from, pos), to: Math.min(selection.to, pos + node.nodeSize), marks: node.marks,
    });
  });
  const first = pieces[0], last = pieces.at(-1);
  if (!first) throw Error("请选择有文字的内容");
  const startMark = crypto.randomUUID(), endMark = crypto.randomUUID();
  const tx = editor.state.tr;
  tx.insert(last.to, schema.text(endMark, last.marks));
  tx.insert(first.from, schema.text(startMark, first.marks));
  const wrapper = document.createElement("div");
  wrapper.append(DOMSerializer.fromSchema(schema).serializeFragment(tx.doc.content));
  const marked = wrapper.innerHTML;
  let start = marked.indexOf(startMark), end = marked.indexOf(endMark) - startMark.length;
  const canonical = marked.replace(startMark, "").replace(endMark, "");
  if (canonical !== source) {
    // A large unrelated table or image after the selection needs no diff.
    if (!source.startsWith(canonical.slice(0, end))) {
      if (source.endsWith(canonical.slice(start))) {
        const offset = source.length - canonical.length;
        start += offset;
        end += offset;
      } else {
        const parts = diffChars(canonical, source, { maxEditLength: 3000, timeout: 250 }) || [];
        start = sourceOffset(parts, start, false);
        end = sourceOffset(parts, end, true);
      }
    }
    if (start == null || end == null)
      throw Error("暂时无法定位这段原文，请在编辑器中重新选择。");
    const candidate = source.slice(0, start) + startMark + source.slice(start, end) + endMark + source.slice(end);
    const parsed = SchemaParser.fromSchema(schema).parse(elementFromString(candidate));
    // Check both markers at their exact editor positions. The editor may have added
    // a trailing paragraph after an imported list or table outside this range.
    const markedTo = last.to + startMark.length + endMark.length;
    if (markedTo > parsed.content.size ||
        !parsed.slice(first.from, markedTo).eq(tx.doc.slice(first.from, markedTo)))
      throw Error("暂时无法定位这段原文，请在编辑器中重新选择。");
  }
  return { start, end, text: doc.textBetween(first.from, last.to, "\n") };
}

export function rawRange(input, source) {
  const { selectionStart, selectionEnd } = input;
  if (selectionStart === selectionEnd) throw Error("请选择 HTML 源码");
  // Textareas normalize CRLF. File offsets always refer to the stored UTF-16 string.
  const offset = (index) => {
    let raw = index;
    for (const match of source.matchAll(/\r\n/g)) {
      if (match.index >= raw) break;
      raw++;
    }
    return raw;
  };
  return { start: offset(selectionStart), end: offset(selectionEnd), text: input.value.slice(selectionStart, selectionEnd) };
}

export async function rangeReference(file, range, source) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  return { kind: "range", id: file.id, title: file.title, ...range,
    digest: Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, "0")).join("") };
}
