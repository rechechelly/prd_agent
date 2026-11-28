import { AllSelection, TextSelection } from "@tiptap/pm/state";
import { installColorPicker } from "./color-picker";

function selectionRect(root) {
  const selection = window.getSelection();
  if (selection?.rangeCount && !selection.isCollapsed && root.contains(selection.anchorNode) && root.contains(selection.focusNode))
    return selection.getRangeAt(0).getBoundingClientRect();
}

function floatingToolbar(label) {
  const bar = document.createElement("div");
  bar.className = "textSelectionBar";
  bar.setAttribute("role", "toolbar");
  bar.ariaLabel = label;
  bar.hidden = true;
  document.body.append(bar);
  return bar;
}

function placeToolbar(bar, rect, bounds, pinAtTop = false) {
  if (!rect?.height || rect.bottom <= bounds.top || rect.top >= bounds.bottom) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  bar.style.maxWidth = Math.max(1, bounds.width - 6) + "px";
  const x = (Math.max(bounds.left, rect.left) + Math.min(bounds.right, rect.right) - bar.offsetWidth) / 2;
  bar.style.left = Math.max(bounds.left + 3, Math.min(x, bounds.right - bar.offsetWidth - 3)) + "px";
  const above = rect.top - bar.offsetHeight - 6;
  bar.style.top = (above >= bounds.top ? above : pinAtTop ? bounds.top + 4
    : Math.min(rect.bottom + 6, bounds.bottom - bar.offsetHeight - 3)) + "px";
}

function watchToolbar(refresh) {
  let frame;
  function schedule() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(refresh);
  }
  document.addEventListener("pointerup", schedule);
  document.addEventListener("selectionchange", schedule);
  document.addEventListener("focusin", schedule);
  document.addEventListener("scroll", schedule, true);
  window.addEventListener("resize", schedule);
  return schedule;
}

export function installSourceToolbar(view, bounds, quote) {
  const bar = floatingToolbar("所选源码");
  const ask = document.createElement("button");
  ask.type = "button";
  ask.textContent = "问 Agent";
  ask.onmousedown = event => event.preventDefault();
  ask.onclick = quote;
  bar.append(ask);
  return watchToolbar(() => {
    bar.hidden = true;
    if (!view.state.selection.empty && (view.hasFocus() || bar.contains(document.activeElement)))
      placeToolbar(bar, selectionRect(view.dom), bounds.getBoundingClientRect());
  });
}

export function installTextToolbar(editor, button, blocks, quoteSelection) {
  const root = editor.view.dom;
  const bar = floatingToolbar("选中文字样式");
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
  const refreshColors = installColorPicker(bar, editor, button, blocks);
  const remove = button("删除所选内容", "删除", () => blocks.apply(null));
  bar.append(remove, button("针对选区提问", "问 Agent", () => quoteSelection(blocks.range || editor.state.selection)));
  function refresh() {
    const { selection } = editor.state;
    const bounds = root.closest("#paperScroll").getBoundingClientRect();
    if (
      !root.getClientRects().length ||
      blocks.dragging ||
      (!editor.view.hasFocus() && !bar.contains(document.activeElement))
    ) {
      bar.hidden = true;
      refreshColors();
      return;
    }
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
    } else if (selection instanceof TextSelection && !selection.empty) {
      rect = selectionRect(root);
    }
    placeToolbar(bar, rect, bounds, selection instanceof AllSelection || range);
    refreshColors(range || selection);
    if (bar.hidden) return;
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
  editor.on("transaction", watchToolbar(refresh));
}
