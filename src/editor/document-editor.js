import { Editor } from "@tiptap/core";
import { TaskList, TaskItem } from "@tiptap/extension-list";
import { closeHistory } from "@tiptap/pm/history";
import { NodeSelection } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import { TableKit } from "@tiptap/extension-table";
import { Markdown } from "@tiptap/markdown";
import { $ } from "../shared";
import { DocumentImage, insertDocumentImage } from "./document-image";
import { installBlockTools } from "./block-tools";
import { installDocumentOutline } from "./document-outline";

export function createDocumentEditor({ completion, getFile, quoteSelection, onChange }) {
  function addImage(file) {
    const owner = getFile();
    if (owner && file) void insertDocumentImage(editor, file, () => getFile() === owner);
  }
  const editor = new Editor({
    element: $("editor"),
    extensions: [
      StarterKit.configure({ link: { openOnClick: false } }),
      TaskList,
      TaskItem.configure({ nested: true }),
      TableKit.configure({ table: { resizable: true } }),
      DocumentImage.configure({
        allowBase64: true,
        resize: {
          enabled: true,
          minWidth: 32,
          minHeight: 24,
          directions: ["bottom-right", "right", "bottom"],
          alwaysPreserveAspectRatio: false,
        },
      }),
      Markdown,
    ],
    editorProps: {
      attributes: { "aria-label": "文档正文" },
      handlePaste: (_, e) => {
        const file = [...e.clipboardData.files].find((f) =>
          f.type.startsWith("image/"),
        );
        if (file) {
          addImage(file);
          return true;
        }
        return false;
      },
      handleKeyDown: (view, e) => {
        if (
          !e.isComposing &&
          !e.altKey &&
          (e.ctrlKey || e.metaKey) &&
          e.key.toLowerCase() === "z"
        ) {
          e.preventDefault();
          return e.shiftKey ? editor.commands.redo() : editor.commands.undo();
        }
        const selection = view.state.selection;
        if (
          !e.isComposing &&
          ["Backspace", "Delete"].includes(e.key) &&
          selection instanceof NodeSelection &&
          selection.node.type.name === "image" &&
          !view.dom.querySelector(".marqueeSelected")
        ) {
          view.dispatch(
            closeHistory(view.state.tr).deleteSelection().scrollIntoView(),
          );
          return true;
        }
        return completion.handleKey(view, e);
      },
    },
    onUpdate: ({ editor }) => onChange(editor),
    onBlur: completion.clear,
  });
  installBlockTools(editor, () => $("file").click(), quoteSelection);
  installDocumentOutline(editor.view.dom);
  editor.view.dom.addEventListener("compositionstart", () => {
    completion.composition(true);
  });
  editor.view.dom.addEventListener("compositionend", () => {
    completion.composition(false);
  });
  editor.view.dom.addEventListener("pointerdown", completion.clear);
  $("paperScroll").addEventListener("scroll", completion.reposition, { passive: true });
  editor.on("selectionUpdate", completion.selectionChanged);
  $("file").onchange = (e) => {
    addImage(e.target.files[0]);
    e.target.value = "";
  };
  return editor;
}
