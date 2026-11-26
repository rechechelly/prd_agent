import {
  contextTransfer,
  fileLabel,
  fileLabels,
} from "./assistant-context.mjs";
import { $, icon } from "./shared";

let previousClick;
const itemTransfer = "application/x-xuye-directory";
export { fileLabel } from "./assistant-context.mjs";
export const outputLabel = (output) =>
  output.directoryName || "交付件 · v" + output.version;
export const outputKeys = (output) =>
  [...new Set([...(output.fileOrder || []), "html", "prd"])].filter(
    (key) => Object.hasOwn(fileLabels, key) && output[key],
  );

// A generated file keeps its source/version identity even when moved in the tree.
export function directoryIndex(folders, docs) {
  const entries = new Map(),
    groups = new Map();
  function add(entry, location, defaultParent = "") {
    entry.parent = location?.parent ?? defaultParent;
    entry.position = location?.position ?? Infinity;
    entries.set(entry.key, entry);
    if (!groups.has(entry.parent)) groups.set(entry.parent, []);
    groups.get(entry.parent).push(entry);
  }
  for (const item of folders)
    add({ type: "folder", key: item.id, item, title: item.title }, item);
  for (const item of docs) {
    if (!item.detachedSource)
      add({ type: "doc", key: item.id, item, title: item.title }, item);
    for (const output of item.outputs || []) {
      const key = item.id + "-" + output.version;

      for (const file of outputKeys(output))
        add(
          {
            type: "file",
            key: key + "-" + file,
            doc: item,
            output,
            item: file,
            title: fileLabel(output, file),
          },
          output.fileLocations?.[file],
          item.id,
        );
    }
  }
  for (const group of groups.values())
    group.sort((a, b) => a.position - b.position);
  function ancestors(key) {
    const chain = [],
      seen = new Set();
    while (entries.has(key) && !seen.has(key)) {
      const entry = entries.get(key);
      seen.add(key);
      chain.push(entry);
      key = entry.parent;
    }
    return chain;
  }
  return { entries, groups, ancestors };
}
function locate(entry, parent, position) {
  let location = entry.item;
  if (entry.type === "output") location = entry.item.location ||= {};
  if (entry.type === "file") {
    const locations = (entry.output.fileLocations ||= {});
    location = locations[entry.item] ||= {};
  }
  Object.assign(location, { parent, position });
}

function insert(items, item, target, after) {
  const siblings = items.filter((sibling) => sibling !== item);
  const index = target
    ? siblings.indexOf(target) + Number(after)
    : siblings.length;
  siblings.splice(index, 0, item);
  return siblings;
}

