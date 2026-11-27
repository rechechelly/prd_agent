import { closeHistory } from "@tiptap/pm/history";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { editOnlineFileBody } from "../../shared/online-file-edit.mjs";
import { api, flush, online } from "../service";
import { selectedModel } from "../workspace/providers";
import { toast } from "../shared";
import { blockPathAt, completionSuffix } from "./completion-range";

// Tab's browser default can't be replayed after waiting for the second key.
function normalTab(view, event) {
  if (view.someProp("handleKeyDown", handler => handler(view, event))) return;
  const controls = [...document.querySelectorAll('a[href],button,input,select,textarea,summary,[contenteditable=true],[tabindex]')]
    .filter(el => !el.matches(":disabled") && el.tabIndex >= 0 && !el.closest("[inert]") &&
      el.getClientRects().length && getComputedStyle(el).visibility !== "hidden" && !view.dom.contains(el));
  (controls.find(el => view.dom.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) || controls[0])?.focus();
}

function offlineEdit(context, title) {
  const { previous, codeLanguage, before } = context;
  const insert = codeLanguage === "html"
    ? (previous?.insert.includes("section") ? "<p></p>" : "<section></section>")
    : typeof codeLanguage === "string"
      ? (previous?.insert.includes("校验") ? "// 处理输入" : "// 校验输入")
      : previous?.insert.startsWith("**")
        ? "\n- 确认适用范围。\n- 补充边界情况的验收示例。"
        : "**验收条件**：确认「" + (/筛选/.test(before) ? "筛选条件" : title) + "」的正常结果和空状态。";
  return { keep: "", remove: "", insert };
}

export function editorCompletion({ getFile, enabled, markdown, status }) {
  const key = new PluginKey("inlineCompletion");
  let view, debounce, tab, controller, candidate, previous, composing = false, accepting = false;
  function reset() {
    clearTimeout(debounce);
    clearTimeout(tab);
    debounce = tab = undefined;
    controller?.abort();
    if (controller) status("");
    controller = candidate = previous = undefined;
  }
  function clear() {
    reset();
    if (view && key.getState(view.state) !== DecorationSet.empty)
      view.dispatch(view.state.tr.setMeta(key, DecorationSet.empty));
  }
  function eligible() {
    return enabled() && view?.hasFocus() && view.editable && !view.composing && !composing &&
      view.state.selection instanceof TextSelection && view.state.selection.empty;
  }
  async function generate(manual) {
    debounce = undefined;
    const last = manual ? candidate?.edit || previous : undefined;
    clear();
    if (!eligible()) return;
    previous = last;
    const token = controller = new AbortController();
    const file = getFile(), { doc: base, selection: { $from, from } } = view.state;
    const suffix = completionSuffix($from);
    const code = !!$from.parent.type.spec.code;
    const context = {
      before: base.textBetween(Math.max(0, from - 3501), from, "\n", "\n").slice(-3500),
      after: base.textBetween(from, Math.min(base.content.size, from + 1001), "\n", "\n").slice(0, 1000),
      editableAfter: suffix.text, blockPath: blockPathAt($from),
      atBlockEnd: $from.parentOffset === $from.parent.content.size,
      codeLanguage: code ? (markdown ? $from.parent.attrs.language || "" : "html") : undefined,
      modelId: selectedModel("completion"), previous: last,
    };
    const current = () => !token.signal.aborted && eligible() && file === getFile() &&
      view.state.doc === base && view.state.selection.from === from;
    try {
      status("正在补全…");
      if (online) await flush();
      if (!current()) return;
      const edit = online ? (await api("agent", { mode: "complete", doc: file.id, ...context }, token.signal)).edit
        : offlineEdit(context, file.title);
      if (!current()) return;
      if (!edit || !suffix.text.startsWith(edit.keep + edit.remove)) throw Error("建议与原文不符，请重新生成");
      const start = suffix.positions[edit.keep.length], end = suffix.positions[edit.keep.length + edit.remove.length];
      const decorations = [];
      if (start < end) {
        decorations.push(Decoration.inline(start, end, { "data-inline-delta": "remove" }));
        // A paragraph boundary has no text node to strike through.
        for (let i = edit.keep.length; i < edit.keep.length + edit.remove.length; i++) {
          if (suffix.positions[i + 1] - suffix.positions[i] > 1) decorations.push(Decoration.widget(suffix.positions[i], () => {
            const boundary = document.createElement("span");
            boundary.dataset.inlineDelta = "remove";
            boundary.textContent = "↵";
            return boundary;
          }, { side: 1 }));
        }
      }
      let content = edit.insert;
      if (content) {
        const added = document.createElement("span");
        added.dataset.inlineDelta = "add";
        added.className = "completionAddition";
        if (code) added.textContent = content;
        else content = markdown(content, base.resolve(start), added);
        decorations.push(Decoration.widget(end, added, { side: 1, ignoreSelection: true }));
      }
      candidate = { edit, current, range: { fileId: file.id, base, from: start, to: end }, content };
      view.dispatch(view.state.tr.setMeta(key, DecorationSet.create(base, decorations)));
      status("Tab 采纳");
    } catch (e) {
      if (current()) {
        status("补全失败", e.message);
        if (manual) toast(e.message);
      }
    }
  }
  function schedule() {
    if (eligible()) debounce = setTimeout(() => generate(false), 550);
  }
  function accept(result) {
    if (result !== candidate || !result.current()) return;
    const tr = closeHistory(view.state.tr);
    editOnlineFileBody(getFile().id, tr.doc, result, (from, to, content) => {
      if (typeof content === "string") tr.insertText(content, from, to);
      else TextSelection.create(tr.doc, from, to).replace(tr, content);
      tr.setSelection(TextSelection.near(tr.doc.resolve(tr.mapping.map(to)), -1));
    });
    reset();
    accepting = true;
    try { view.dispatch(tr.setMeta(key, DecorationSet.empty).scrollIntoView()); }
    finally { accepting = false; }
  }
  function keydown(_, event) {
    if (event.key === "Escape") { clear(); return false; }
    if (event.key !== "Tab" || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey || event.isComposing || !eligible()) {
      clearTimeout(tab);
      tab = undefined;
      return false;
    }
    event.preventDefault();
    if (event.repeat) return true;
    if (tab !== undefined) void generate(true);
    else {
      clearTimeout(debounce);
      debounce = undefined;
      const result = candidate;
      tab = setTimeout(() => {
        tab = undefined;
        if (!eligible()) return;
        if (result) accept(result);
        else normalTab(view, event);
      }, 280);
    }
    return true;
  }
  const plugin = new Plugin({
    key,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, current, old) {
        return tr.getMeta(key) ?? (tr.docChanged || !tr.selection.eq(old.selection) ? DecorationSet.empty : current);
      },
    },
    props: {
      decorations: state => key.getState(state),
      handleDOMEvents: {
        keydown, blur: () => { clear(); return false; },
        pointerdown: () => { clear(); return false; },
        compositionstart: () => { composing = true; clear(); return false; },
        compositionend: () => {
          composing = false;
          reset();
          // ProseMirror finalizes the native composition after this event handler.
          debounce = setTimeout(schedule, 0);
          return false;
        },
      },
    },
    view(editorView) {
      view = editorView;
      return { update(_, old) {
        const { doc, selection } = view.state;
        const changed = doc !== old.doc;
        if (!changed && selection.eq(old.selection)) return;
        const reschedule = debounce !== undefined;
        reset();
        if (!accepting && (changed || reschedule)) schedule();
      }, destroy() { reset(); view = undefined; } };
    },
  });
  return { plugin, clear };
}
