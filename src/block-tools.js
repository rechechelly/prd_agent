// Handles live outside the editable DOM, so copied and saved documents contain only content.
import {
  CellSelection,
  TableMap,
  removeColumn,
  removeRow,
} from "@tiptap/pm/tables";

import { closeHistory } from "@tiptap/pm/history";
import { NodeRange } from "@tiptap/pm/model";
import { liftTarget } from "@tiptap/pm/transform";
import { dialog, icon } from "./shared";
import { installBlockSelection } from "./block-selection";
import { installTextToolbar } from "./text-toolbar";

function cellInfo(editor, cell) {
  if (!cell || !editor.view.dom.contains(cell)) return;
  const pos = editor.view.state.doc.resolve(editor.view.posAtDOM(cell, 0));
  for (let depth = pos.depth; depth > 0; depth--) {
    const node = pos.node(depth);
    if (
      node.type.spec.tableRole !== "cell" &&
      node.type.spec.tableRole !== "header_cell"
    )
      continue;
    const table = pos.node(depth - 2),
      start = pos.start(depth - 2),
      offset = pos.before(depth) - start;
    const map = TableMap.get(table);
    return {
      pos: pos.before(depth) + 1,
      table,
      start,
      map,
      rect: map.findCell(offset),
    };
  }
}

export function resizeImageColumn(editor, cell, width, tr) {
  const info = cellInfo(editor, cell);
  if (!info) return;
  const table = cell.closest("table"),
    cols = Array.from(table.querySelectorAll(":scope > colgroup > col"));
  if (!cols.length) return;
  const sizes = cols.map((col) =>
    Math.max(32, Math.round(col.getBoundingClientRect().width)),
  );
  const column = info.rect.right - 1;
  sizes[column] = Math.max(
    40,
    Math.round(width) -
      sizes.slice(info.rect.left, column).reduce((a, b) => a + b, 0),
  );
  if (!tr) {
    cols.forEach((col, i) => (col.style.width = sizes[i] + "px"));
    table.style.width = sizes.reduce((a, b) => a + b, 0) + "px";
    return;
  }
  for (const offset of new Set(info.map.map)) {
    const at = info.start + offset,
      node = tr.doc.nodeAt(at),
      rect = info.map.findCell(offset);
    const colwidth = sizes.slice(rect.left, rect.right);
    if (String(colwidth) !== String(node.attrs.colwidth))
      tr.setNodeMarkup(at, undefined, { ...node.attrs, colwidth });
  }
}

