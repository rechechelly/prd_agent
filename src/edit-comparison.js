import { diffArrays } from "diff";
import DOMPurify from "dompurify";

// Apply the same ordered edit list to either the review surface or a clean document.
export function planEdits(base, proposal, generated) {
  const parse = (html) =>
    new DOMParser().parseFromString(DOMPurify.sanitize(html), "text/html");
  const before = parse(base),
    after = parse(proposal);
  let count = 0;
  const key = (n) => n.outerHTML ?? n.nodeType + ":" + n.nodeValue;
  const shell = (n) => n.cloneNode(false).outerHTML;
  const copy = (n) => (parent) => parent.append(n.cloneNode(true));
  function mark(parent, node, kind, id) {
    const el =
      node.nodeType === 1
        ? node.cloneNode(true)
        : document.createElement("span");
    if (node.nodeType !== 1) el.textContent = node.textContent;
    el.dataset.inlineDelta = kind;
    el.dataset.inlineChange = id;
    parent.append(el);
  }
  function replacement(oldNodes, newNodes) {
    const id = count++;
    return (parent, choice) => {
      const mode = choice(id);
      if (mode === "review") {
        oldNodes.forEach((n) => mark(parent, n, "remove", id));
        newNodes.forEach((n) => mark(parent, n, "add", id));
      } else
        (mode === "keep" ? newNodes : oldNodes).forEach((n) => copy(n)(parent));
    };
  }
  function textEdit(a, b) {
    const tokens = (value) =>
      value.match(/\d+(?:[.,]\d+)*|[A-Za-z_][A-Za-z_0-9]*|[\s\S]/gu) || [];
    const parts = diffArrays(tokens(a.data), tokens(b.data), {
      maxEditLength: 180,
    });
    if (!parts) return replacement([a], [b]);
    // Nearby character substitutions form one phrase. Distinct phrases can be kept separately.
    const ops = [];
    let group = [];
    function flush() {
      if (!group.length) return;
      const changes = group;
      group = [];
      const id = count++;
      ops.push((parent, choice) => {
        const mode = choice(id);
        for (const part of changes) {
          const text = part.value.join("");
          if (!part.added && !part.removed) parent.append(text);
          else if (mode === "review")
            mark(
              parent,
              document.createTextNode(text),
              part.added ? "add" : "remove",
              id,
            );
          else if ((mode === "keep") === !!part.added) parent.append(text);
        }
      });
    }
    parts.forEach((p, i) => {
      if (
        !p.added &&
        !p.removed &&
        (i === 0 || i === parts.length - 1 || p.value.join("").length >= 4)
      ) {
        flush();
        ops.push((parent) => parent.append(p.value.join("")));
      } else group.push(p);
    });
    flush();
    return (parent, choice) => ops.forEach((op) => op(parent, choice));
  }
  function pair(a, b) {
    if (a.nodeType === 3 && b.nodeType === 3) return textEdit(a, b);
    if (
      a.nodeType !== 1 ||
      b.nodeType !== 1 ||
      shell(a) !== shell(b) ||
      !a.childNodes.length ||
      !b.childNodes.length
    )
      return replacement([a], [b]);
    const children = align(a, b);
    return (parent, choice) => {
      const el = b.cloneNode(false);
      children.forEach((op) => op(el, choice));
      parent.append(el);
    };
  }
  function align(a, b) {
    const left = [...a.childNodes],
      right = [...b.childNodes];
    const chunks = diffArrays(left.map(key), right.map(key), {
      maxEditLength: 400,
    });
    if (!chunks) return [replacement(left, right)];
    let l = 0,
      r = 0,
      removed = [],
      added = [];
    const ops = [];
    function flush() {
      if (!removed.length && !added.length) return;
      const n = Math.min(removed.length, added.length);
      for (let i = 0; i < n; i++) ops.push(pair(removed[i], added[i]));
      if (removed.length !== added.length)
        ops.push(replacement(removed.slice(n), added.slice(n)));
      removed = [];
      added = [];
    }
    for (const part of chunks) {
      if (part.removed) {
        removed.push(...left.slice(l, l + part.count));
        l += part.count;
      } else if (part.added) {
        added.push(...right.slice(r, r + part.count));
        r += part.count;
      } else {
        flush();
        for (let i = 0; i < part.count; i++) ops.push(copy(right[r + i]));
        l += part.count;
        r += part.count;
      }
    }
    flush();
    return ops;
  }
  // Reserve our preview attributes for review markup, including when reopening imported HTML.
  for (const doc of [before, after])
    for (const el of doc.querySelectorAll(
      "[data-inline-change],[data-inline-delta]",
    )) {
      el.removeAttribute("data-inline-change");
      el.removeAttribute("data-inline-delta");
    }
  const ops = align(before.body, after.body);
  const metaChanged =
    generated &&
    (before.head.innerHTML !== after.head.innerHTML ||
      shell(before.body) !== shell(after.body) ||
      shell(before.documentElement) !== shell(after.documentElement));
  const meta = metaChanged ? count++ : -1;
  function build(choice) {
    const doc = (
      meta < 0 || choice(meta) === "undo" ? before : after
    ).cloneNode(true);
    doc.body.replaceChildren();
    for (const op of ops) op(doc.body, choice);
    if (meta >= 0 && choice(meta) === "review") {
      const label = doc.createElement("p");
      label.textContent = "页面样式或文档属性已修改";
      mark(doc.body, label, "add", meta);
    }
    return doc;
  }
  return {
    count,
    preview: (choices) => build((id) => choices[id] || "review"),
    content(choice) {
      const doc = build(choice);
      return generated
        ? "<!doctype html>" + doc.documentElement.outerHTML
        : doc.body.innerHTML;
    },
  };
}

export function wireEdits(root, decide, focusIndex) {
  const groups = new Map();
  for (const el of root.querySelectorAll("[data-inline-change]"))
    groups.set(Number(el.dataset.inlineChange), el);
  for (const [id, el] of groups) {
    const buttons = root.ownerDocument.createElement("span");
    buttons.className = "inline-edit-actions";
    for (const [label, keep] of [
      ["Undo", false],
      ["Keep", true],
    ]) {
      const button = root.ownerDocument.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.title = (keep ? "采用" : "放弃") + "此处修改";
      button.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        decide(id, keep);
      };
      buttons.append(button);
    }
    // Keep controls outside links and inside valid table/list containers.
    if (el.matches("tr,thead,tbody,tfoot,ul,ol,table")) {
      (
        el.querySelector("td:last-child,th:last-child,li:last-child") || el
      ).append(buttons);
    } else if (el.matches("td,th,li")) el.append(buttons);
    else {
      const line = el.closest("p,h1,h2,h3,h4,h5,h6,td,th,li,figcaption,pre");
      if (
        line &&
        line !== el &&
        [...line.querySelectorAll("[data-inline-change]")].every(
          (n) => Number(n.dataset.inlineChange) === id,
        )
      ) {
        buttons.classList.add("end-of-edit");
        line.append(buttons);
      } else (el.closest("a") || el).after(buttons);
    }
  }
  if (focusIndex != null)
    ([...groups].find(([id]) => id >= focusIndex) ||
      [...groups].at(-1))?.[1].scrollIntoView({ block: "center" });
}
