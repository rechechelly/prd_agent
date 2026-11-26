import { diffArrays } from "diff";
import { $, esc } from "../shared";

export const emptyHtml = (title) => `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
</head>
<body>
  <p>请编辑你的 HTML 文档</p>
</body>
</html>
`;

const lines = (value) => value.match(/[^\r\n]*(?:\r\n|\n|\r)|[^\r\n]+$/g) || [];

// Keep original line endings, scripts and whitespace when accepting individual hunks.
export function sourceEdits(base, proposed) {
  const left = lines(base),
    right = lines(proposed);
  const parts = diffArrays(left, right, { maxEditLength: 600 }) || [
    { removed: true, value: left },
    { added: true, value: right },
  ];
  const chunks = [];
  let count = 0,
    current;
  for (const part of parts) {
    if (!part.added && !part.removed) {
      current = null;
      chunks.push({ text: part.value.join("") });
      continue;
    }
    if (!current) {
      current = { id: count++, before: "", after: "" };
      chunks.push(current);
    }
    current[part.added ? "after" : "before"] += part.value.join("");
  }
  return {
    count,
    content(choice) {
      return chunks
        .map((c) => c.text ?? (choice(c.id) === "keep" ? c.after : c.before))
        .join("");
    },
    preview(choices) {
      const body = document.createDocumentFragment();
      function add(value, kind, id) {
        if (!value) return;
        const span = document.createElement("span");
        span.className = "sourceLines";
        span.textContent = value;
        if (kind) {
          span.dataset.inlineDelta = kind;
          span.dataset.inlineChange = id;
        }
        body.append(span);
      }
      for (const c of chunks) {
        if (c.text !== undefined) add(c.text);
        else if (choices[c.id])
          add(choices[c.id] === "keep" ? c.after : c.before);
        else {
          add(c.before, "remove", c.id);
          add(c.after, "add", c.id);
        }
      }
      return { body };
    },
  };
}

export function installHtmlSource(onEdit) {
  const input = $("htmlInput"),
    paint = $("htmlPaint"),
    nums = $("htmlLineNumbers");
  function syncScroll() {
    paint.scrollTop = nums.scrollTop = input.scrollTop;
    paint.scrollLeft = input.scrollLeft;
  }
  function highlight() {
    const text = input.value;
    nums.textContent = Array.from(
      { length: text.split("\n").length },
      (_, i) => i + 1,
    ).join("\n");
    const parts = document.createDocumentFragment();
    const syntax =
      /<!--[\s\S]*?(?:-->|$)|<!doctype[^>]*>|<\/?[\w:-]+|\b[\w:-]+(?=\s*=)|"(?:[^"\n]*)"|'(?:[^'\n]*)'/gi;
    let from = 0;
    for (const match of text.matchAll(syntax)) {
      parts.append(text.slice(from, match.index));
      const token = document.createElement("span");
      token.className = match[0].startsWith("<!--")
        ? "codeComment"
        : match[0][0] === "<"
          ? "codeTag"
          : /^['"]/.test(match[0])
            ? "codeString"
            : "codeAttr";
      token.textContent = match[0];
      parts.append(token);
      from = match.index + match[0].length;
    }
    parts.append(text.slice(from) + "\n");
    paint.replaceChildren(parts);
    syncScroll();
  }
  input.oninput = () => {
    highlight();
    onEdit(input.value);
  };
  input.onscroll = syncScroll;
  input.onkeydown = (e) => {
    if (
      e.key === "Tab" &&
      !e.shiftKey &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey
    ) {
      e.preventDefault();
      document.execCommand("insertText", false, "  ");
    }
  };
  return (source, reset = false) => {
    if (reset || input.value !== source.replace(/\r\n?/g, "\n")) {
      input.value = source;
      if (reset) {
        input.setSelectionRange(0, 0);
        input.scrollTop = input.scrollLeft = 0;
      }
      highlight();
    }
  };
}
