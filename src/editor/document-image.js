import { toast } from "../shared";
import Image from "@tiptap/extension-image";
import { NodeSelection } from "@tiptap/pm/state";
import { closeHistory } from "@tiptap/pm/history";
import { resizeImageColumn } from "./block-tools";

export const DocumentImage = Image.extend({
  addNodeView() {
    const create = this.parent();
    return (props) => {
      const view = create(props);
      const img = view.dom.querySelector("img");
      const update = view.update.bind(view);
      view.update = (node, ...args) => {
        if (!update(node, ...args)) return false;
        // The native view sets these only on mount and while dragging.
        img.style.width = node.attrs.width ? node.attrs.width + "px" : "";
        img.style.height = node.attrs.height ? node.attrs.height + "px" : "";
        return true;
      };

      const onResize = view.onResize;
      let initial, restoreColumns;
      const fitColumn = (width, tr) => {
        const cell = img.closest("td,th");
        if (!cell || !initial) return;
        if (width === initial.width) {
          restoreColumns?.();
          restoreColumns = null;
          return;
        }
        if (!tr && !restoreColumns) {
          const table = cell.closest("table");
          const columns = [
            ...table.querySelectorAll(":scope > colgroup > col"),
          ];
          const widths = columns.map((col) => col.style.width);
          const tableWidth = table.style.width;
          restoreColumns = () => {
            columns.forEach((col, index) => (col.style.width = widths[index]));
            table.style.width = tableWidth;
          };
        }
        const css = getComputedStyle(cell);
        const padding =
          parseFloat(css.paddingLeft) + parseFloat(css.paddingRight) + 2;
        resizeImageColumn(props.editor, cell, width + padding, tr);
      };
      view.onResize = (width, height) => {
        onResize(width, height);
        fitColumn(width);
      };
      view.dom.addEventListener(
        "pointerdown",
        (event) => {
          if (event.target.closest("[data-resize-handle]"))
            initial = { width: img.offsetWidth, height: img.offsetHeight };
        },
        true,
      );
      view.onCommit = (width, height) => {
        const pos = props.getPos();
        const { state, view: editorView } = props.editor;
        const node = pos == null ? null : state.doc.nodeAt(pos);
        if (node?.type !== props.node.type) return;
        if (initial && width === initial.width && height === initial.height) {
          restoreColumns?.();
          restoreColumns = initial = null;
          img.style.width = node.attrs.width ? node.attrs.width + "px" : "";
          img.style.height = node.attrs.height ? node.attrs.height + "px" : "";
          editorView.focus();
          return;
        }
        const tr = closeHistory(state.tr);
        tr.setNodeMarkup(pos, undefined, { ...node.attrs, width, height });
        fitColumn(width, tr);
        restoreColumns = initial = null;
        tr.setSelection(NodeSelection.create(tr.doc, pos));
        editorView.dispatch(tr);
        editorView.focus();
      };
      return view;
    };
  },
});

function readDocumentImage(file) {
  return new Promise((resolve, reject) => {
    if (!file || !/^image\/(png|jpeg|webp|gif)$/.test(file.type)) {
      reject(new Error("请选择 PNG、JPEG、WebP 或 GIF 图片"));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("图片读取失败，请重新选择"));
    reader.readAsDataURL(file);
  });
}

export async function insertDocumentImage(editor, file, isCurrent) {
  const view = editor.view;
  let bookmark = editor.state.selection.getBookmark();
  const track = ({ transaction }) => {
    bookmark = bookmark.map(transaction.mapping);
  };
  editor.on("transaction", track);
  try {
    const src = await readDocumentImage(file);
    const image = new window.Image();
    image.src = src;
    await image.decode();
    if (!isCurrent()) return;
    const selection = bookmark.resolve(editor.state.doc);
    const dom = view.domAtPos(selection.from).node;
    const cell = (dom.nodeType === 1 ? dom : dom.parentElement)?.closest(
      "td,th",
    );
    const width = cell
      ? Math.max(1, Math.min(image.naturalWidth, cell.clientWidth - 20))
      : null;
    const attrs = { src, alt: file.name || "文档图片" };
    if (width)
      Object.assign(attrs, {
        width,
        height: Math.max(
          1,
          Math.round((width * image.naturalHeight) / image.naturalWidth),
        ),
      });
    editor
      .chain()
      .focus()
      .command(({ tr }) => {
        closeHistory(tr).setSelection(selection);
        return true;
      })
      .setImage(attrs)
      .run();
  } catch (error) {
    toast(error.message);
  } finally {
    editor.off("transaction", track);
  }
}
