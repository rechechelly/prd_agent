// Map physical HTML cells to logical coordinates, including merged headers and cells.
function layout(table) {
  const rows = Array.from(table.rows),
    grid = rows.map(() => []),
    origins = new Map();
  for (const [y, row] of rows.entries()) {
    let x = 0;
    for (const cell of row.cells) {
      while (grid[y][x]) x++;
      const groupLeft = row.parentElement.rows.length - row.sectionRowIndex;
      const height = Math.min(cell.rowSpan || groupLeft, groupLeft);
      const box = { x, y, cell, height, width: cell.colSpan };
      origins.set(cell, box);
      for (let j = y; j < y + height; j++)
        for (let i = x; i < x + box.width; i++) grid[j][i] = box;
      x += box.width;
    }
  }
  return {
    rows,
    grid,
    origins,
    width: Math.max(0, ...grid.map((r) => r.length)),
  };
}
function emptyCell(row, reference, before) {
  const cell = row.ownerDocument.createElement(
    reference?.tagName || (row.parentElement.tagName === "THEAD" ? "th" : "td"),
  );
  cell.append(row.ownerDocument.createElement("br"));
  row.insertBefore(cell, before || null);
  return cell;
}
function updateColumns(table, index, add) {
  const items = table.querySelectorAll(
    ":scope > colgroup > col,:scope > colgroup:not(:has(col))",
  );
  let x = 0;
  for (const col of items) {
    if (index < x + col.span || (add && col === items[items.length - 1])) {
      if (add) col.span++;
      else if (col.span > 1) col.span--;
      else col.remove();
      return;
    }
    x += col.span;
  }
}
export function editedTable(cell, operation) {
  const original = cell.closest("table"),
    table = original.cloneNode(true);
  const rowIndex = cell.parentElement.rowIndex;
  const { rows, grid, origins, width } = layout(table);
  const box = origins.get(rows[rowIndex].cells[cell.cellIndex]);
  const row = rows[rowIndex];
  const isRow = operation.includes("Row"),
    add = operation.startsWith("add");
  let y = rowIndex,
    x = box.x;
  if (isRow && add) {
    y = operation === "addRowBefore" ? rowIndex : rowIndex + 1;
    const newRow = table.ownerDocument.createElement("tr");
    row.parentElement.insertBefore(
      newRow,
      y === rowIndex ? row : row.nextElementSibling,
    );
    const covered = new Set();
    for (let i = 0; i < width; i++) {
      const previous = grid[rowIndex][i];
      const spanning =
        !newRow.nextElementSibling && previous?.cell.rowSpan === 0
          ? previous
          : grid[y]?.[i];
      if (
        spanning &&
        spanning.y < y &&
        spanning.cell.parentElement.parentElement === newRow.parentElement
      ) {
        if (!covered.has(spanning) && spanning.cell.rowSpan !== 0)
          spanning.cell.rowSpan++;
        covered.add(spanning);
        continue;
      }
      emptyCell(newRow, grid[rowIndex][i]?.cell);
    }
  } else if (isRow) {
    if (rows.length === 1) return { original, table: null };
    for (const span of new Set(grid[rowIndex].filter(Boolean))) {
      if (span.height <= 1) continue;
      if (span.cell.rowSpan > 0) span.cell.rowSpan--;
      if (span.y === rowIndex) {
        const next = rows[rowIndex + 1];
        const before = Array.from(next.cells).find(
          (c) => origins.get(c).x > span.x,
        );
        next.insertBefore(span.cell, before || null);
      }
    }
    row.remove();
  } else {
    if (!add && width === 1) return { original, table: null };
    if (operation === "addColumnAfter") x += box.width;
    const processed = new Set();
    for (const [j, r] of rows.entries()) {
      const span = grid[j][x];
      if (add && (!span || span.x === x)) {
        const before = Array.from(r.cells).find((c) => origins.get(c).x >= x);
        emptyCell(r, (grid[j][box.x] || span)?.cell, before);
      } else if (span && !processed.has(span)) {
        if (add) span.cell.colSpan++;
        else if (span.width > 1) span.cell.colSpan--;
        else span.cell.remove();
        processed.add(span);
      }
    }
    updateColumns(table, x, add);
  }
  const after = layout(table);
  const targetRow = after.grid[Math.min(y, after.rows.length - 1)];
  const targetCell = targetRow[Math.min(x, targetRow.length - 1)]?.cell;
  return {
    original,
    table,
    row: targetCell?.parentElement.rowIndex ?? 0,
    column: targetCell?.cellIndex ?? 0,
  };
}
