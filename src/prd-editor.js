import { editedTable } from "./table-edit";
import DOMPurify from "dompurify";
import { $, dialog, toast } from "./shared";
import { readDocumentImage } from "./document-image";

// Edit the original HTML in place so generated layout, anchors and figure captions survive.
export function attachPrdEditor(doc, markdownHTML) {
  const win = doc.defaultView;
  const bar = $("prdToolbar"),
    outline = $("imageOutline");
  bar.innerHTML = $("legacyPrdToolbar").innerHTML;
  const format = bar.querySelector("select");
  format.removeAttribute("id");
  const tableOperations = bar.querySelector(".tableOperations");
  tableOperations.hidden = true;
  let tableCell = null;
  tableOperations.onchange = () => {
    const op = tableOperations.value;
    tableOperations.selectedIndex = 0;
    if (!op || !tableCell?.isConnected) return;
    const t = editedTable(tableCell, op);
    const range = rangeAtImage(t.original);
    if (!t.table) {
      command("delete", null, range);
      tableOperations.hidden = true;
      tableCell = null;
      return;
    }
    const marker = crypto.randomUUID();
    t.table.dataset.prdEditId = marker;
    if (!command("insertHTML", t.table.outerHTML, range)) return;
    const updated = doc.querySelector('[data-prd-edit-id="' + marker + '"]');
    const cell = updated?.rows[t.row]?.cells[t.column];
    if (cell) {
      const caret = doc.createRange();
      caret.selectNodeContents(cell);
      caret.collapse(true);
      const sel = doc.getSelection();
      sel.removeAllRanges();
      sel.addRange(caret);
      tableCell = cell;
    }
  };
  for (const level of [1, 4, 5, 6])
    format.add(new Option("一二三四五六"[level - 1] + "级标题", level));
  const replace = document.createElement("button"),
    remove = document.createElement("button");
  replace.textContent = "替换图片";
  remove.textContent = "删除图片";
  const file = document.createElement("input");
  file.type = "file";
  file.accept = $("file").accept;
  file.hidden = true;
  bar.append(replace, remove, file);
  bar.hidden = false;
  const events = new AbortController(),
    options = { signal: events.signal };
  let selected, drag, pendingFile, remembered;
  function syncOutline() {
    if (selected && !selected.isConnected) {
      observer.unobserve(selected);
      selected = null;
    }
    outline.hidden = replace.hidden = remove.hidden = !selected;
    if (!selected || drag) return;
    const r = selected.getBoundingClientRect();
    Object.assign(outline.style, {
      left: r.left + "px",
      top: r.top + "px",
      width: r.width + "px",
      height: r.height + "px",
    });
  }
  const observer = new ResizeObserver(syncOutline);
  observer.observe($("deliveryPage"));
  function selectImage(img) {
    if (selected) observer.unobserve(selected);
    selected = img;
    if (img) observer.observe(img);
    syncOutline();
  }
  function rangeAtImage(img) {
    const range = doc.createRange();
    range.selectNode(img);
    return range;
  }
  function caret() {
    const sel = doc.getSelection();
    if (sel.rangeCount && doc.body.contains(sel.anchorNode))
      return sel.getRangeAt(0).cloneRange();
    if (remembered && doc.body.contains(remembered.commonAncestorContainer))
      return remembered.cloneRange();
    const range = doc.createRange();
    range.selectNodeContents(doc.body.lastElementChild || doc.body);
    range.collapse(false);
    return range;
  }
  function command(name, value, range = caret()) {
    if (
      events.signal.aborted ||
      !doc.body.contains(range.commonAncestorContainer)
    )
      return false;
    doc.body.focus({ preventScroll: true });
    const sel = doc.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    return doc.execCommand(name, false, value);
  }
  function updateImage(original, img, range) {
    if (original && !original.isConnected) return;
    const marker = crypto.randomUUID();
    img.dataset.prdEditId = marker;
    if (
      command(
        "insertHTML",
        img.outerHTML,
        original ? rangeAtImage(original) : range,
      )
    ) {
      selectImage(doc.querySelector('[data-prd-edit-id="' + marker + '"]'));
    }
  }
  async function loadImage(blob, target, range) {
    try {
      const src = await readDocumentImage(blob);
      if (events.signal.aborted) return;
      const img = target ? target.cloneNode(false) : doc.createElement("img");
      img.src = src;
      img.removeAttribute("srcset");
      if (!target) {
        img.alt = blob.name || "插入的图片";
        img.style.maxWidth = "100%";
      }
      updateImage(target, img, range);
    } catch (error) {
      toast(error.message);
    }
  }
  function insertionRange() {
    if (!selected) return caret();
    const range = rangeAtImage(selected);
    range.collapse(false);
    return range;
  }
  function chooseImage(target) {
    pendingFile = { target, range: insertionRange() };
    file.value = "";
    file.click();
  }
  file.onchange = () => {
    if (file.files[0] && pendingFile)
      loadImage(file.files[0], pendingFile.target, pendingFile.range);
  };
  replace.onclick = () => chooseImage(selected);
  function deleteImage() {
    if (selected && command("delete", null, rangeAtImage(selected)))
      selectImage(null);
  }
  remove.onclick = deleteImage;
  doc.addEventListener(
    "pointerdown",
    (e) => {
      const img = e.target.closest?.("img");
      selectImage(img);
      if (img) {
        e.preventDefault();
        doc.body.focus({ preventScroll: true });
        const sel = doc.getSelection();
        sel.removeAllRanges();
        sel.addRange(rangeAtImage(img));
      }
    },
    options,
  );
  doc.addEventListener(
    "keydown",
    (e) => {
      if (!selected) return;
      if (["Delete", "Backspace"].includes(e.key)) {
        e.preventDefault();
        deleteImage();
      } else if (!e.ctrlKey && !e.metaKey && !e.shiftKey) selectImage(null);
    },
    options,
  );
  doc.addEventListener(
    "selectionchange",
    () => {
      const sel = doc.getSelection();
      if (!sel.rangeCount || !doc.body.contains(sel.anchorNode)) return;
      remembered = sel.getRangeAt(0).cloneRange();
      const el =
        sel.anchorNode.nodeType === 1
          ? sel.anchorNode
          : sel.anchorNode.parentElement;
      tableCell = el.closest("td,th");
      tableOperations.hidden = !tableCell;
      format.value = el.closest("h1,h2,h3,h4,h5,h6")?.tagName.slice(1) || "0";
      for (const [key, cmd] of [
        ["bold", "bold"],
        ["italic", "italic"],
        ["list", "insertUnorderedList"],
      ])
        bar
          .querySelector('[data-cmd="' + key + '"]')
          .setAttribute("aria-pressed", String(doc.queryCommandState(cmd)));
    },
    options,
  );
  bar.onmousedown = (e) => {
    if (e.target.closest("button")) e.preventDefault();
  };
  format.onchange = () =>
    command("formatBlock", format.value === "0" ? "p" : "h" + format.value);
  bar.onclick = (e) => {
    const key = e.target.closest("[data-cmd]")?.dataset.cmd;
    if (["bold", "italic", "undo", "list"].includes(key))
      command(key === "list" ? "insertUnorderedList" : key);
    if (key === "image") chooseImage(null);
    if (key === "table")
      command(
        "insertHTML",
        "<table><thead><tr>" +
          "<th><br></th>".repeat(3) +
          "</tr></thead><tbody>" +
          ("<tr>" + "<td><br></td>".repeat(3) + "</tr>").repeat(2) +
          "</tbody></table>",
      );
    if (key === "markdown") {
      const range = caret();
      dialog(
        "插入 Markdown",
        '<label for="md">Markdown 正文</label><textarea id="md" name="md" required placeholder="## 页面说明"></textarea>',
        ({ md }) => {
          // Restore the iframe selection after the modal has returned focus.
          queueMicrotask(() =>
            command("insertHTML", DOMPurify.sanitize(markdownHTML(md)), range),
          );
        },
        "插入正文",
      );
    }
    syncOutline();
  };
  doc.addEventListener(
    "paste",
    (e) => {
      const blob = [...e.clipboardData.files].find((f) =>
        f.type.startsWith("image/"),
      );
      if (blob) {
        e.preventDefault();
        loadImage(blob, null, insertionRange());
      } else if (e.clipboardData.getData("text/html")) {
        e.preventDefault();
        command(
          "insertHTML",
          DOMPurify.sanitize(e.clipboardData.getData("text/html")),
        );
      }
    },
    options,
  );
  outline.replaceChildren();
  for (const [edge, label] of [
    ["right", "调整图片宽度"],
    ["bottom", "调整图片高度"],
    ["corner", "调整图片尺寸"],
  ]) {
    const handle = document.createElement("button");
    handle.dataset.edge = edge;
    handle.title = label + "，按住 Shift 等比例缩放";
    handle.setAttribute("aria-label", handle.title);
    outline.append(handle);
    handle.onpointerdown = (e) => {
      if (!selected || e.button !== 0) return;
      e.preventDefault();
      const { width, height } = selected.getBoundingClientRect();
      if (!width || !height) return;
      drag = { x: e.clientX, y: e.clientY, width, height, edge };
      handle.setPointerCapture(e.pointerId);
    };
    const size = (e) => {
      const { width, height, x, y } = drag;
      const dx = e.clientX - x,
        dy = e.clientY - y;
      let w = edge === "bottom" ? width : Math.max(32, width + dx);
      let h = edge === "right" ? height : Math.max(24, height + dy);
      if (e.shiftKey) {
        const useHeight =
          edge === "bottom" ||
          (edge === "corner" && Math.abs(dy / height) > Math.abs(dx / width));
        const scale = Math.max(
          32 / width,
          24 / height,
          useHeight ? h / height : w / width,
        );
        w = width * scale;
        h = height * scale;
      }
      return { width: Math.round(w), height: Math.round(h) };
    };
    handle.onpointermove = (e) => {
      if (!drag) return;
      const { width, height } = size(e);
      Object.assign(outline.style, {
        width: width + "px",
        height: height + "px",
      });
    };
    handle.onpointerup = (e) => {
      if (!drag) return;
      const { width, height } = size(e);
      const moved = e.clientX !== drag.x || e.clientY !== drag.y;
      drag = null;
      if (moved && selected) {
        const img = selected.cloneNode(false);
        Object.assign(img.style, {
          width: width + "px",
          maxWidth: "100%",
          height: "auto",
          aspectRatio: width + " / " + height,
        });
        updateImage(selected, img);
      }
      syncOutline();
    };
    handle.onpointercancel = () => {
      drag = null;
      syncOutline();
    };
  }
  win.addEventListener("scroll", syncOutline, {
    capture: true,
    signal: events.signal,
  });
  doc.body.addEventListener("input", syncOutline, options);
  syncOutline();
  return () => {
    events.abort();
    observer.disconnect();
    outline.hidden = bar.hidden = true;
    outline.replaceChildren();
    bar.replaceChildren();
    bar.onclick = bar.onmousedown = null;
  };
}
