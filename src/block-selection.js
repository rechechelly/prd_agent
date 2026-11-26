import { AllSelection, Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { closeHistory } from "@tiptap/pm/history";

export function installBlockSelection(editor) {
  const root = editor.view.dom;
  const scroll = root.closest("#paperScroll");
  const key = new PluginKey("blockRange");
  const box = document.createElement("div");
  box.className = "blockMarquee";
  document.body.append(box);
  box.hidden = true;
  let drag, frame;
  function apply(markName) {
    const range = key.getState(editor.state);
    if (!range) return false;
    const { from, to } = range;
    const tr = closeHistory(editor.state.tr);
    if (!markName) tr.delete(from, to).setMeta(key, null);
    else {
      const mark = editor.schema.marks[markName];
      let unmarked = false;
      tr.doc.nodesBetween(from, to, (node) => {
        if (node.isText && !mark.isInSet(node.marks)) unmarked = true;
      });
      if (unmarked) tr.addMark(from, to, mark.create());
      else tr.removeMark(from, to, mark);
      tr.setMeta(key, range);
    }
    editor.view.dispatch(tr);
    editor.view.focus();
    return true;
  }
  function setRange(range) {
    const prev = key.getState(editor.state);
    if (prev?.from !== range?.from || prev?.to !== range?.to)
      editor.view.dispatch(editor.state.tr.setMeta(key, range));
  }
  editor.registerPlugin(
    new Plugin({
      key,
      state: {
        init: () => null,
        apply(tr, prev) {
          if (tr.getMeta(key) !== undefined) return tr.getMeta(key);
          return tr.docChanged ? null : prev;
        },
      },
      props: {
        decorations(state) {
          const range = key.getState(state);
          if (!range) return null;
          const items = [];
          state.doc.forEach((node, pos) => {
            if (pos >= range.from && pos < range.to)
              items.push(
                Decoration.node(pos, pos + node.nodeSize, {
                  class: "marqueeSelected",
                }),
              );
          });
          return DecorationSet.create(state.doc, items);
        },
        handleKeyDown(_view, e) {
          if (e.isComposing) return false;
          if (
            (e.ctrlKey || e.metaKey) &&
            !e.altKey &&
            !e.shiftKey &&
            e.key.toLowerCase() === "a"
          ) {
            const tr = editor.state.tr;
            editor.view.dispatch(
              tr.setMeta(key, null).setSelection(new AllSelection(tr.doc)),
            );
            return true;
          }
          if (!key.getState(editor.state)) return false;
          if (e.key === "Delete" || e.key === "Backspace") return apply(null);
          if (e.key === "Escape") {
            setRange(null);
            return true;
          }
          if (e.ctrlKey || e.metaKey) {
            const mark = { b: "bold", i: "italic", u: "underline" }[
              e.key.toLowerCase()
            ];
            if (mark) return apply(mark);
          }
          if (!["Control", "Alt", "Meta", "Shift"].includes(e.key))
            setRange(null);
          return false;
        },
      },
    }),
    (plugin, existing) => [plugin, ...existing],
  );
  function draw() {
    if (!drag) return;
    const bounds = scroll.getBoundingClientRect();
    const left = Math.min(drag.x, drag.endX),
      right = Math.max(drag.x, drag.endX);
    const startY = drag.y - (scroll.scrollTop - drag.scrollTop);
    const top = Math.min(startY, drag.endY),
      bottom = Math.max(startY, drag.endY);
    Object.assign(box.style, {
      left: left + "px",
      top: Math.max(top, bounds.top) + "px",
      width: right - left + "px",
      height:
        Math.max(
          0,
          Math.min(bottom, bounds.bottom) - Math.max(top, bounds.top),
        ) + "px",
    });
    let range = null;
    editor.state.doc.forEach((node, pos) => {
      const r = editor.view.nodeDOM(pos)?.getBoundingClientRect();
      if (
        r &&
        r.right >= left &&
        r.left <= right &&
        r.bottom >= top &&
        r.top <= bottom
      ) {
        if (!range) range = { from: pos, to: pos + node.nodeSize };
        else range.to = pos + node.nodeSize;
      }
    });
    setRange(range);
    box.hidden = false;
  }
  function tick() {
    if (!drag?.active) return;
    const b = scroll.getBoundingClientRect(),
      y = drag.endY,
      before = scroll.scrollTop;
    if (y < b.top + 24) scroll.scrollTop -= 12;
    else if (y > b.bottom - 24) scroll.scrollTop += 12;
    if (scroll.scrollTop !== before) draw();
    frame = requestAnimationFrame(tick);
  }
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (e.target.closest(".textSelectionBar")) return;
      setRange(null);
      if (
        e.button !== 0 ||
        e.pointerType === "touch" ||
        !scroll.contains(e.target) ||
        !root.getClientRects().length
      )
        return;
      if (
        e.target.closest(
          "button,input,textarea,td,th,img,[data-resize-container]",
        )
      )
        return;
      const bounds = root.getBoundingClientRect();
      if (e.clientY < bounds.top - 6 || e.clientY > bounds.bottom + 12) return;
      if (root.contains(e.target) && e.target !== root) {
        // Leave drags starting on glyphs to the browser's text selection.
        const range = document.createRange();
        range.selectNodeContents(e.target);
        if (
          [...range.getClientRects()].some(
            (r) =>
              e.clientX >= r.left - 2 &&
              e.clientX <= r.right + 2 &&
              e.clientY >= r.top &&
              e.clientY <= r.bottom,
          )
        )
          return;
      }
      if (!root.contains(e.target)) e.preventDefault();
      drag = {
        x: e.clientX,
        y: e.clientY,
        endX: e.clientX,
        endY: e.clientY,
        scrollTop: scroll.scrollTop,
        id: e.pointerId,
      };
    },
    true,
  );
  document.addEventListener("pointermove", (e) => {
    if (!drag || drag.id !== e.pointerId) return;
    drag.endX = e.clientX;
    drag.endY = e.clientY;
    if (!drag.active) {
      if (Math.hypot(drag.x - e.clientX, drag.y - e.clientY) < 5) return;
      drag.active = true;
      scroll.classList.add("selectingBlocks");
      editor.view.focus();

      scroll.setPointerCapture(e.pointerId);
      frame = requestAnimationFrame(tick);
    }
    e.preventDefault();
    draw();
  });
  function finish(e) {
    if (!drag || drag.id !== e.pointerId) return;
    const active = drag.active;
    drag = null;
    cancelAnimationFrame(frame);
    scroll.classList.remove("selectingBlocks");
    box.hidden = true;
    if (active) {
      if (e.type === "pointercancel") setRange(null);
      editor.view.focus();
    }
  }
  document.addEventListener("pointerup", finish);
  document.addEventListener("pointercancel", finish);
  return {
    get range() {
      return key.getState(editor.state);
    },
    get dragging() {
      return !!drag?.active;
    },
    apply,
  };
}
