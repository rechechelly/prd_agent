import { DOMSerializer, Slice } from "@tiptap/pm/model";
import { closeHistory } from "@tiptap/pm/history";
import { TextSelection } from "@tiptap/pm/state";
import { editOnlineFileBody } from "../../shared/online-file-edit.mjs";
import { api, flush, online } from "../service";
import { selectedModel } from "../workspace/providers";
import { toast } from "../shared";

const doubleTabMs = 280;

// The browser's Tab default cannot be replayed asynchronously. Give editor
// keymaps first refusal (table navigation, list indentation), then move focus.
function focusAfterEditor(root) {
  const controls = Array.from(document.querySelectorAll(
    'a[href], button, input, select, textarea, summary, [contenteditable="true"], [tabindex]',
  )).filter(el => !el.matches(":disabled") && el.tabIndex >= 0 &&
    !el.closest("[inert]") && el.getClientRects().length && getComputedStyle(el).visibility !== "hidden");
  const next = controls.find(el => !root.contains(el) &&
    (root.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING));
  (next || controls.find(el => !root.contains(el)))?.focus();
}

function offlineSuggestion(before, previous, inCode, title) {
  if (inCode) return previous ? "// 校验输入后返回结果" : "// 在这里处理输入";
  const topic = /筛选|下拉/.test(before) ? "筛选条件" : /枚举|字段/.test(before) ? "字段定义" : title;
  return previous?.startsWith("**")
    ? "- 确认「" + topic + "」的适用范围。\n- 补充边界情况的验收示例。"
    : "**验收条件**：确认「" + topic + "」的正常结果和空状态。";
}

function markdownInsertion(editor, source, $from, preview) {
  // A leading line break separates the suggestion from text already in the editor.
  // Parse the remaining Markdown on its own so the separator doesn't add an empty block.
  const separator = /^[ \t]*\r?\n(?:[ \t]*\r?\n)?/.exec(source);
  const markdown = separator ? source.slice(separator[0].length) : source;
  const blocks = editor.schema.nodeFromJSON(editor.markdown.parse(markdown)).content;
  preview.append(DOMSerializer.fromSchema(editor.schema).serializeFragment(blocks));
  const beginsWithParagraph = blocks.firstChild?.type.name === "paragraph";
  if (!separator && blocks.childCount === 1 && beginsWithParagraph) {
    const inline = blocks.firstChild.content;
    if (inline.childCount === 1 && inline.firstChild.isText && !inline.firstChild.marks.length)
      return inline.firstChild.text;
    return new Slice(inline, 0, 0);
  }
  // Only a prose continuation joins the left edge. Close the right edge so an
  // inserted section cannot take the rest of the original paragraph into its last block.
  const joinLeft = !separator && beginsWithParagraph && $from.parentOffset > 0;
  return new Slice(blocks, joinLeft ? 1 : 0, 0);
}

function blockPathAt($from) {
  const names = [];
  for (let depth = 1; depth <= $from.depth; depth++) {
    const node = $from.node(depth);
    names.push(node.type.name === "heading" ? "H" + node.attrs.level : node.type.name);
  }
  return names.join(" / ");
}

