import { api, flush } from "../service";

const states = new WeakMap();
export function queueState(session) {
  if (!states.has(session)) states.set(session, {
    items: [], chain: Promise.resolve(), loading: 0, initialized: false, stopped: false,
  });
  return states.get(session);
}

// Serialize clicks and admissions from this composer, including a quick series
// of Enter presses while the first HTTP request is still in flight.
export function syncQueue(file, session, action, input = {}) {
  const state = queueState(session);
  state.loading++;
  const operation = state.chain.then(async () => {
    await flush();
    const { items } = await api("agent/queue", { doc: file.id, chatId: session.id, action, ...input });
    state.items = items;
  }).finally(() => state.loading--);
  state.chain = operation.catch(() => {});
  return operation;
}

export function renderQueue(session, pending, blocked, prioritize) {
  const state = queueState(session);
  const panel = document.getElementById("messageQueue");
  const items = state.items.filter(item => item.requestId !== pending?.requestId);
  panel.hidden = !items.length;
  panel.replaceChildren();
  if (!items.length) return;
  const title = document.createElement("strong");
  title.textContent = "待发送 · " + items.length;
  panel.append(title);
  if (blocked) {
    const hint = document.createElement("small");
    hint.textContent = "处理待采纳修改后继续发送";
    panel.append(hint);
  }
  const list = document.createElement("ol");
  for (const item of items) {
    const row = document.createElement("li");
    const text = document.createElement("span");
    text.textContent = text.title = item.question;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "立即发送";
    button.ariaLabel = "立即发送：" + item.question;
    button.disabled = !!state.promoting || blocked;
    button.onclick = () => prioritize(item);
    row.append(text, button);
    list.append(row);
  }
  panel.append(list);
}
