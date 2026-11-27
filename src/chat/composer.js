import { Editor } from "@tiptap/core";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { TableKit } from "@tiptap/extension-table";
import { Markdown } from "@tiptap/markdown";
import { Slice } from "@tiptap/pm/model";
import { EditorState, Selection, TextSelection } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import { Marked, Tokenizer } from "marked";
import { $ } from "../shared";

function literal(token) {
  return token && { type: "text", raw: token.raw, text: token.raw.replaceAll("&", "&amp;") };
}

// Agent prompts often contain HTML source. Keep raw tags and image references as
// text; the document editor has its own Markdown parser and image behavior.
class ComposerTokenizer extends Tokenizer {
  html(source) {
    const token = super.html(source);
    if (!token) return;
    const text = token.raw.replace(/\n+$/, "");
    return { type: "paragraph", raw: token.raw, text, tokens: [literal({raw: text})] };
  }
  tag(source) { return literal(super.tag(source)); }
  link(source) {
    const token = super.link(source);
    return token?.type === "image" ? literal(token) : token;
  }
  reflink(source, links) {
    const token = super.reflink(source, links);
    return token?.type === "image" ? literal(token) : token;
  }
}

export function installComposer(ask) {
  const form = $("askForm"), input = $("question"), grip = $("composerGrip");
  const storageKey = "xuye.composerHeight";
  let height = Number(localStorage.getItem(storageKey)) || 70;
  function resize(value) {
    const maximum = Math.max(62, Math.min(540, Math.floor(innerHeight * 0.52)));
    height = Math.max(62, Math.min(maximum, value));
    form.style.setProperty("--question-height", height + "px");
    grip.setAttribute("aria-valuenow", height);
    grip.setAttribute("aria-valuemax", maximum);
  }
  resize(height);
  grip.onpointerdown = event => {
    if (event.button !== 0) return;
    const initial = height, top = event.clientY;
    grip.setPointerCapture(event.pointerId);
    grip.onpointermove = move => resize(initial + top - move.clientY);
    grip.onlostpointercapture = () => {
      grip.onpointermove = null;
      localStorage.setItem(storageKey, height);
    };
  };
  grip.onkeydown = event => {
    if (!["ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    resize(height + (event.key === "ArrowUp" ? 16 : -16));
    localStorage.setItem(storageKey, height);
  };
  window.addEventListener("resize", () => resize(height));
  let placeholder = input.dataset.placeholder || "提问或描述想修改的内容…";
  let compositionEnded = -Infinity;
  // Pass an unmodified Enter to the editor's own list, heading and code keymaps.
  const split = new KeyboardEvent("keydown", { key: "Enter", code: "Enter" });
  const parser = new Marked().setOptions({ tokenizer: new ComposerTokenizer() });
  const editor = new Editor({
    element: input,
    enablePasteRules: false,
    extensions: [
      StarterKit.configure({ link: { openOnClick: false, autolink: false, linkOnPaste: false }, trailingNode: false }),
      TaskList, TaskItem.configure({ nested: true }), TableKit, Markdown.configure({ marked: parser }),
    ],
    editorProps: {
      attributes: state => ({
        role: "textbox",
        "aria-label": "向写作助手提问",
        "aria-multiline": "true",
        "aria-placeholder": placeholder,
        "data-placeholder": placeholder,
        "data-empty": String(state.doc.childCount === 1 && state.doc.firstChild.type.name === "paragraph" && !state.doc.firstChild.content.size),
      }),
      handleDOMEvents: {
        compositionend() { compositionEnded = performance.now(); return false; },
        keydown(view, e) {
          if (e.key !== "Enter") return false;
          if (e.isComposing || view.composing || e.keyCode === 229) return true;
          // Some IMEs emit compositionend just before the Enter that confirms a candidate.
          if (!e.shiftKey && performance.now() - compositionEnded < 40) {
            compositionEnded = -Infinity;
            e.preventDefault();
            return true;
          }
          return false;
        },
        paste(view, event) {
          const data = event.clipboardData;
          if (!data) return false;
          event.preventDefault();
          // The surrounding composer receives the same event for clipboard file attachments.
          const text = data.getData("text/markdown") || data.getData("text/plain");
          if (!text) return true;
          const { state } = view;
          const tr = state.tr;
          if (state.selection.$from.parent.type.spec.code) {
            tr.insertText(text.replace(/\r\n?/g, "\n"));
          } else {
            const parsed = state.schema.nodeFromJSON(editor.markdown.parse(text));
            const inline = parsed.childCount === 1 && parsed.firstChild.type.name === "paragraph";
            tr.replaceSelection(new Slice(inline ? parsed.firstChild.content : parsed.content, 0, 0));
          }
          view.dispatch(tr.setMeta("paste", true).setMeta("uiEvent", "paste").scrollIntoView());
          return true;
        },
      },
      clipboardTextSerializer(slice) {
        return editor.markdown.serialize({ type: "doc", content: slice.content.toJSON() || [] });
      },
      handleKeyDown(view, e) {
        if (e.key !== "Enter" || e === split) return false;
        if (e.shiftKey) return !!view.someProp("handleKeyDown", handler => handler(view, split));
        form.requestSubmit();
        return true;
      },
    },
  });
  function getText() {
    if (editor.isEmpty) return "";
    const { doc } = editor.state, first = doc.firstChild;
    if (doc.childCount === 1 && first.type.name === "paragraph" &&
        first.childCount === 1 && first.firstChild.isText && !first.firstChild.marks.length)
      return first.textContent;
    return editor.getMarkdown();
  }
  function setText(text) {
    const { schema, plugins } = editor.state;
    const doc = text ? schema.nodeFromJSON(editor.markdown.parse(text)) : schema.topNodeType.createAndFill();
    // Sending or replacing a draft starts a new undo history.
    editor.view.updateState(EditorState.create({ schema, doc, selection: Selection.atEnd(doc), plugins }));
  }
  function getDraft() {
    const view = editor.view, state = view.state;
    const selection = view.dom.ownerDocument.getSelection();
    // The browser can move the caret just before its selectionchange reaches ProseMirror.
    if (state.selection instanceof TextSelection && selection?.anchorNode && selection.focusNode &&
        view.dom.contains(selection.anchorNode) && view.dom.contains(selection.focusNode)) {
      const anchor = view.posAtDOM(selection.anchorNode, selection.anchorOffset);
      const head = view.posAtDOM(selection.focusNode, selection.focusOffset);
      if (anchor !== state.selection.anchor || head !== state.selection.head)
        return state.apply(state.tr.setSelection(TextSelection.between(state.doc.resolve(anchor), state.doc.resolve(head))));
    }
    return state;
  }
  form.onsubmit = event => {
    event.preventDefault();
    const text = getText();
    if (text.trim()) ask(text);
  };
  return {
    getText,
    setText,
    getDraft,
    setDraft(state) { if (state) editor.view.updateState(state); else setText(""); },
    focus() { editor.commands.focus(); },
    setPlaceholder(value) {
      placeholder = value;
      editor.view.updateState(editor.state);
    },
  };
}
