import { $, icon, confirmDelete } from "../shared";
import { sessionName } from "./chat-sessions";

export function editableTab(button, session, rename) {
  const edit = () => {
    if (!button.isConnected) return;
    const input = document.createElement("input");
    input.className = "sessionNameInput";
    input.ariaLabel = "会话名称";
    input.maxLength = 100;
    input.value = sessionName(session);
    button.replaceWith(input);
    input.focus();
    input.select();
    let finished = false;
    const finish = commit => {
      if (finished) return;
      finished = true;
      input.replaceWith(button);
      if (commit && input.value.trim()) rename(input.value.trim());
    };
    input.onblur = () => finish(true);
    input.onkeydown = e => {
      if (e.isComposing || !["Enter","Escape"].includes(e.key)) return;
      e.preventDefault();
      finish(e.key === "Enter");
    };
  };
  button.ondblclick = edit;
  button.onkeydown = e => { if (e.key === "F2") { e.preventDefault(); edit(); } };
}

export function historyPopover(entries, select, remove, busy) {
  const pop = $("historyDialog"), anchor = $("chatHistory");
  if (pop.matches(":popover-open")) return pop.hidePopover();
  const list = $("historyList");
  list.replaceChildren();
  for (const session of entries) {
    const row = document.createElement("div"), item = document.createElement("button");
    const title = document.createElement("b"), time = document.createElement("small");
    title.textContent = sessionName(session);
    time.textContent = session.updatedAt ? new Date(session.updatedAt).toLocaleString("zh-CN") : "";
    item.append(title, time);
    item.onclick = () => { pop.hidePopover(); select(session); };
    const del = document.createElement("button");
    del.ariaLabel = del.title = "删除会话 " + title.textContent;
    del.innerHTML = icon("trash");
    del.disabled = busy(session);
    del.onclick = () => {
      pop.hidePopover();
      confirmDelete("删除「" + title.textContent + "」？所有关联文件都会移除这条会话。", () => remove(session));
    };
    row.append(item, del);
    list.append(row);
  }
  const rect = anchor.getBoundingClientRect();
  pop.style.top = rect.bottom + 4 + "px";
  pop.style.right = Math.max(8, innerWidth - rect.right) + "px";
  pop.showPopover();
}
