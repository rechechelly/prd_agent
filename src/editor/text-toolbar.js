import { AllSelection, TextSelection } from "@tiptap/pm/state";

export function installTextToolbar(editor, button, blocks, quoteSelection) {
  const root = editor.view.dom;
  const bar = document.createElement("div");
  bar.className = "textSelectionBar";
  bar.setAttribute("role", "toolbar");
  bar.ariaLabel = "选中文字样式";
  bar.hidden = true;
  document.body.append(bar);
  for (const [mark, name, symbol] of [
    ["bold", "加粗", "B"],
    ["italic", "斜体", "I"],
    ["strike", "删除线", "S"],
    ["underline", "下划线", "U"],
    ["code", "行内代码", "</>"],
  ]) {
    const control = button(name, symbol, () => {
      const { selection } = editor.state;
      if (blocks.range) return blocks.apply(mark);
      if (
        (selection instanceof TextSelection ||
          selection instanceof AllSelection) &&
        !selection.empty
      )
        editor.chain().focus().toggleMark(mark).run();
    });
    control.dataset.mark = mark;
    bar.append(control);
  }
  const remove = button("删除所选内容", "删除", () => blocks.apply(null));
  bar.append(remove, button("针对选区提问", "问 Agent", () => quoteSelection(blocks.range || editor.state.selection)));
  function refresh() {
    const { selection } = editor.state;
    const native = window.getSelection();
    const bounds = root.closest("#paperScroll").getBoundingClientRect();
    bar.hidden = true;
    if (
      !root.getClientRects().length ||
      blocks.dragging ||
      (!editor.view.hasFocus() && !bar.contains(document.activeElement))
    )
      return;
    const range = blocks.range;
    remove.hidden = !range;
    let rect;
    if (range) {
      const targets = [...root.querySelectorAll(":scope > .marqueeSelected")];
      rect = targets
        .map((el) => el.getBoundingClientRect())
        .find((r) => r.bottom > bounds.top && r.top < bounds.bottom);
    } else if (selection instanceof AllSelection) {
      rect = root.getBoundingClientRect();
    } else if (
      selection instanceof TextSelection &&
      !selection.empty &&
      native.rangeCount &&
      !native.isCollapsed &&
      root.contains(native.anchorNode) &&
      root.contains(native.focusNode)
    ) {
      rect = native.getRangeAt(0).getBoundingClientRect();
    }
    if (!rect?.height || rect.bottom <= bounds.top || rect.top >= bounds.bottom)
      return;
    bar.hidden = false;
    const x = (rect.left + rect.right - bar.offsetWidth) / 2;
    bar.style.left =
      Math.max(
        bounds.left + 3,
        Math.min(x, bounds.right - bar.offsetWidth - 3),
      ) + "px";
    const above = rect.top - bar.offsetHeight - 6;
    bar.style.top =
      (above >= bounds.top
        ? above
        : selection instanceof AllSelection || range
          ? bounds.top + 4
          : Math.min(rect.bottom + 6, bounds.bottom - bar.offsetHeight)) + "px";
    for (const b of bar.querySelectorAll("[data-mark]")) {
      const mark = b.dataset.mark;
      if (!range) {
        b.setAttribute("aria-pressed", editor.isActive(mark));
        continue;
      }
      let has = false,
        missing = false;
      editor.state.doc.nodesBetween(range.from, range.to, (node) => {
        if (node.isText) {
          if (editor.schema.marks[mark].isInSet(node.marks)) has = true;
          else missing = true;
        }
      });
      b.setAttribute("aria-pressed", has && !missing);
    }
  }
  let frame;
  function schedule() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(refresh);
  }
  editor.on("transaction", schedule);
  document.addEventListener("pointerup", schedule);
  document.addEventListener("selectionchange", schedule);
  document.addEventListener("focusin", schedule);
  document.addEventListener("scroll", schedule, true);
  window.addEventListener("resize", schedule);
}