export function installBlockTools(editor, chooseImage) {
  const root = editor.view.dom,
    overlay = document.createElement("div");
  overlay.className = "blockTools";
  document.body.append(overlay);
  const button = (name, text, click) => {
    const b = document.createElement("button");
    b.type = "button";
    b.title = b.ariaLabel = name;
    b.textContent = text;
    b.onmousedown = (e) => e.preventDefault();
    b.onclick = click;
    return b;
  };
  installTextToolbar(editor, button, installBlockSelection(editor));
  const handle = button("段落工具", "+ ", () => showMenu());
  handle.className = "blockHandle";
  handle.onmouseenter = () => showMenu();
  handle.onfocus = () => showMenu();
  const menu = document.createElement("div");
  menu.className = "blockMenu";
  menu.setAttribute("role", "group");
  menu.ariaLabel = "段落编辑工具";
  const col = button("插入列", "+", () => tableAction(col.dataset.cmd));
  const row = button("插入行", "+", () => tableAction(row.dataset.cmd));
  col.className = "edgeTool colTool";
  row.className = "edgeTool rowTool";
  const highlight = document.createElement("div");
  highlight.className = "blockHighlight";
  const guide = document.createElement("div");
  guide.className = "tableGuide";
  guide.hidden = true;
  const scroller = root.closest("#paperScroll");
  const railSize = 26;
  const colRail = document.createElement("div");
  const rowRail = document.createElement("div");
  colRail.className = "tableRail columns";
  rowRail.className = "tableRail rows";
  let railTable;
  const railObserver = new ResizeObserver(() => {
    if (railTable) layoutRails();
  });

  function layoutRail(rail, cells, horizontal, start, end) {
    const name = horizontal ? "行" : "列";
    for (let i = 0; i < cells.length; i++) {
      let control = rail.children[i];
      if (!control) {
        control = button("选中第 " + (i + 1) + " " + name, "", () =>
          selectAxis(horizontal, i),
        );
        control.className = "axisHandle";
        rail.append(control);
      }
      const rect = cells[i].getBoundingClientRect();
      const first = Math.max(start, horizontal ? rect.top : rect.left);
      const last = Math.min(end, horizontal ? rect.bottom : rect.right);
      control.hidden = last <= first;
      control.style[horizontal ? "top" : "left"] = first - start + "px";
      control.style[horizontal ? "height" : "width"] =
        Math.max(0, last - first) + "px";
    }
    while (rail.children.length > cells.length) rail.lastElementChild.remove();
  }
  function layoutRails() {
    if (!railTable?.isConnected || !root.getClientRects().length)
      return clear();
    const table = railTable.getBoundingClientRect();
    const clip = railTable.parentElement.getBoundingClientRect();
    const bounds = scroller.getBoundingClientRect();
    const top = Math.max(table.top, bounds.top);
    const bottom = Math.min(table.bottom, bounds.bottom);
    const left = Math.max(table.left, clip.left, bounds.left);
    const right = Math.min(table.right, clip.right, bounds.right);
    if (bottom <= top || right <= left) return clear();
    place(rowRail, Math.max(bounds.left, left - railSize), top);
    rowRail.style.height = bottom - top + "px";
    layoutRail(rowRail, railTable.rows, true, top, bottom);
    colRail.hidden = table.top - railSize < bounds.top;
    if (!colRail.hidden) {
      place(colRail, left, table.top - railSize);
      colRail.style.width = right - left + "px";
      layoutRail(
        colRail,
        railTable.querySelectorAll(":scope > colgroup > col"),
        false,
        left,
        right,
      );
    }
    place(removeTable, left - railSize - 4, table.top - railSize - 2);
    removeTable.hidden = colRail.hidden;
    positionDelete();
  }
  function setRailTable(table) {
    if (table === railTable) return;
    railObserver.disconnect();
    railTable = table;
    rowRail.hidden = colRail.hidden = !table;
    if (table) {
      railObserver.observe(table);
      railObserver.observe(table.parentElement);
      layoutRails();
    }
  }
  const removeTable = button("删除整个表格", "", () =>
    tableAction("deleteTable"),
  );
  removeTable.className = "wholeTableDelete";
  removeTable.innerHTML = icon("trash");
  const trash = button("删除选区", "", deleteAxis);
  trash.innerHTML = icon("trash");
  trash.className = "axisDelete";
  trash.hidden = true;
  document.body.append(trash);
  overlay.append(
    highlight,
    guide,
    handle,
    menu,
    removeTable,
    colRail,
    rowRail,
    col,
    row,
  );
  let axis;
  function dismissAxis() {
    axis = null;
    trash.hidden = true;
  }
  function selectAxis(horizontal, index) {
    const info = cellInfo(editor, railTable?.rows[0]?.cells[0]);
    if (!info) return;
    const { map, start } = info;
    const first = horizontal ? index * map.width : index;
    const last = horizontal
      ? first + map.width - 1
      : first + (map.height - 1) * map.width;
    const selection = CellSelection.create(
      editor.state.doc,
      start + map.map[first],
      start + map.map[last],
    );
    const anchorCell = editor.view.nodeDOM(selection.$anchorCell.pos);
    editor.view.dispatch(editor.state.tr.setSelection(selection));
    editor.view.focus();
    axis = { cell: anchorCell, horizontal, selection, index };
    trash.title = trash.ariaLabel = horizontal ? "删除选中行" : "删除选中列";
    positionDelete();
  }
  function positionDelete() {
    if (!axis) return;
    const scroller = root.closest("#paperScroll").getBoundingClientRect();
    const box = axis.cell.getBoundingClientRect();
    const table = axis.cell.closest("table")?.getBoundingClientRect();
    if (
      !table ||
      !root.getClientRects().length ||
      table.bottom < scroller.top ||
      table.top > scroller.bottom
    )
      return dismissAxis();
    trash.hidden = false;
    place(
      trash,
      Math.min(
        scroller.right - 40,
        Math.max(
          scroller.left + 2,
          axis.horizontal ? table.left : box.right - 34,
        ),
      ),
      Math.min(
        scroller.bottom - 36,
        Math.max(
          scroller.top + 2,
          (axis.horizontal ? box.top : table.top) - 47,
        ),
      ),
    );
  }
  function deleteAxis() {
    const info = cellInfo(editor, axis?.cell);
    if (!info || !editor.state.selection.eq(axis.selection))
      return dismissAxis();
    const tr = closeHistory(editor.state.tr);
    const { horizontal, index } = axis;
    if ((horizontal ? info.map.height : info.map.width) === 1) {
      tr.delete(info.start - 1, info.start - 1 + info.table.nodeSize);
    } else {
      (horizontal ? removeRow : removeColumn)(
        tr,
        { table: info.table, map: info.map, tableStart: info.start },
        index,
      );
    }
    dismissAxis();
    clear();
    editor.view.dispatch(tr.scrollIntoView());
    editor.view.focus();
  }
  editor.on("transaction", ({ transaction }) => {
    if (
      axis &&
      (transaction.docChanged || !editor.state.selection.eq(axis.selection))
    )
      dismissAxis();
  });
  document.addEventListener("scroll", positionDelete, true);
  window.addEventListener("resize", positionDelete);
  function showGuide(horizontal) {
    if (!cell?.isConnected) return;
    const table = cell.closest("table").getBoundingClientRect(),
      knob = (horizontal ? row : col).getBoundingClientRect();
    Object.assign(guide.style, {
      left: (horizontal ? table.left : knob.left + 9) + "px",
      top: (horizontal ? knob.top + 9 : table.top) + "px",
      width: (horizontal ? table.width : 2) + "px",
      height: (horizontal ? 2 : table.height) + "px",
    });
    guide.hidden = false;
  }
  row.onmouseenter = () => showGuide(true);
  col.onmouseenter = () => showGuide(false);
  row.onmouseleave = col.onmouseleave = () => (guide.hidden = true);
  let block, cell, closeTimer;
  const menuObserver = new ResizeObserver(() => {
    if (!menu.hidden) positionMenu();
  });
  let menuReserve = 0;
  function closeMenu() {
    menu.hidden = true;
    menuObserver.disconnect();
    menuReserve = 0;
    scroller.style.removeProperty("--block-menu-reserve");
  }
  function clear() {
    setRailTable(null);
    block = cell = null;
    guide.hidden = true;
    overlay.hidden = true;
    closeMenu();
    col.hidden = row.hidden = true;
    clearTimeout(closeTimer);
  }
  clear();
  function place(el, x, y) {
    Object.assign(el.style, {
      left: Math.max(1, x) + "px",
      top: Math.max(1, y) + "px",
    });
  }
  function target(el, event) {
    if (!root.contains(el)) return;
    let line = el.closest("p,h1,h2,h3,h4,h5,h6,pre,td,th");
    if (!line) {
      const item = el.closest("li");
      line = item?.querySelector(":scope > p, :scope > div > p");
    }
    if (!line || !root.contains(line)) return;
    if (event) {
      const rect = line.getBoundingClientRect();
      if (event.clientY < rect.top || event.clientY >= rect.bottom) return;
    }
    return line;
  }
  function isStyledLine(line) {
    return Boolean(
      line.textContent.trim() ||
      line.closest("li") ||
      line.matches("h1,h2,h3,h4,h5,h6,pre"),
    );
  }
  function positionLine() {
    const r = block.getBoundingClientRect();
    const viewport = scroller.getBoundingClientRect();
    Object.assign(highlight.style, {
      left: r.left + "px",
      top: Math.max(viewport.top, r.top) + "px",
      width: r.width + "px",
      height:
        Math.max(
          0,
          Math.min(viewport.bottom, r.bottom) - Math.max(viewport.top, r.top),
        ) + "px",
    });
    const item = block.closest("li[data-checked]");
    const gutter = item?.getBoundingClientRect().left ?? r.left;
    const top = Math.max(
      viewport.top,
      Math.min(r.top + 3, viewport.bottom - handle.offsetHeight),
    );
    place(handle, gutter - handle.offsetWidth - 5, top);
    return r;
  }
  function activate(b, c, event) {
    if (!b || !b.isConnected) return;
    if (block !== b || cell !== c) {
      closeMenu();
      block = b;
      cell = c;
    }
    overlay.hidden = false;
    handle.hidden = Boolean(c);
    const styled = isStyledLine(b);
    handle.textContent = styled ? "T" : "+";
    highlight.hidden = Boolean(c || styled);
    if (!c) positionLine();
    removeTable.hidden = col.hidden = row.hidden = !c;
    setRailTable(c?.closest("table") || null);
    if (c && railTable) {
      const bounds = railTable.getBoundingClientRect();
      const box = c.getBoundingClientRect(),
        tr = c.parentElement.getBoundingClientRect();
      const clip = railTable.parentElement.getBoundingClientRect();
      const left = Math.max(bounds.left, clip.left);
      removeTable.hidden = colRail.hidden;
      const beforeCol = event && event.clientX < box.left + box.width / 2;
      const beforeRow = event && event.clientY < tr.top + tr.height / 2;
      col.dataset.cmd = beforeCol ? "addColumnBefore" : "addColumnAfter";
      row.dataset.cmd = beforeRow ? "addRowBefore" : "addRowAfter";
      const edge = beforeCol ? box.left : box.right;
      col.hidden = colRail.hidden || edge < left || edge > clip.right;
      place(col, edge - 10, bounds.top - railSize - 15);
      place(row, left - railSize - 15, (beforeRow ? tr.top : tr.bottom) - 10);
    }
  }
  function focusLine(entire = false) {
    if (!block?.isConnected) return;
    const from = editor.view.posAtDOM(block, 0);
    const to = editor.view.posAtDOM(block, block.childNodes.length);
    const chain = editor.chain().focus();
    return chain.setTextSelection(entire && from < to ? { from, to } : from);
  }
  function formatLine() {
    return focusLine()?.command(({ tr }) => {
      const { $from } = tr.selection;
      const depth = $from.depth - 1;
      if (
        depth < 1 ||
        $from.node(depth).type.name !== "taskItem" ||
        $from.index(depth) !== 0
      )
        return true;
      // A task item must begin with a paragraph. Lift this item's content
      // at its current nesting level before applying the new block type.
      const range = new NodeRange(
        tr.doc.resolve($from.start(depth)),
        tr.doc.resolve($from.end(depth)),
        depth,
      );
      const target = liftTarget(range);
      if (target == null) return false;
      closeHistory(tr).lift(range, target);
      return true;
    });
  }
  function tableAction(operation) {
    const info = cellInfo(editor, cell);
    if (!info) return;
    editor.chain().focus().setTextSelection(info.pos)[operation]().run();
    clear();
  }
  function addTable(rows, cols) {
    const width = Math.max(
      64,
      Math.min(132, Math.floor(root.clientWidth / cols)),
    );
    const td = '<td colwidth="' + width + '"><p></p></td>';
    focusLine()
      ?.insertContent(
        "<table><tbody>" +
          ("<tr>" + td.repeat(cols) + "</tr>").repeat(rows) +
          "</tbody></table>",
      )
      .run();
    clear();
  }
  function showMenu() {
    if (cell || !block?.isConnected || !menu.hidden) return;
    clearTimeout(closeTimer);
    menu.replaceChildren();
    menu.hidden = false;
    highlight.hidden = false;
    menuObserver.observe(block);
    menuObserver.observe(scroller);
    const styled = isStyledLine(block);
    menu.classList.toggle("styleMenu", styled);
    const group = document.createElement("div");
    group.className = "blockFormats";
    menu.append(group);
    const action = (name, symbol, fn, host = group) =>
      host.append(
        button(name, symbol, () => {
          fn();
          clear();
          if (styled) editor.view.focus();
        }),
      );
    const undo = button("撤销上一步", "↶", () => {
      editor.chain().focus().undo().run();
      clear();
    });
    undo.disabled = !editor.can().undo();
    action("正文", "T", () => formatLine()?.setParagraph().run());
    for (const level of styled ? [1, 2, 3, 4, 5, 6] : [1, 2, 3])
      action(level + " 级标题", "H" + level, () =>
        formatLine()?.setHeading({ level }).run(),
      );
    if (styled) {
      for (const [name, symbol, cmd] of [
        ["有序列表", "1.≡", "toggleOrderedList"],
        ["无序列表", "•≡", "toggleBulletList"],
        ["代码块", "{}", "toggleCodeBlock"],
        ["引用", "❝", "toggleBlockquote"],
      ])
        action(name, symbol, () => formatLine()?.[cmd]().run());
      group.append(undo);
      positionMenu();
      return;
    }
    for (const [name, cmd] of [
      ["有序列表", "toggleOrderedList"],
      ["无序列表", "toggleBulletList"],
      ["待办任务", "toggleTaskList"],
      ["引用", "toggleBlockquote"],
    ])
      action(name, name, () => focusLine()?.[cmd]().run(), menu);
    action(
      "插入图片",
      "图片",
      () => {
        focusLine()?.run();
        chooseImage();
      },
      menu,
    );
    action(
      "插入 Markdown",
      "Markdown",
      () => {
        focusLine()?.run();
        const bookmark = editor.state.selection.getBookmark();
        dialog(
          "插入 Markdown",
          '<label for="md">Markdown 正文</label><textarea id="md" name="md" required></textarea>',
          ({ md }) => {
            editor
              .chain()
              .focus()
              .command(({ tr }) => {
                tr.setSelection(bookmark.resolve(tr.doc));
                return true;
              })
              .insertContent(md, { contentType: "markdown" })
              .run();
          },
          "插入正文",
        );
      },
      menu,
    );
    group.append(undo);
    const grid = document.createElement("div");
    grid.className = "tablePicker";
    grid.hidden = true;
    const count = document.createElement("small");
    count.textContent = "选择表格行列";
    grid.append(count);
    const cells = document.createElement("div");
    grid.append(cells);
    const tableButton = button("选择表格大小", "表格  ›", () => {
      grid.hidden = false;
      positionMenu();
    });
    tableButton.onmouseenter = () => {
      grid.hidden = false;
      positionMenu();
    };
    menu.append(tableButton, grid);
    for (let r = 1; r <= 8; r++)
      for (let c = 1; c <= 8; c++) {
        const b = button(r + " 行 " + c + " 列", "", () => addTable(r, c));
        b.dataset.r = r;
        b.dataset.c = c;
        b.onmouseenter = b.onfocus = () => {
          count.textContent = r + " 行 × " + c + " 列";
          for (const box of cells.children)
            box.classList.toggle(
              "marked",
              box.dataset.r <= r && box.dataset.c <= c,
            );
        };
        cells.append(b);
      }
    positionMenu();
  }
  function positionMenu() {
    if (!block?.isConnected || !block.getClientRects().length) return clear();
    const line = positionLine();
    const trigger = handle.getBoundingClientRect();
    const pane = scroller.getBoundingClientRect();
    const gap = 5;
    const topLimit = Math.max(0, pane.top) + gap;
    const bottomLimit = Math.min(innerHeight, pane.bottom + menuReserve) - gap;
    const leftLimit = Math.max(0, pane.left) + gap;
    const rightLimit = Math.min(innerWidth, pane.right) - gap;
    menu.style.maxWidth = Math.max(0, rightLimit - leftLimit) + "px";
    const left = Math.max(
      leftLimit,
      Math.min(trigger.left, rightLimit - menu.offsetWidth),
    );
    const right = left + menu.offsetWidth;
    const grid = menu.querySelector(".tablePicker:not([hidden])");
    const flyRight = right + 208 <= rightLimit;
    const flyout = grid && (flyRight || left - 208 >= leftLimit);
    if (grid) grid.classList.toggle("flyout", Boolean(flyout));

    const aboveEnd = Math.min(line.top, trigger.top) - gap;
    const belowStart = Math.max(line.bottom, trigger.bottom) + gap;
    const above = Math.max(0, aboveEnd - topLimit);
    const below = Math.max(0, bottomLimit - belowStart);
    const wanted = Math.max(
      menu.scrollHeight + 2,
      flyout ? grid.scrollHeight + 2 : 0,
    );
    const useBelow = below >= wanted || (above < wanted && below >= above);
    let start = useBelow ? belowStart : topLimit;
    let end = useBelow ? bottomLimit : aboveEnd;

    // If the paragraph fills the pane, reserve a strip outside the scrollable
    // text. The menu stays reachable even when neither side has room for a row.
    const reserve =
      Math.max(above, below) < Math.min(wanted, 56)
        ? Math.min(wanted + 2 * gap, Math.floor((bottomLimit - topLimit) / 2))
        : 0;
    if (reserve !== menuReserve) {
      menuReserve = reserve;
      scroller.style.setProperty("--block-menu-reserve", reserve + "px");
    }
    if (reserve) {
      start = scroller.getBoundingClientRect().bottom + gap;
      end = bottomLimit;
    }
    const height = Math.max(0, Math.floor(end - start));
    menu.style.maxHeight = height + "px";
    place(menu, left, useBelow || reserve ? start : end - menu.offsetHeight);
    if (flyout) {
      grid.style.maxHeight = height + "px";
      const anchor = grid.previousElementSibling.getBoundingClientRect();
      place(
        grid,
        flyRight ? right - 1 : left - grid.offsetWidth + 1,
        Math.max(start, Math.min(anchor.top, end - grid.offsetHeight)),
      );
    } else if (grid) grid.style.maxHeight = "";
  }
  function later(e) {
    clearTimeout(closeTimer);
    if (
      e?.relatedTarget instanceof Node &&
      (overlay.contains(e.relatedTarget) ||
        root.contains(e.relatedTarget) ||
        trash.contains(e.relatedTarget))
    )
      return;
    if (menu.hidden) closeTimer = setTimeout(clear, 280);
  }
  overlay.onpointerenter = () => clearTimeout(closeTimer);
  overlay.onpointerleave = later;
  document.addEventListener(
    "pointermove",
    (e) => {
      if (menu.hidden || overlay.contains(e.target)) return;
      const a = handle.getBoundingClientRect(),
        b = menu.getBoundingClientRect();
      if (
        e.clientX < Math.min(a.left, b.left) - 5 ||
        e.clientX > Math.max(a.right, b.right) + 5 ||
        e.clientY < Math.min(a.top, b.top) - 5 ||
        e.clientY > Math.max(a.bottom, b.bottom) + 5
      )
        clear();
    },
    true,
  );
  // The row gutter is outside the editable DOM. Keep the same target even when
  // approaching from the margin, or pausing between the table and a button.
  function nearTableEdge(e) {
    if (
      e.buttons ||
      !menu.hidden ||
      !scroller.contains(e.target) ||
      e.target.closest("button,input,td,th")
    )
      return;
    for (const table of root.querySelectorAll("table")) {
      const r = table.getBoundingClientRect(),
        clip = table.parentElement.getBoundingClientRect();
      const left = Math.max(r.left, clip.left),
        right = Math.min(r.right, clip.right);
      if (!(
        e.clientX >= left - railSize - 2 &&
        e.clientX <= right &&
        e.clientY >= r.top - railSize - 2 &&
        e.clientY <= r.bottom &&
        (e.clientX <= left || e.clientY <= r.top)
      ))
        continue;
      clearTimeout(closeTimer);
      if (railTable !== table) {
        const cell = table.rows[0]?.cells[0];
        if (cell) activate(cell, cell, e);
      }
      return true;
    }
  }
  function betweenLineAndHandle(e) {
    if (!block?.isConnected || handle.hidden) return false;
    const trigger = handle.getBoundingClientRect();
    return (
      e.clientY >= trigger.top &&
      e.clientY <= trigger.bottom &&
      e.clientX >= trigger.left &&
      e.clientX < block.getBoundingClientRect().left
    );
  }
  scroller.addEventListener("pointermove", (e) => {
    if (
      root.contains(e.target) ||
      nearTableEdge(e) ||
      !block ||
      cell ||
      !menu.hidden
    )
      return;
    if (betweenLineAndHandle(e)) clearTimeout(closeTimer);
    else clear();
  });
  root.addEventListener("pointermove", (e) => {
    if (e.buttons || root.querySelector('[data-resize-state="true"]')) return;
    if (!menu.hidden) {
      const a = handle.getBoundingClientRect(),
        b = menu.getBoundingClientRect();
      // Keep the gap between the trigger and its menu traversable.
      if (
        e.clientX >= Math.min(a.left, b.left) - 4 &&
        e.clientX <= Math.max(a.right, b.right) + 4 &&
        e.clientY >= Math.min(a.top, b.top) - 4 &&
        e.clientY <= Math.max(a.bottom, b.bottom) + 4
      )
        return;
    }
    clearTimeout(closeTimer);
    if (nearTableEdge(e)) return;
    const b = target(e.target, e);
    if (!b) {
      if (!betweenLineAndHandle(e)) clear();
      return;
    }
    activate(b, e.target.closest("td,th"), e);
  });
  root.addEventListener("pointerleave", later);
  root.addEventListener("keydown", (e) => {
    if (e.altKey && e.key === "/") {
      e.preventDefault();
      const n = editor.view.domAtPos(editor.state.selection.from).node;
      const el = n.nodeType === 1 ? n : n.parentElement;
      activate(target(el), el.closest("td,th"));
      if (cell) return rowRail.children[cell.parentElement.rowIndex]?.focus();
      showMenu();
      menu.querySelector("button")?.focus();
    } else clear();
  });
  overlay.onkeydown = (e) => {
    if (e.key === "Escape") {
      clear();
      editor.commands.focus();
    }
  };
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (trash.contains(e.target)) return;
      if (!overlay.contains(e.target)) {
        clear();
        dismissAxis();
      }
    },
    true,
  );
  document.addEventListener(
    "scroll",
    (e) => {
      if (
        railTable &&
        (e.target === scroller || e.target === railTable.parentElement)
      ) {
        layoutRails();
        col.hidden = row.hidden = true;
      } else if (!menu.contains(e.target)) clear();
    },
    true,
  );
  window.addEventListener("resize", clear);
}
