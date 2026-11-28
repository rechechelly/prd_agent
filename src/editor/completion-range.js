import { DOMSerializer, Slice } from "@tiptap/pm/model";

// Editable text stops at embedded objects and container boundaries. Each offset
// points back into the original document, including across paragraph breaks.
export function completionSuffix($from) {
  const positions = [$from.pos];
  let text = "", boundary, parent = $from.parent, offset = $from.parentOffset, start = $from.start();
  const siblings = $from.node(-1);
  let index = $from.index(-1);
  while (parent && parent.isTextblock) {
    parent.forEach((child, at) => {
      if (boundary || at + child.nodeSize <= offset || text.length >= 1000) return;
      const value = child.isText ? child.text : child.type.name === "hardBreak" ? "\n" : null;
      if (value === null) { boundary = child.type.name; return; }
      const left = Math.max(0, offset - at);
      const piece = value.slice(left, left + 1000 - text.length);
      text += piece;
      for (let i = 1; i <= piece.length; i++) positions.push(start + at + left + i);
    });
    const next = siblings.maybeChild(++index);
    if (boundary || text.length >= 1000 || !next) break;
    if (!next.isTextblock || !parent.sameMarkup(next)) { boundary = next.type.name; break; }
    start += parent.nodeSize;
    text += "\n";
    positions.push(start);
    parent = next;
    offset = 0;
  }
  return { text, positions, boundary };
}

export function blockPathAt($from) {
  const names = [];
  for (let depth = 1; depth <= $from.depth; depth++) {
    const node = $from.node(depth);
    names.push(node.type.name === "heading" ? "H" + node.attrs.level : node.type.name);
  }
  return names.join(" / ");
}

// Build the accepted slice and its preview from the same Markdown parse.
export function markdownInsertion(editor, source, $from, preview) {
  const separator = /^[ \t]*\r?\n(?:[ \t]*\r?\n)?/.exec(source);
  const markdown = separator ? source.slice(separator[0].length) : source;
  const blocks = editor.schema.nodeFromJSON(editor.markdown.parse(markdown)).content;
  const beginsWithParagraph = blocks.firstChild?.type.name === "paragraph";
  if (!separator && blocks.childCount === 1 && beginsWithParagraph) {
    const inline = blocks.firstChild.content;
    preview.append(DOMSerializer.fromSchema(editor.schema).serializeFragment(inline));
    if (inline.childCount === 1 && inline.firstChild.isText && !inline.firstChild.marks.length)
      return inline.firstChild.text;
    return new Slice(inline, 0, 0);
  }
  preview.classList.add("completionBlocks");
  preview.append(DOMSerializer.fromSchema(editor.schema).serializeFragment(blocks));
  return new Slice(blocks, !separator && beginsWithParagraph && $from.parentOffset > 0 ? 1 : 0, 0);
}
