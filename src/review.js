import { $, toast } from "./shared";
import { api, flush, online } from "./service";
import { createPrdDiscussion } from "./prd-discussion.mjs";
import "./prd-discussion.css";
let events,
  seq = 0,
  discussion;
export function stopReview() {
  seq++;
  events?.close();
  discussion?.unbind();
  events = discussion = null;
  $("reviewPanel").hidden = $("commentsToggle").hidden = true;
}
export function openDiscussion(doc, root, viewOriginal) {
  const current = seq,
    panel = $("reviewPanel");
  if (online) {
    const route =
      "prd-comments?doc=" +
      encodeURIComponent(doc.origin?.doc ?? doc.id) +
      "&version=" +
      (doc.origin?.version ?? 0);
    const toggle = $("commentsToggle");
    toggle.hidden = false;
    toggle.textContent = "评论";
    toggle.setAttribute("aria-expanded", "false");
    toggle.onclick = () => {
      if (panel.hidden && $("work").classList.contains("reviewing-inline"))
        viewOriginal();
      panel.hidden = !panel.hidden;
      toggle.setAttribute("aria-expanded", String(!panel.hidden));
      discussion.setExpanded(!panel.hidden);
    };
    let refreshId = 0;
    const refresh = async () => {
      const id = ++refreshId;
      try {
        const { comments } = await api(route);
        if (current === seq && id === refreshId) {
          discussion.draw(comments);
          toggle.textContent =
            "评论 · " + comments.filter((c) => c.parentId == null).length;
        }
      } catch (error) {
        if (current === seq) toast(error.message);
      }
    };
    discussion = createPrdDiscussion(panel, {
      post: async (comment) => {
        await flush();
        await api(route, comment);
        await refresh();
      },
    });
    panel.hidden = true;
    events = new EventSource("./api/" + route.replace("?", "/events?"));
    events.onopen = events.onmessage = refresh;
    refresh();
    discussion.bind(document, null, null, root);
  }
}