export function documentCompletion({ getEditor, getDocument, enabled, popup, scrollport }) {
  let delay, firstTab, controller, candidate, previous, composing = false;
  let replay;
  function cancelTab() {
    clearTimeout(firstTab);
    firstTab = undefined;
  }
  function clear() {
    clearTimeout(delay);
    delay = undefined;
    cancelTab();
    controller?.abort();
    controller = candidate = previous = undefined;
    popup.hidden = true;
    popup.replaceChildren();
  }
  function eligible(editor) {
    return enabled() && !composing && editor?.isFocused && editor.isEditable &&
      editor.state.selection instanceof TextSelection && editor.state.selection.empty;
  }
  function place(editor, position) {
    const caret = editor.view.coordsAtPos(position);
    const viewport = scrollport.getBoundingClientRect();
    if (caret.bottom < viewport.top || caret.top > viewport.bottom) {
      popup.hidden = true;
      return;
    }
    popup.hidden = false;
    popup.style.left = Math.max(5, Math.min(caret.left, innerWidth - popup.offsetWidth - 8)) + "px";
    const below = caret.bottom + 5;
    popup.style.top = (below + popup.offsetHeight <= innerHeight - 6
      ? below : Math.max(5, caret.top - popup.offsetHeight - 5)) + "px";
  }
  function request(manual = false) {
    const rejected = manual ? candidate?.source ?? previous : undefined;
    clear();
    const editor = getEditor();
    if (!eligible(editor)) return;
    previous = rejected;
    const file = getDocument();
    const { doc: content, selection: { $from, from } } = editor.state;
    const range = { fileId: file.id, base: content, from, to: from };
    const inCode = !!$from.parent.type.spec.code;
    const token = new AbortController();
    controller = token;
    const current = () => !token.signal.aborted && getEditor() === editor && eligible(editor) &&
      file === getDocument() && editor.state.doc === content && editor.state.selection.from === from;
    async function generate() {
      delay = undefined;
      if (!current()) return;
      const before = content.textBetween(Math.max(0, from - 3500), from, "\n");
      const after = content.textBetween(from, Math.min(content.content.size, from + 1000), "\n");
      try {
        popup.textContent = manual ? "正在生成补全…" : "正在自动补全…";
        place(editor, from);
        if (online) await flush();
        if (!current()) return;
        const source = online ? (await api("agent", {
          mode: "complete", doc: file.id, before, after,
          blockPath: blockPathAt($from), atBlockEnd: $from.parentOffset === $from.parent.content.size,
          modelId: selectedModel("completion"), previous: rejected,
          codeLanguage: inCode ? $from.parent.attrs.language || "" : undefined,
        }, token.signal)).text : offlineSuggestion(before, rejected, inCode, file.title);
        if (!current()) return;
        const body = document.createElement("div");
        body.className = "completionBody";
        if (inCode) {
          const fenced = source.match(/^\s*(`{3,}|~{3,})[^\n]*\r?\n([\s\S]*?)\r?\n\1\s*$/);
          const code = fenced ? fenced[2] : source;
          const pre = document.createElement("pre");
          pre.textContent = code;
          body.append(pre);
          candidate = { source, range, content: code, current };
        } else {
          candidate = { source, range, content: markdownInsertion(editor, source, $from, body), current };
        }
        const hint = document.createElement("small");
        hint.textContent = "Tab 采纳 · 双击 Tab 换一版";
        popup.replaceChildren(body, hint);
        place(editor, from);
      } catch (error) {
        if (!token.signal.aborted) {
          if (manual) {
            clear();
            toast(error.message);
          } else if (current()) {
            popup.textContent = "自动补全失败 · " + error.message;
            place(editor, from);
          }
        }
      }
    }
    if (manual) void generate();
    else delay = setTimeout(generate, 550);
  }
  function accept(editor, result) {
    if (candidate !== result || !result.current()) return;
    const tr = closeHistory(editor.state.tr);
    editOnlineFileBody(getDocument().id, tr.doc, result, (from, to, content) => {
      if (typeof content === "string") tr.insertText(content, from, to);
      else TextSelection.create(tr.doc, from, to).replace(tr, content);
    });
    editor.view.dispatch(tr.scrollIntoView());
    clear();
  }
  function handleKey(view, event) {
    if (event === replay) return false;
    if (event.key !== "Tab" || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey ||
        event.isComposing || !eligible(getEditor())) {
      cancelTab();
      if (event.key === "Escape" || event.key.startsWith("Arrow")) clear();
      return false;
    }
    event.preventDefault();
    if (event.repeat) return true;
    if (firstTab !== undefined) {
      request(true);
    } else {
      const result = popup.hidden ? undefined : candidate;
      firstTab = setTimeout(() => {
        firstTab = undefined;
        if (!eligible(getEditor())) return;
        if (result) accept(getEditor(), result);
        else {
          replay = event;
          try {
            if (!view.someProp("handleKeyDown", handler => handler(view, event))) focusAfterEditor(view.dom);
          } finally { replay = undefined; }
        }
      }, doubleTabMs);
    }
    return true;
  }
  function selectionChanged() {
    // A browser may settle the caret in a separate transaction after input.
    if (delay !== undefined) request();
    else clear();
  }
  function reposition() {
    const editor = getEditor();
    if (popup.hasChildNodes() && eligible(editor))
      place(editor, editor.state.selection.from);
  }
  return { clear, request, handleKey, selectionChanged, reposition, composition(active) {
    composing = active;
    if (active) clear(); else request();
  } };
}
