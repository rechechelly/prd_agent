// Keep the badge outside contenteditable so showing it never moves the caret or wraps the line.
export function showCompletionIndicator(view, position, signal) {
  const viewport = view.dom.closest("#paperScroll, #htmlSourceEditor");
  const badge = document.createElement("span");
  badge.className = "completionPending";
  badge.setAttribute("role", "status");
  badge.textContent = "补全中…";
  document.body.append(badge);

  function place() {
    const caret = view.coordsAtPos(position);
    const bounds = viewport.getBoundingClientRect();
    const left = Math.max(0, bounds.left), right = Math.min(innerWidth, bounds.right);
    const top = Math.max(0, bounds.top), bottom = Math.min(innerHeight, bounds.bottom);
    badge.hidden = caret.bottom <= top || caret.top >= bottom || caret.left < left || caret.left > right;
    if (badge.hidden) return;
    badge.style.left = Math.max(left + 3, Math.min(caret.left, right - badge.offsetWidth - 3)) + "px";
    const below = caret.bottom + 3;
    badge.style.top = (below + badge.offsetHeight <= bottom ? below
      : Math.max(top, caret.top - badge.offsetHeight - 3)) + "px";
  }

  const resize = new ResizeObserver(place);
  resize.observe(viewport);
  window.addEventListener("scroll", place, true);
  window.addEventListener("resize", place);
  function hide() {
    resize.disconnect();
    window.removeEventListener("scroll", place, true);
    window.removeEventListener("resize", place);
    signal.removeEventListener("abort", hide);
    badge.remove();
  }
  signal.addEventListener("abort", hide, { once: true });
  place();
  return hide;
}
