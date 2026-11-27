import { $, icon, confirmDelete, dialog } from "../shared";
import { changed, online } from "../service";
import { DEFAULT_CONTEXT_WINDOW, MIN_CONTEXT_WINDOW, isContextWindow } from "../../shared/chat-sessions.mjs";
import { sessionName } from "./chat-sessions";

export function installContextWindow(readContext) {
  const meter = $("agentContextMeter"), button = $("agentContextWindow"), tip = $("contextUsage");
  const format = new Intl.NumberFormat("zh-CN");
  const limitFor = session => isContextWindow(session.contextWindow) ? session.contextWindow : DEFAULT_CONTEXT_WINDOW;
  function render() {
    const { session, used } = readContext();
    meter.hidden = !online || !session;
    if (meter.hidden) return;
    const limit = limitFor(session);
    const percent = used == null ? null : Math.round(used / limit * 100);
    button.style.setProperty("--used", Math.min(100, percent ?? 0) + "%");
    tip.firstElementChild.textContent = percent == null ? "上下文用量待统计" : "上下文窗口 · 已用 " + percent + "%";
    tip.lastElementChild.textContent = (used == null ? "总计 " : format.format(used) + " / ") + format.format(limit) + " 标记";
  }
  meter.onpointerenter = button.onfocus = () => { delete meter.dataset.dismissed; };
  button.onkeydown = e => { if (e.key === "Escape") meter.dataset.dismissed = ""; };
  button.onclick = () => {
    const { session } = readContext();
    const limit = limitFor(session);
    dialog("会话上下文窗口",
      `<label for="windowLimit">窗口大小（标记）</label><input id="windowLimit" name="limit" type="number" min="${MIN_CONTEXT_WINDOW}" step="1" value="${limit}" required aria-describedby="windowHint">
      <p id="windowHint">最少 ${format.format(MIN_CONTEXT_WINDOW)} 个标记。同一会话中的所有模型共用此设置，从下次发送消息起生效。</p>`,
      data => {
        const value = Number(data.limit);
        if (!isContextWindow(value)) {
          const input = $("windowLimit");
          input.setCustomValidity("请输入可以精确表示的正整数");
          input.reportValidity();
          return false;
        }
        session.contextWindow = value;
        changed();
        render();
      }, "保存");
    $("windowLimit").oninput = e => e.target.setCustomValidity("");
    $("windowLimit").select();
  };
  return render;
}

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
