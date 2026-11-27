export const $ = (id) => document.getElementById(id);
export const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const paths = {
  quote: "M4 6h6v7H6c0 2 1 3 3 4l-1 2c-3-1-5-4-5-7z M15 6h6v7h-4c0 2 1 3 3 4l-1 2c-3-1-5-4-5-7z",
  pencil: "M4 16l11-11 4 4L8 20l-5 1z M13 7l4 4",
  chat: "M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 3v-3H3V6a2 2 0 0 1 2-2z",
  history: "M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18z M12 7v5l3 2",
  panel: "M3 5h18v14H3z M15 5v14",
  clip: "M8 13l6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l9-9a4 4 0 0 1 6 6l-8 8",
  up: "M12 19V5 M6 11l6-6 6 6",
  arrowRight: "M4 12h16 M13 5l7 7-7 7",
  down: "M7 10l5 5 5-5",
  copy: "M8 3h12v14H8z M5 7H3v14h12v-2",
  agentMode:
    "M12 12c-3-5-4-6-6-6-5 0-5 12 0 12 2 0 4-3 6-6s4-6 6-6c5 0 5 12 0 12-2 0-4-3-6-6z",
  brand: "M4 6l8-3 8 3v12l-8 3-8-3z M4 6l8 3 8-3 M12 9v12 M8 4.5l8 3",
  doc: "M6 3h8l4 4v14H6z M14 3v5h4 M9 12h6 M9 16h6",
  board: "M3 3h8v7H3z M14 5h7v12h-7z M5 13h6v8H5z",
  folder: "M2 7h7l2 2h10v11H2z",
  folderPlus: "M2 6h7l2 2h10v12H2z M11 11v6 M8 14h6",
  plus: "M12 4v16 M4 12h16",
  settings: "M3 7h18 M3 17h18 M8 4v6 M16 14v6",
  spark:
    "M13 2l2.2 6.8L22 11l-6.8 2.2L13 20l-2.2-6.8L4 11l6.8-2.2z M4 2v4 M2 4h4",
  bolt: "M13 2L5 13h6l-1 9 9-13h-7z",
  list: "M4 6h1m3 0h12 M4 12h1m3 0h12 M4 18h1m3 0h12",
  image: "M3 4h18v16H3z M4 17l5-5 4 4 3-3 4 5 M15 8h2",
  table: "M3 4h18v16H3z M3 10h18 M10 4v16",
  undo: "M8 4L3 9l5 5 M3 9h10a7 7 0 0 1 7 7",
  search: "M16 16l5 5 M18 10a8 8 0 1 1-16 0 8 8 0 1 1 16 0",
  check: "M4 12l5 5L20 6",
  trash: "M4 6h16 M9 6V3h6v3 M6 6l1 15h10l1-15 M10 10v7 M14 10v7",
  code: "M8 7l-5 5 5 5 M16 7l5 5-5 5",
  note: "M4 4h16v12l-4 4H4z M8 9h8 M8 13h6",
};
export function icon(name) {
  return (
    '<i data-ico="' +
    name +
    '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' +
    paths[name] +
    '"/></svg></i>'
  );
}
export function decorate() {
  document
    .querySelectorAll("i[data-ico]:empty")
    .forEach((el) => (el.outerHTML = icon(el.dataset.ico)));
}
let timer;
export function toast(message) {
  $("toast").textContent = message;
  $("toast").hidden = false;
  clearTimeout(timer);
  timer = setTimeout(() => ($("toast").hidden = true), 2800);
}
export function dialog(title, fields, callback, action = "确定") {
  $("modalForm").oninput = null;
  $("cancel").textContent = "取消";
  $("modalTitle").textContent = title;
  $("fields").innerHTML = fields;
  $("submit").hidden = false;
  $("submit").textContent = action;
  $("submit").classList.toggle("danger", action === "删除");
  $("modal").showModal();
  $("modalForm").onsubmit = (e) => {
    e.preventDefault();
    if (!e.target.reportValidity()) return;
    const data = Object.fromEntries(new FormData(e.target));
    if (callback(data) !== false) $("modal").close();
  };
}
$("cancel").onclick = () => $("modal").close();
export function confirmDelete(message, onConfirm) {
  dialog("确认删除", "<p>" + esc(message) + "</p>", onConfirm, "删除");
}

// Browsers with native light dismiss handle the topmost dialog and its backdrop.
if (!("closedBy" in HTMLDialogElement.prototype)) {
  let pressed;
  function backdrop(event) {
    const dialog = event.target;
    if (
      !(dialog instanceof HTMLDialogElement) ||
      !dialog.matches('[open][closedby="any"]')
    )
      return null;
    const rect = dialog.getBoundingClientRect();
    return event.clientX < rect.left ||
      event.clientX >= rect.right ||
      event.clientY < rect.top ||
      event.clientY >= rect.bottom
      ? dialog
      : null;
  }
  document.addEventListener(
    "pointerdown",
    (event) => {
      pressed = event.button === 0 && event.isPrimary ? backdrop(event) : null;
    },
    true,
  );
  document.addEventListener(
    "pointercancel",
    () => {
      pressed = null;
    },
    true,
  );
  document.addEventListener(
    "click",
    (event) => {
      const dialog = backdrop(event);
      if (event.detail && dialog && pressed === dialog) dialog.close();
      pressed = null;
    },
    true,
  );
}
