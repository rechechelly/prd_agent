import { $ } from "../shared";

export function installComposer(renderMarkdown, ask) {
  const form = $("askForm"), input = $("question"), grip = $("composerGrip");
  const preview = $("questionPreview"), button = $("previewQuestion");
  const storageKey = "xuye.composerHeight";
  let height = Number(localStorage.getItem(storageKey)) || 70;
  function resize(value) {
    const maximum = Math.max(62, Math.min(540, Math.floor(innerHeight * 0.52)));
    height = Math.max(62, Math.min(maximum, value));
    form.style.setProperty("--question-height", height + "px");
    grip.setAttribute("aria-valuenow", height);
    grip.setAttribute("aria-valuemax", maximum);
  }
  resize(height);
  grip.onpointerdown = event => {
    if (event.button !== 0) return;
    const initial = height, top = event.clientY;
    grip.setPointerCapture(event.pointerId);
    grip.onpointermove = move => resize(initial + top - move.clientY);
    grip.onlostpointercapture = () => {
      grip.onpointermove = null;
      localStorage.setItem(storageKey, height);
    };
  };
  grip.onkeydown = event => {
    if (!["ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    resize(height + (event.key === "ArrowUp" ? 16 : -16));
    localStorage.setItem(storageKey, height);
  };
  window.addEventListener("resize", () => resize(height));
  input.onkeydown = event => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      form.requestSubmit();
    }
  };
  form.onsubmit = event => {
    event.preventDefault();
    if (input.value.trim()) ask(input.value);
  };
  function edit() {
    preview.hidden = true;
    input.hidden = false;
    button.setAttribute("aria-pressed", "false");
    button.textContent = "预览";
  }
  button.onclick = () => {
    if (!preview.hidden) {
      edit();
      input.focus();
    } else if (input.value.trim()) {
      renderMarkdown(preview, input.value);
      preview.hidden = false;
      input.hidden = true;
      button.setAttribute("aria-pressed", "true");
      button.textContent = "编辑";
    } else input.focus();
  };
  return edit;
}
