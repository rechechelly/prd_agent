import { $ } from "../shared";

export function installDocumentOutline(editorRoot) {
  const body = $("documentBody"),
    pane = $("paperScroll"),
    preview = $("draftPreview");
  const nav = $("documentOutline"),
    list = $("outlineItems");
  const rail = $("outlineRail"),
    trigger = $("outlineToggle"),
    divider = $("outlineResize");
  const widthKey = "xuye.outline.width";
  let preferredWidth = Number(localStorage.getItem(widthKey)) || undefined;
  let compact = false,
    drawerOpen = false;
  let collapsed = localStorage.getItem("xuye.outline") === "closed";
  let headings = [],
    current,
    jump,
    frame,
    dirty = true;

  function layout() {
    const visible = headings.length > 0 && (compact ? drawerOpen : !collapsed);
    nav.hidden = !visible;
    rail.hidden = !headings.length;
    rail.classList.toggle("expanded", visible);
    const label = visible ? "收起文档目录" : "展开文档目录";
    trigger.title = label;
    trigger.setAttribute("aria-label", label);
    trigger.setAttribute("aria-expanded", String(visible));
    body.classList.toggle("compactOutline", compact);
  }
  function toggle(visible) {
    if (compact) drawerOpen = visible;
    else {
      collapsed = !visible;
      localStorage.setItem("xuye.outline", visible ? "open" : "closed");
    }
    layout();
    trigger.focus({ preventScroll: true });
    if (visible) schedule();
  }
  trigger.onclick = () => toggle(nav.hidden);
  body.addEventListener("keydown", (event) => {
    if (
      event.key === "Escape" &&
      !nav.hidden &&
      (nav.contains(event.target) || trigger.contains(event.target))
    ) {
      event.preventDefault();
      toggle(false);
    }
  });
  pane.addEventListener("pointerdown", () => {
    if (compact && drawerOpen) {
      drawerOpen = false;
      layout();
    }
  });
  let minWidth, maxWidth, width;
  function updateWidth(value) {
    const available = body.clientWidth;
    if (!available) return;
    maxWidth = Math.max(
      1,
      Math.floor(
        compact ? available * 0.84 : available - Math.max(360, available * 0.5),
      ),
    );
    minWidth = Math.min(128, maxWidth);
    const fallback = compact
      ? 220
      : Math.max(150, Math.min(218, available * 0.15));
    width = Math.round(
      Math.max(minWidth, Math.min(maxWidth, value ?? fallback)),
    );
    body.style.setProperty("--outline-width", width + "px");
    divider.setAttribute("aria-valuemin", minWidth);
    divider.setAttribute("aria-valuemax", maxWidth);
    divider.setAttribute("aria-valuenow", width);
    divider.setAttribute("aria-valuetext", width + " 像素");
  }
  function setWidth(value) {
    updateWidth(value);
    preferredWidth = width;
  }
  divider.onpointerdown = (event) => {
    if (event.button !== 0 || !event.isPrimary) return;
    event.preventDefault();
    const originX = event.clientX,
      initialWidth = width;
    divider.focus({ preventScroll: true });
    divider.setPointerCapture(event.pointerId);
    body.classList.add("resizingOutline");
    divider.onpointermove = (move) => {
      if (move.pointerId === event.pointerId)
        setWidth(initialWidth + move.clientX - originX);
    };
    divider.onlostpointercapture = () => {
      divider.onpointermove = null;
      body.classList.remove("resizingOutline");
      if (preferredWidth) localStorage.setItem(widthKey, preferredWidth);
    };
  };
  divider.onkeydown = (event) => {
    const value = {
      ArrowLeft: width - 16,
      ArrowRight: width + 16,
      Home: minWidth,
      End: maxWidth,
    }[event.key];
    if (value === undefined) return;
    event.preventDefault();
    setWidth(value);
    localStorage.setItem(widthKey, preferredWidth);
  };

  function refresh() {
    const reviewing = !preview.hidden;
    const root = reviewing ? preview : editorRoot;
    const next = [];
    for (const node of root.querySelectorAll("h1,h2,h3,h4")) {
      let text = node.textContent;
      if (reviewing) {
        if (node.closest('[data-inline-delta="remove"]')) continue;
        const copy = node.cloneNode(true);
        copy
          .querySelectorAll('[data-inline-delta="remove"],.inline-edit-actions')
          .forEach((el) => el.remove());
        text = copy.textContent;
      }
      const label = text.trim();
      if (label) next.push({ node, label });
    }
    if (
      next.length === headings.length &&
      next.every(
        (item, i) =>
          item.node === headings[i].node && item.label === headings[i].label,
      )
    )
      return;
    headings = next;
    current = undefined;
    jump = null;
    list.replaceChildren(
      ...headings.map(({ node, label }) => {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = button.title = label;
        button.style.setProperty("--depth", Number(node.tagName[1]) - 1);
        button.onclick = () => {
          if (compact) toggle(false);
          pane.scrollTop +=
            node.getBoundingClientRect().top -
            pane.getBoundingClientRect().top -
            16;
          jump = { node, top: pane.scrollTop };
          updateCurrent();
        };
        return button;
      }),
    );
    layout();
  }

  function updateCurrent() {
    if (nav.hidden || !pane.clientHeight) return;
    const top = pane.getBoundingClientRect().top + 18;
    let index = 0;
    if (jump && Math.abs(pane.scrollTop - jump.top) < 1) {
      index = headings.findIndex(({ node }) => node === jump.node);
    } else {
      jump = null;
      if (
        pane.scrollTop > 0 &&
        pane.scrollHeight - pane.clientHeight - pane.scrollTop < 2
      )
        index = headings.length - 1;
      else {
        for (let i = 1; i < headings.length; i++) {
          if (headings[i].node.getBoundingClientRect().top > top) break;
          index = i;
        }
      }
    }
    const button = list.children[index];
    if (button === current || !button) return;
    current?.removeAttribute("aria-current");
    current = button;
    button.setAttribute("aria-current", "location");
    const box = button.getBoundingClientRect(),
      view = list.getBoundingClientRect();
    if (box.top < view.top) list.scrollTop += box.top - view.top;
    else if (box.bottom > view.bottom)
      list.scrollTop += box.bottom - view.bottom;
  }

  function schedule() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (dirty) refresh();
      dirty = false;
      updateCurrent();
    });
  }
  const observer = new MutationObserver(() => {
    dirty = true;
    schedule();
  });
  const content = { childList: true, characterData: true, subtree: true };
  observer.observe(editorRoot, content);
  observer.observe(preview, {
    ...content,
    attributes: true,
    attributeFilter: ["hidden"],
  });
  pane.addEventListener("scroll", schedule, { passive: true });
  const resize = new ResizeObserver(() => {
    if (!body.clientWidth) return;
    const narrow = body.clientWidth < 700;
    if (compact !== narrow) {
      compact = narrow;
      drawerOpen = false;
    }
    updateWidth(preferredWidth);
    layout();
    schedule();
  });
  resize.observe(body);
  resize.observe($("paper"));
  schedule();
}
