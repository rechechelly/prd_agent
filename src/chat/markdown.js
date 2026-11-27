import { DOMSerializer } from "@tiptap/pm/model";
import DOMPurify from "dompurify";

function markdownHTML(editor, text) {
  const node = editor.schema.nodeFromJSON(editor.markdown.parse(text));
  const container = document.createElement("div");
  container.append(
    DOMSerializer.fromSchema(editor.schema).serializeFragment(node.content),
  );
  return container.innerHTML;
}
export function renderChatMarkdown(editor, reply, value) {
  try {
    reply.innerHTML = DOMPurify.sanitize(markdownHTML(editor, value), {
      ALLOWED_TAGS: [
        "p",
        "br",
        "strong",
        "em",
        "s",
        "blockquote",
        "ul",
        "ol",
        "li",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "pre",
        "code",
        "table",
        "thead",
        "tbody",
        "tr",
        "th",
        "td",
        "hr",
        "a",
      ],
      ALLOWED_ATTR: ["href", "start"],
    });
    for (const a of reply.querySelectorAll("a")) {
      a.target = "_blank";
      a.rel = "noopener noreferrer";
    }
  } catch {
    reply.textContent = value;
  }
}