export function renderDirectory({
  folders,
  docs,
  closed,
  selectDoc,
  selectFile,
  quoteFile,
  createChild,
  remove,
  moved,
  renamed,
  selected,
}) {
  const tree = $("tree");
  const label = $("sidebar").querySelector(".treelabel");
  const scroll = tree.scrollTop;
  tree.replaceChildren();
  let dragged;
  const clearDrop = () => {
    delete tree.dataset.drop;
    delete label.dataset.drop;
    tree
      .querySelectorAll("[data-drop]")
      .forEach((el) => delete el.dataset.drop);
  };
  const index = directoryIndex(folders, docs);
  function destination(source, target, place) {
    if (!source || source === target) return null;
    const parent = !target
      ? ""
      : place === "inside"
        ? target.key
        : target.parent;
    if (index.ancestors(parent).some((e) => e.key === source.key)) return null;
    return { parent, sibling: place === "inside" ? null : target };
  }
  function move(source, target, place) {
    const next = destination(source, target, place);
    if (!next) return;
    const peers = index.groups.get(next.parent) || [];
    insert(peers, source, next.sibling, place === "after").forEach((entry, i) =>
      locate(entry, next.parent, i),
    );
    if (next.parent) closed.delete(next.parent);
    moved(source.key);
  }
  function acceptDrop(el, target) {
    const position = (event) => {
      if (!target) return "inside";
      const bounds = el.getBoundingClientRect();
      const ratio = (event.clientY - bounds.top) / bounds.height;
      if (ratio >= 0.27 && ratio <= 0.73) return "inside";
      return ratio < 0.5 ? "before" : "after";
    };
    el.ondragover = (event) => {
      if (el === tree && event.target !== tree) return;
      const place = position(event);
      clearDrop();
      if (!destination(dragged, target, place)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      el.dataset.drop = place;
    };
    el.ondragleave = (event) => {
      if (!el.contains(event.relatedTarget)) delete el.dataset.drop;
    };
    el.ondrop = (event) => {
      if (!dragged || (el === tree && event.target !== tree)) return;
      event.preventDefault();
      clearDrop();
      if (event.dataTransfer.getData(itemTransfer) !== dragged?.key) return;
      move(dragged, target, position(event));
    };
  }
  const peers = new Map();
  function row(entry, depth, typeIcon, action, expanded) {
    const item = document.createElement("div");
    item.className = "tree-row";
    item.dataset.treeKey = entry.key;
    item.dataset.siblingGroup = entry.parent;
    const button = document.createElement("button");
    button.className = "node" + (selected(entry) ? " active" : "");
    button.style.paddingLeft = 8 + depth * 14 + "px";
    button.title = entry.title;
    button.innerHTML =
      (expanded === undefined
        ? ""
        : '<span class="chev">' + (expanded ? "▾" : "▸") + "</span>") +
      icon(typeIcon);
    const label = document.createElement("span");
    label.textContent = entry.title;
    button.append(label);
    const rename = () => {
      previousClick = null;
      if (item.querySelector("input")) return;
      const input = document.createElement("input");
      input.className = "node-name";
      input.setAttribute("aria-label", "重命名 " + entry.title);
      input.value = entry.title;
      input.style.marginLeft = Math.min(8 + depth * 14, 50) + "px";
      item.append(input);
      item.classList.add("renaming");
      input.focus();
      input.select();
      const finish = (commit, focus) => {
        if (!input.isConnected) return;
        const name = input.value.trim();
        input.onblur = null;
        input.remove();
        item.classList.remove("renaming");
        if (commit && name && name !== entry.title) {
          if (entry.type === "file")
            (entry.output.fileNames ||= {})[entry.item] = name;
          else if (entry.type === "output") entry.item.directoryName = name;
          else entry.item.title = name;
          entry.title = label.textContent = button.title = name;
          del.title = del.ariaLabel = "删除 " + name;
          plus.title = plus.ariaLabel = "在「" + name + "」下新建";
          if (quote) quote.title = quote.ariaLabel = "引用到当前对话：" + name;
          renamed(entry);
        }
        if (focus) button.focus({ preventScroll: true });
      };
      input.onblur = () => finish(true, false);
      input.onkeydown = (e) => {
        if (e.isComposing || e.keyCode === 229) return;
        if (e.key !== "Enter" && e.key !== "Escape") return;
        e.preventDefault();
        finish(e.key === "Enter", true);
      };
    };
    button.onclick = (e) => {
      if (e.target.closest(".chev")) {
        previousClick = null;
        return toggle(entry.key);
      }
      const now = performance.now();
      // Navigation redraws the tree, so the second click may land on a new DOM node.
      if (
        e.detail &&
        previousClick?.key === entry.key &&
        now - previousClick.at < 380
      ) {
        previousClick = null;
        return rename();
      }
      previousClick = e.detail ? { key: entry.key, at: now } : null;
      action();
    };
    button.ondblclick = (e) => {
      e.preventDefault();
      rename();
    };
    if (expanded !== undefined)
      button.setAttribute("aria-expanded", String(expanded));
    if (entry.type === "doc" || entry.type === "folder")
      button.dataset.node = entry.item.id;
    const ref =
      entry.type === "doc"
        ? { id: entry.item.id }
        : entry.type === "file"
          ? {
              id: entry.doc.id,
              version: entry.output.version,
              file: entry.item,
            }
          : null;
    button.draggable = true;
    button.ondragstart = (event) => {
      previousClick = null;
      dragged = entry;
      event.dataTransfer.setData(itemTransfer, entry.key);
      if (ref) event.dataTransfer.setData(contextTransfer, JSON.stringify(ref));
      event.dataTransfer.effectAllowed = ref ? "copyMove" : "move";
    };
    button.ondragend = () => {
      dragged = undefined;
      clearDrop();
    };
    const siblings = peers.get(entry.parent) || [];
    peers.set(entry.parent, siblings);
    siblings.push(entry);
    button.onkeydown = (event) => {
      if (event.key === "F2") {
        event.preventDefault();
        rename();
        return;
      }
      if (
        expanded !== undefined &&
        (event.key === "ArrowLeft" || event.key === "ArrowRight")
      ) {
        event.preventDefault();
        if ((event.key === "ArrowRight") !== expanded) toggle(entry.key);
        return;
      }
      if (!event.altKey || !["ArrowUp", "ArrowDown"].includes(event.key))
        return;
      event.preventDefault();
      const after = event.key === "ArrowDown";
      const next = siblings[siblings.indexOf(entry) + (after ? 1 : -1)];
      if (next) move(entry, next, after ? "after" : "before");
    };
    const del = document.createElement("button");
    del.className = "node-delete";
    del.type = "button";
    del.title = del.ariaLabel = "删除 " + entry.title;
    del.innerHTML = icon("trash");
    del.onclick = () => remove(entry);
    const plus = document.createElement("button");
    plus.type = "button";
    plus.className = "node-add";
    plus.title = plus.ariaLabel = "在「" + entry.title + "」下新建";
    plus.innerHTML = icon("plus");
    plus.onclick = () => createChild(entry.key);
    item.append(button, plus, del);
    let quote;
    if (ref) {
      quote = document.createElement("button");
      quote.type = "button";
      quote.className = "node-quote";
      quote.title = quote.ariaLabel = "引用到当前对话：" + entry.title;
      quote.innerHTML = icon("quote");
      quote.onclick = () => quoteFile(ref);
      item.append(quote);
    }
    tree.append(item);
    acceptDrop(item, entry);
  }
  function toggle(key) {
    closed.has(key) ? closed.delete(key) : closed.add(key);
    renderDirectory({
      folders,
      docs,
      closed,
      selectDoc,
      selectFile,
      createChild,
      remove,
      moved,
      renamed,
      selected,
    });
    [...tree.querySelectorAll(".tree-row")]
      .find((row) => row.dataset.treeKey === key)
      ?.querySelector(".node")
      ?.focus({ preventScroll: true });
  }
  function branch(parent, depth) {
    for (const entry of index.groups.get(parent) || []) {
      const { type, key, item } = entry;
      const container = type === "folder" || type === "output";
      const hasChildren = index.groups.has(key);
      const glyph = container
        ? "folder"
        : type === "file"
          ? item === "html"
            ? "code"
            : "doc"
          : item.type === "画布"
            ? "board"
            : item.type !== "交互 HTML"
              ? "doc"
              : "code";
      const activate = container
        ? () => {
            closed.delete(key);
            selectDoc(item);
          }
        : type === "file"
          ? () => selectFile(entry.doc, entry.output, item)
          : () => selectDoc(item);
      row(
        entry,
        depth,
        glyph,
        activate,
        hasChildren || container ? !closed.has(key) : undefined,
      );
      if (hasChildren && !closed.has(key)) branch(key, depth + 1);
    }
  }
  branch("", 0);
  acceptDrop(label, null);
  acceptDrop(tree, null);
  clearDrop();
  tree.scrollTop = scroll;
}
