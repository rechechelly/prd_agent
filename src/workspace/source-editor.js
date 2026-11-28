import { Schema } from "@tiptap/pm/model";
import { EditorState, Plugin, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet, EditorView } from "@tiptap/pm/view";
import { history, undo, redo } from "@tiptap/pm/history";
import { keymap } from "@tiptap/pm/keymap";
import { baseKeymap } from "@tiptap/pm/commands";
import { installSourceToolbar } from "../editor/text-toolbar";
import { $ } from "../shared";

const schema = new Schema({ nodes: {
  doc: { content: "source" },
  source: { content: "text*", code: true, toDOM: () => ["pre", 0], parseDOM: [{ tag: "pre", preserveWhitespace: "full" }] },
  text: {},
} });
const normalize = text => text.replace(/\r\n?/g, "\n");

function syntax(doc) {
  const spans = [];
  const tokens = /<!--[\s\S]*?(?:-->|$)|<!doctype[^>]*>|<\/?[\w:-]+|\b[\w:-]+(?=\s*=)|"(?:[^"\n]*)"|'(?:[^'\n]*)'/gi;
  for (const match of doc.textContent.matchAll(tokens)) {
    const token = match[0];
    const cls = token.startsWith("<!--") ? "codeComment" : token[0] === "<" ? "codeTag"
      : /^['"]/.test(token) ? "codeString" : "codeAttr";
    spans.push(Decoration.inline(match.index + 1, match.index + token.length + 1, { class: cls }));
  }
  return DecorationSet.create(doc, spans);
}

function sourceOffset(source, index) {
  let offset = index;
  for (const match of source.matchAll(/\r\n/g)) {
    if (match.index >= offset) break;
    offset++;
  }
  return offset;
}

// Browser selection offsets use LF. Keep original bytes on both sides of the edit.
function updateSource(original, before, after) {
  let start = 0, left = before.length, right = after.length;
  while (start < left && start < right && before[start] === after[start]) start++;
  while (left > start && right > start && before[left - 1] === after[right - 1]) { left--; right--; }
  const newline = original.match(/\r\n|\r|\n/)?.[0] || "\n";
  return original.slice(0, sourceOffset(original, start)) + after.slice(start, right).replace(/\n/g, newline)
    + original.slice(sourceOffset(original, left));
}

export function installSourceEditor({ completion, onEdit, quote }) {
  const viewport = $("htmlSourceEditor"), numbers = $("htmlLineNumbers");
  let source = "", refreshToolbar;
  const highlighting = new Plugin({
    state: { init: (_, state) => syntax(state.doc), apply: (tr, prev) => tr.docChanged ? syntax(tr.doc) : prev },
    props: { decorations: state => highlighting.getState(state) },
  });
  const plugins = [completion.plugin, highlighting, history(), keymap({
    "Mod-z": undo, "Mod-Shift-z": redo, "Mod-y": redo,
    "Mod-a": (state, dispatch) => { dispatch(state.tr.setSelection(TextSelection.create(state.doc, 1, state.doc.content.size - 1))); return true; },
    Tab: (state, dispatch) => { dispatch(state.tr.insertText("  ").scrollIntoView()); return true; },
  }), keymap(baseKeymap)];
  function stateFor(value) {
    const body = schema.node("source", null, value ? schema.text(value) : null);
    return EditorState.create({ doc: schema.node("doc", null, body), plugins });
  }
  let numberedDoc, numberedAdditions = [];
  function gutter() {
    const additions = [...view.dom.querySelectorAll(".completionAddition")];
    if (numberedDoc === view.state.doc && numberedAdditions.length === additions.length &&
        additions.every((node, i) => numberedAdditions[i] === node)) return;
    numberedDoc = view.state.doc;
    numberedAdditions = additions;
    const lines = numberedDoc.textContent.split("\n").map((_, i) => String(i + 1));
    for (const added of additions.toReversed()) {
      const count = added.textContent.split("\n").length - 1;
      const pos = view.posAtDOM(added, 0);
      const line = view.state.doc.textBetween(1, pos).split("\n").length;
      if (count) lines.splice(line, 0, ...Array(count).fill(""));
    }
    numbers.textContent = lines.join("\n");
  }
  const view = new EditorView({ mount: $("htmlInput") }, {
    state: stateFor(""),
    attributes: { role: "textbox", "aria-label": "HTML 源码", "aria-multiline": "true",
      spellcheck: "false", autocapitalize: "off", autocorrect: "off" },
    handleDoubleClick(view, pos) {
      const doc = view.state.doc, text = doc.textContent;
      const offset = Math.max(0, Math.min(pos - 1, text.length));
      const from = offset ? text.lastIndexOf("\n", offset - 1) + 1 : 0;
      const newline = text.indexOf("\n", offset);
      const to = newline < 0 ? text.length : newline;
      view.dispatch(view.state.tr.setSelection(TextSelection.create(doc, from + 1, to + 1)));
      return true;
    },
    handlePaste(view, event) {
      const text = event.clipboardData?.getData("text/plain");
      if (text == null) return false;
      if (text) view.dispatch(view.state.tr.insertText(normalize(text)).scrollIntoView());
      return true;
    },
    dispatchTransaction(tr) {
      view.updateState(view.state.apply(tr));
      if (tr.docChanged) {
        // Update each disjoint range separately so line endings between edits survive.
        for (const [i, before] of tr.docs.entries()) {
          source = updateSource(source, before.textContent, (tr.docs[i + 1] || tr.doc).textContent);
        }
        onEdit(source);
      }
      gutter();
      refreshToolbar?.();
    },
  });
  refreshToolbar = installSourceToolbar(view, viewport, quote);
  return {
    set(value, reset = false) {
      if (!reset && source === value) return;
      completion.clear();
      source = value;
      view.updateState(stateFor(normalize(value)));
      gutter();
      if (reset) viewport.scrollTop = viewport.scrollLeft = 0;
      refreshToolbar();
    },
    selection() {
      const { from, to } = view.state.selection;
      if (from === to) return null;
      const start = sourceOffset(source, Math.max(0, from - 1));
      const end = sourceOffset(source, Math.min(view.state.doc.textContent.length, to - 1));
      return { start, end, text: source.slice(start, end) };
    },
  };
}
