import { $ } from "../shared";
export function installLayout() {
  const layout = $("layout"),
    side = $("sidebar"),
    menu = $("menu"),
    agent = $("agent"),
    main = layout.querySelector("main");
  const saved = JSON.parse(localStorage.getItem("xuye.panels") || "{}");
  const panels = {
    left: saved.left || 224,
    right: saved.right || 374,
    closed: !!saved.closed,
  };
  const mobile = matchMedia("(max-width: 820px)");
  let drawerOpen = false;
  function save() {
    localStorage.setItem("xuye.panels", JSON.stringify(panels));
  }
  function apply() {
    const expanded = mobile.matches ? drawerOpen : !panels.closed;
    const left = Math.min(panels.left, innerWidth * 0.36);
    const right = Math.min(
      panels.right,
      Math.max(205, innerWidth - (panels.closed ? 0 : left) - 330),
    );
    layout.style.setProperty("--left-w", left + "px");
    layout.style.setProperty("--right-w", right + "px");
    layout.classList.toggle("closed-dir", !expanded);
    menu.setAttribute("aria-expanded", String(expanded));
    menu.title = menu.ariaLabel = expanded ? "收起文件目录" : "展开文件目录";
  }
  function separator(which, parent) {
    const el = document.createElement("div");
    el.className = "split " + which;
    el.setAttribute("role", "separator");
    el.setAttribute("aria-orientation", "vertical");
    el.setAttribute(
      "aria-label",
      which === "left" ? "调整目录和正文宽度" : "调整正文和助手宽度",
    );
    el.tabIndex = 0;
    parent.append(el);
    const resize = (x) => {
      panels[which] = Math.max(
        which === "left" ? 145 : 205,
        Math.min(x, innerWidth * 0.6),
      );
      apply();
    };
    el.onpointerdown = (e) => {
      el.setPointerCapture(e.pointerId);
      layout.classList.add("resizing");
      el.onpointermove = (e) =>
        resize(which === "left" ? e.clientX : innerWidth - e.clientX);
      el.onlostpointercapture = () => {
        el.onpointermove = null;
        layout.classList.remove("resizing");
        save();
      };
    };
    el.onkeydown = (e) => {
      if (!["ArrowLeft", "ArrowRight"].includes(e.key)) return;
      e.preventDefault();
      resize(
        panels[which] +
          (e.key === "ArrowRight" ? 16 : -16) * (which === "left" ? 1 : -1),
      );
      save();
    };
  }
  separator("left", side);
  separator("right", agent);
  function closeDrawer() {
    if (!mobile.matches || !drawerOpen) return;
    if (side.contains(document.activeElement)) menu.focus({ preventScroll: true });
    drawerOpen = false;
    apply();
  }
  menu.onclick = () => {
    if (mobile.matches) drawerOpen = !drawerOpen;
    else {
      panels.closed = !panels.closed;
      save();
    }
    apply();
  };
  side.addEventListener("keydown", event => {
    if (!event.defaultPrevented && event.key === "Escape") closeDrawer();
  });
  mobile.addEventListener("change", () => {
    if (!mobile.matches) drawerOpen = false;
    apply();
  });
  window.addEventListener("resize", apply);
  apply();
  const center = document.createElement("div");
  center.id = "centerArea";
  const body = document.createElement("div");
  body.id = "panelArea";
  main.append(body);
  body.append(center, agent);
  for (const id of ["work", "boardPage", "result", "emptyPage"])
    center.append($(id));
  // Tiptap starts tracking modifier keys on mousedown. Seed its listener when Shift was already held before the drag.
  let resizingImage = false;
  document.addEventListener(
    "mousedown",
    (e) => {
      resizingImage = Boolean(e.target.closest?.("[data-resize-handle]"));
    },
    true,
  );
  document.addEventListener(
    "mousemove",
    (e) => {
      if (resizingImage)
        document.dispatchEvent(
          new KeyboardEvent(e.shiftKey ? "keydown" : "keyup", { key: "Shift" }),
        );
    },
    true,
  );
  document.addEventListener(
    "mouseup",
    () => {
      resizingImage = false;
    },
    true,
  );
  return closeDrawer;
}
