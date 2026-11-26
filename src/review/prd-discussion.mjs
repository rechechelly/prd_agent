export function createPrdDiscussion(
  container,
  { guest = false, post, onNotice },
) {
  container.innerHTML =
    '<h2>文档评论</h2><div class="comment-list" aria-live="polite"></div>' +
    '<form class="comment-form">' +
    (guest
      ? '<label>署名（选填）<input name="name" maxlength="40"></label>'
      : "") +
    '<div class="comment-quote" hidden><blockquote></blockquote><button type="button">移除引用</button></div>' +
    '<label>评论<textarea name="body" maxlength="2000" required placeholder="选中文字可引用到评论"></textarea></label>' +
    '<button class="comment-send" type="submit">发表评论</button><small role="status"></small></form>';
  const list = container.querySelector(".comment-list"),
    form = container.querySelector("form");
  const quote = form.querySelector(".comment-quote"),
    status = form.querySelector('[role="status"]');
  if (!guest) container.append(status);
  let comments = [],
    selected = null,
    binding,
    replyTo = null,
    expanded = guest;
  form.hidden = !guest;
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "取消回复";
  if (!guest) {
    form.append(cancel);
    form.elements.body.placeholder = "写下回复";
    form.querySelector(".comment-send").textContent = "发送回复";
  }
  cancel.onclick = () => {
    replyTo = null;
    form.hidden = true;
    form.reset();
  };
  function setQuote(value) {
    selected = value;
    quote.hidden = !value;
    quote.querySelector("blockquote").textContent = value?.exact || "";
  }
  quote.querySelector("button").onclick = () => setQuote(null);
  function snapshot(doc) {
    const nodes = [];
    let text = "";
    const walker = doc.createTreeWalker(binding.root, 4);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!node.length || node.parentElement.closest("script,style,noscript"))
        continue;
      nodes.push({ node, start: text.length, end: text.length + node.length });
      text += node.data;
    }
    return { nodes, text };
  }
  function findRange(doc, source, anchor) {
    if (!anchor?.exact) return null;
    const { nodes, text } = source,
      matches = [];
    for (
      let at = text.indexOf(anchor.exact);
      at !== -1;
      at = text.indexOf(anchor.exact, at + 1)
    ) {
      const end = at + anchor.exact.length;
      const score =
        Number(
          Boolean(anchor.prefix) &&
            text.slice(Math.max(0, at - anchor.prefix.length), at) ===
              anchor.prefix,
        ) +
        Number(
          Boolean(anchor.suffix) &&
            text.slice(end, end + anchor.suffix.length) === anchor.suffix,
        );
      matches.push({ at, end, score });
    }
    matches.sort((a, b) => b.score - a.score);
    let match = matches[0];
    if (!match) return null;
    if (matches[1]?.score === match.score) {
      if (!match.score) return null;
      const original = matches.find(
        (m) => m.at === anchor.start && m.score === match.score,
      );
      if (!original) return null;
      match = original;
    }
    const start = nodes.find(
      (node) => node.start <= match.at && node.end > match.at,
    );
    const end = nodes.find(
      (node) => node.start < match.end && node.end >= match.end,
    );
    if (!start || !end) return null;
    const range = doc.createRange();
    range.setStart(start.node, match.at - start.start);
    range.setEnd(end.node, match.end - end.start);
    return range;
  }
  function refreshMarks() {
    if (!binding) return;
    const { doc, win } = binding;
    if (!win.CSS?.highlights || !win.Highlight) return;
    if (!expanded) {
      win.CSS.highlights.delete("xuye-comment");
      win.CSS.highlights.delete("xuye-active-comment");
      return;
    }
    const source = snapshot(doc);
    const ranges = comments
      .map((c) => findRange(doc, source, c.anchor))
      .filter(Boolean);
    win.CSS.highlights.set("xuye-comment", new win.Highlight(...ranges));
  }
  function focusQuote(anchor) {
    if (!binding) {
      status.textContent = "请切换到图文 PRD 查看引用";
      return;
    }
    const { doc, win } = binding;
    const range = findRange(doc, snapshot(doc), anchor);
    if (!range) {
      status.textContent = "原文已修改，评论保留原引用";
      return;
    }
    status.textContent = "";
    range.startContainer.parentElement.scrollIntoView({ block: "center" });
    if (win.CSS?.highlights && win.Highlight)
      win.CSS.highlights.set("xuye-active-comment", new win.Highlight(range));
    else {
      const selection = win.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }
  function draw(records) {
    comments = records;
    list.replaceChildren();
    const threads = new Map();
    for (const comment of comments) {
      const entry = document.createElement("article"),
        author = document.createElement("b");
      author.textContent = comment.name || "访客";
      entry.append(author);
      if (comment.anchor) {
        const anchor = document.createElement("button");
        anchor.type = "button";
        anchor.className = "comment-anchor";
        anchor.textContent = comment.anchor.exact.trim();
        anchor.title = "定位原文";
        anchor.onclick = () => focusQuote(comment.anchor);
        entry.append(anchor);
      }
      const message = document.createElement("p");
      message.textContent = comment.body;
      entry.append(message);
      if (comment.parentId != null && threads.has(comment.parentId)) {
        entry.className = "comment-reply";
        threads.get(comment.parentId).append(entry);
      } else {
        threads.set(comment.id, entry);
        list.append(entry);
        if (!guest) {
          const reply = document.createElement("button");
          reply.type = "button";
          reply.textContent = "回复";
          reply.className = "replyButton";
          reply.onclick = () => {
            if (replyTo !== comment.id) form.reset();
            replyTo = comment.id;
            form.hidden = false;
            status.textContent =
              "回复 " + comment.name + " · " + comment.body.slice(0, 40);
            form.elements.body.focus();
          };
          entry.append(reply);
        }
      }
    }
    if (!comments.length) list.textContent = "暂无评论";
    refreshMarks();
  }
  function bind(doc, openPrototype, onEdit, root = doc.body) {
    binding?.close();
    const listeners = new doc.defaultView.AbortController(),
      options = { signal: listeners.signal };
    const win = doc.defaultView;
    binding = {
      doc,
      win,
      root,
      close() {
        listeners.abort();
        marks.remove();
        win.CSS?.highlights?.delete("xuye-comment");
        win.CSS?.highlights?.delete("xuye-active-comment");
      },
    };
    const marks = doc.createElement("style");
    marks.dataset.prdReviewMarks = "";
    marks.textContent =
      "::highlight(xuye-comment){background:#f1e8ff;text-decoration:underline #7546a8}::highlight(xuye-active-comment){background:#ffd98d;text-decoration:underline #956411}";
    doc.head.append(marks);
    doc.addEventListener(
      "selectionchange",
      () => {
        if (!guest || binding?.doc !== doc) return;
        const selection = win.getSelection();
        if (!selection?.rangeCount || selection.isCollapsed) return;
        const range = selection.getRangeAt(0),
          raw = range.toString(),
          exact = raw.trim();
        if (!exact || !root.contains(range.commonAncestorContainer)) return;
        if (exact.length > 1000) {
          setQuote(null);
          status.textContent = "请选择不超过 1000 字的片段";
          return;
        }
        const before = doc.createRange();
        before.setStart(root, 0);
        before.setEnd(range.startContainer, range.startOffset);
        const start = before.toString().length + raw.indexOf(exact),
          text = snapshot(doc).text;
        setQuote({
          exact,
          start,
          prefix: text.slice(Math.max(0, start - 48), start),
          suffix: text.slice(start + exact.length, start + exact.length + 48),
        });
        status.textContent = "";
      },
      options,
    );
    doc.addEventListener(
      "click",
      (event) => {
        const link = event.target.closest?.("a[href]");
        if (
          openPrototype &&
          link &&
          /^(?:\.\/)?prototype\.html(?:[?#].*)?$/i.test(
            link.getAttribute("href"),
          )
        ) {
          event.preventDefault();
          openPrototype();
        }
      },
      options,
    );
    root.addEventListener(
      "input",
      () => {
        if (binding?.doc !== doc) return;
        onEdit?.(doc);
        refreshMarks();
      },
      options,
    );
    refreshMarks();
  }
  form.onsubmit = async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    data.anchor = guest ? selected : null;
    if (!guest) {
      if (!replyTo) return;
      data.parentId = replyTo;
    }
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    try {
      await post(data);
      form.elements.body.value = "";
      setQuote(null);
      status.textContent = guest ? "评论已发表" : "回复已发表";
      if (!guest) {
        replyTo = null;
        form.hidden = true;
      }
      onNotice?.();
    } catch (error) {
      status.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  };
  return {
    draw,
    bind,
    setExpanded(value) {
      expanded = value;
      refreshMarks();
    },
    unbind() {
      binding?.close();
      binding = null;
    },
    disable() {
      form.hidden = true;
      binding?.close();
      binding = null;
    },
  };
}
