import { contextTransfer } from "../../shared/assistant-context.mjs";
import { online } from "../service";
import { $, toast } from "../shared";

const selectionType = "application/x-xuye-selection";

export function installReferenceInput({ editor, getFile, quoteSelection, attachFile, uploadFiles, attachText }) {
  const panel = $("agent"), htmlInput = $("htmlInput");
  let dragged;

  function remember(event, selection, raw) {
    const file = getFile();
    dragged = { file, source: file.html, selection, raw, doc: editor.state.doc };
    event.dataTransfer.setData(selectionType, file.id);
  }
  editor.view.dom.addEventListener("dragstart", event => {
    const { selection } = editor.state;
    if (!selection.empty && editor.state.doc.textBetween(selection.from, selection.to))
      remember(event, selection);
  });
  htmlInput.addEventListener("dragstart", event => {
    const { selectionStart, selectionEnd, value } = htmlInput;
    if (selectionStart !== selectionEnd) remember(event, null, { selectionStart, selectionEnd, value });
  });
  const accepts = transfer => [contextTransfer, selectionType, "text/plain", "Files"]
    .some(type => transfer.types.includes(type));
  panel.ondragover = event => {
    if (!accepts(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    panel.classList.add("accept-context");
  };
  panel.ondragleave = event => {
    if (!panel.contains(event.relatedTarget)) panel.classList.remove("accept-context");
  };
  document.addEventListener("dragend", () => {
    dragged = null;
    panel.classList.remove("accept-context");
  });
  panel.ondrop = event => {
    const transfer = event.dataTransfer;
    panel.classList.remove("accept-context");
    if (!accepts(transfer)) return;
    event.preventDefault();
    event.stopPropagation();
    if (transfer.files.length) return uploadFiles(Array.from(transfer.files));
    if (transfer.types.includes(contextTransfer)) {
      try { attachFile(JSON.parse(transfer.getData(contextTransfer))); }
      catch { toast("无法读取这份文件引用"); }
    } else if (transfer.types.includes(selectionType)) {
      const captured = dragged;
      dragged = null;
      if (!captured || captured.file !== getFile() || captured.source !== captured.file.html ||
          (!captured.raw && captured.doc !== editor.state.doc))
        return toast("选区来源已变化，请在当前文件重新划词");
      quoteSelection(captured.selection, captured.raw);
    } else {
      const text = transfer.getData("text/plain");
      if (text.trim()) attachText(text);
    }
  };
  $("question").addEventListener("paste", event => {
    const data = event.clipboardData;
    if (!data) return;
    let images = Array.from(data.files).filter(file => file.type.startsWith("image/"));
    if (!images.length) images = Array.from(data.items)
      .filter(item => item.kind === "file" && item.type.startsWith("image/"))
      .map(item => item.getAsFile()).filter(Boolean);
    if (!images.length) return;
    if (!data.getData("text/plain")) event.preventDefault();
    uploadFiles(images);
  });
  $("attachContext").onclick = () => {
    if (online) $("chatFiles").click();
    else toast("请在登录版写作助手中上传附件");
  };
  $("chatFiles").onchange = event => {
    const files = Array.from(event.target.files);
    event.target.value = "";
    uploadFiles(files);
  };
}
