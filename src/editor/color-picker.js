import { closeHistory } from "@tiptap/pm/history";

const fontColors = [
  ["黑色", "#1f2329"], ["灰色", "#8e959e", "#626977"], ["红色", "#d83931", "#b42318"],
  ["橙色", "#de7802", "#ad5000"], ["黄色", "#dc9b02"], ["绿色", "#2da021", "#157347"],
  ["蓝色", "#245bdb", "#175ac2"], ["紫色", "#6424d0", "#7145a4"],
];
const backgrounds = [
  ["无", ""], ["淡灰", "#f2f3f5"], ["浅红", "#fbbfbc"], ["浅橙", "#ffddb7"],
  ["浅黄", "#fff897"], ["浅绿", "#c6f1c1"], ["浅蓝", "#cfdcfe"], ["浅紫", "#dcc9fc"],
  ["浅灰", "#e5e7e8"], ["灰色", "#bbbfc4"], ["红色", "#f76964"], ["橙色", "#ffa53d"],
  ["黄色", "#ffe928"], ["绿色", "#62d257"], ["蓝色", "#a3bdfe"], ["紫色", "#c6a9fa"],
];

export function installColorPicker(bar, editor, button, blocks) {
  const trigger = button("字体和背景颜色", "A");
  trigger.className = "colorPickerTrigger";
  const panel = document.createElement("div");
  panel.popover = "auto";
  panel.className = "colorPalette";
  panel.setAttribute("role", "dialog");
  panel.ariaLabel = trigger.ariaLabel;
  trigger.setAttribute("aria-haspopup", "dialog");
  trigger.popoverTargetElement = panel;
  bar.append(trigger, panel);

  const swatches = [];
  const cssColor = document.createElement("span").style;
  function normalize(value) {
    cssColor.color = value;
    return cssColor.color;
  }
  function apply(colors) {
    const { from, to } = blocks.range || editor.state.selection;
    const tr = closeHistory(editor.state.tr);
    for (const [name, color] of Object.entries(colors)) {
      const mark = editor.schema.marks[name];
      if (color) tr.addMark(from, to, mark.create({ color }));
      else tr.removeMark(from, to, mark);
    }
    panel.hidePopover();
    editor.view.dispatch(tr);
    editor.view.focus();
  }
  function group(label, mark, palette) {
    const heading = document.createElement("b"), grid = document.createElement("div");
    heading.textContent = label;
    grid.className = "swatchGrid";
    grid.setAttribute("role", "group");
    grid.ariaLabel = label;
    for (const [name, hex, legacy] of palette) {
      const font = mark === "textColor", color = normalize(hex);
      const item = button(label + " · " + name, font ? "A" : "", () => apply({ [mark]: color }));
      item.className = font ? "fontSwatch" : color ? "backgroundSwatch" : "clearSwatch";
      item.style.setProperty("--swatch", color);
      grid.append(item);
      swatches.push({ item, mark, color, legacy: legacy && normalize(legacy) });
    }
    panel.append(heading, grid);
  }
  group("字体颜色", "textColor", fontColors);
  group("背景颜色", "backgroundColor", backgrounds);
  const reset = button("恢复默认", "恢复默认", () => apply({ textColor: "", backgroundColor: "" }));
  reset.className = "resetColors";
  panel.append(reset);

  function place() {
    const anchor = trigger.getBoundingClientRect(), toolbar = bar.getBoundingClientRect();
    const x = (anchor.left + anchor.right - panel.offsetWidth) / 2;
    const below = innerHeight - toolbar.bottom;
    const y = below >= panel.offsetHeight + 10 || below >= toolbar.top
      ? toolbar.bottom + 4 : toolbar.top - panel.offsetHeight - 4;
    panel.style.left = Math.max(6, Math.min(innerWidth - panel.offsetWidth - 6, x)) + "px";
    panel.style.top = Math.max(6, Math.min(innerHeight - panel.offsetHeight - 6, y)) + "px";
  }
  panel.ontoggle = () => {
    if (panel.matches(":popover-open")) {
      place();
      (panel.querySelector('[aria-pressed="true"]') || swatches[0].item).focus({ preventScroll: true });
    }
  };
  return function refresh(range) {
    if (bar.hidden || !range) {
      if (panel.matches(":popover-open")) panel.hidePopover();
      return;
    }
    const fonts = new Set(), fills = new Set();
    const { textColor, backgroundColor } = editor.schema.marks;
    editor.state.doc.nodesBetween(range.from, range.to, node => {
      if (node.isText) {
        fonts.add(textColor.isInSet(node.marks)?.attrs.color || "");
        fills.add(backgroundColor.isInSet(node.marks)?.attrs.color || "");
      }
    });
    const [font] = fonts, [fill] = fills;
    trigger.style.color = fonts.size === 1 ? font : "";
    for (const { item, mark, color, legacy } of swatches) {
      const value = mark === "textColor" ? (fonts.size === 1 ? font || swatches[0].color : null)
        : fills.size === 1 ? fill : null;
      item.setAttribute("aria-pressed", value === color || (legacy != null && value === legacy));
    }
    if (panel.matches(":popover-open")) place();
  };
}
