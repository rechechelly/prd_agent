import {initModels,setModels,selectedModel} from "./workspace/providers";
import { documentCompletion } from "./editor/document-completion";
import { queueState, syncQueue, renderQueue } from "./chat/chat-queue";
import { readTurns, findTurn, tracePanel } from "./chat/chat-trace";
import { generatedFiles, boardType } from "../shared/workspace-files.mjs";
import { emptyHtml, sourceEdits, installHtmlSource } from "./workspace/html-source";
import { installBlockTools } from "./editor/block-tools";
import { installDocumentOutline } from "./editor/document-outline";
import { TaskList, TaskItem } from "@tiptap/extension-list";
import { sceneVersion } from "../shared/canvas-model.mjs";
import { sessions, selectedSession, sessionName, migrateExternalReviews } from "./chat/chat-sessions";
import { installComposer } from "./chat/composer";
import { documentRange, rawRange, rangeReference } from "./editor/selection-reference";
import { toolDescriptions, toolGroups } from "../shared/agent-catalog.mjs";
import { planEdits, wireEdits } from "./editor/edit-comparison";
import deltaStyle from "./editor/inline-review-style.txt";
import { contextTransfer, fileKey, resolveFile } from "../shared/assistant-context.mjs";
import {
  directoryIndex,
  outputKeys,
  fileLabel,
  renderDirectory,
} from "./workspace/directory";
import { Editor } from "@tiptap/core";
import { DOMSerializer, DOMParser as SchemaParser } from "@tiptap/pm/model";
import { DocumentImage, readDocumentImage } from "./editor/document-image";
import { closeHistory } from "@tiptap/pm/history";
import { EditorState, NodeSelection } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import { TableKit } from "@tiptap/extension-table";
import { Markdown } from "@tiptap/markdown";
import {
  demoScene,
  sceneImage,
  mountBoard,
  unmountBoard,
  proposedScene,
  currentImage,
  addIcon,
} from "./workspace/board";
import { openGenerationLog } from "./workspace/generation-log";
import { $, esc, icon, decorate, dialog, confirmDelete, toast } from "./shared";
import DOMPurify from "dompurify";
import { installLayout } from "./workspace/layout";
import {
  api,
  boot,
  changed,
  flush,
  online,
  streamChat,
} from "./service";
import { openDiscussion, stopReview } from "./review/review";
const folders = [
  { id: "product", title: "产品设计", parent: "" },
  { id: "research", title: "用户研究", parent: "product" },
  { id: "personal", title: "日常备忘", parent: "" },
];
const docs = [
  {
    id: "feedback",
    title: "客户反馈池",
    type: "需求文档",
    parent: "product",
    html: "",
  },
  {
    id: "interview",
    title: "客户访谈摘录",
    type: "备忘录",
    parent: "research",
    html: "<h2>反馈处理</h2><p>访谈示例：希望产品经理能按状态查看客户反馈，并快速找到反馈来源。</p>",
  },
  {
    id: "review",
    title: "需求评审备忘",
    type: "备忘录",
    parent: "personal",
    html: "<p>评审前核对交互原型、字段口径和待确认事项。</p>",
  },
  {
    id: "week",
    title: "本周灵感",
    type: "备忘录",
    parent: "personal",
    html: "<p>记录值得再次讨论的产品想法。</p>",
  },
];
const date = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "long",
  day: "numeric",
}).format(new Date());
const closed = new Set(["research"]);
let doc = docs[0],
  loadedDoc,
  page = "work",
  editor,
  openAgent = innerWidth > 820;
let quoted = [],
  previewOriginal = false;
const sending = new Map();
const edits = new WeakMap();
const composers = new WeakMap();
const pendingUploads = new WeakMap();
let currentComposer, editComposer;
function switchComposer(target) {
  if (currentComposer === target) return;
  if (currentComposer)
    composers.set(currentComposer, {
      question: $("question").value,
      refs: quoted,
    });
  editComposer?.();
  currentComposer = target;
  const state = target && composers.get(target);
  quoted = state?.refs || [];
  $("question").value = state?.question || "";
  $("agentContextInfo").open = false;
  renderQuotes();
}
function snapshot() {
  return { docs, folders, completionEnabled };
}
async function quoteSelection(selection) {
  if (!online) return toast("请在登录版工作台使用划词提问");
  const file = doc, session = currentComposer, source = file.html;
  try {
    const range = file.type === "交互 HTML"
      ? rawRange($("htmlInput"), source)
      : documentRange(editor, source, selection);
    const ref = await rangeReference(file, range, source);
    if (session !== currentComposer || file !== doc || source !== file.html) return;
    quoted = quoted.filter(item => item.kind !== "range");
    quoted.push(ref);
    openAgent = true;
    header();
    editComposer?.();
    renderQuotes();
    $("question").focus();
  } catch (error) { toast(error.message); }
}
function referenceLabel(ref) {
  if (ref.kind === "range") {
    const excerpt = ref.text.replace(/\s+/g, " ").trim();
    return "选区 · " + excerpt.slice(0, 16) + (excerpt.length > 16 ? "…" : "");
  }
  if (ref.kind === "upload" || ref.kind === "image") return ref.title;
  return ref.kind === "file"
    ? resolveFile(docs, ref)?.title || ref.title
    : ref.title + " · " + ref.text.slice(0, 32);
}
function attachFile(data) {
  const source = resolveFile(docs, data);
  if (!source) return toast("引用的文件已不存在");
  if (quoted.some((r) => r.kind === "file" && fileKey(r) === fileKey(data)))
    return toast("已引用这份文件");
  quoted.push({
    kind: "file",
    id: data.id,
    version: data.version,
    file: data.file,
    title: source.title,
  });
  renderQuotes();
  queueMicrotask(() => $("question").focus());
}
async function uploadFiles(files) {
  const session = currentComposer;
  if (!online || !session) return toast("请在登录版写作助手中上传附件");
  if (!files.length) return;
  const refs = quoted;
  pendingUploads.set(session, (pendingUploads.get(session) || 0) + 1);
  renderQuotes();
  try {
    for (const file of files) {
      try {
        if (file.size > 20 * 1024 * 1024) throw Error("每个附件最多 20 MB");
        const res = await fetch(
          "./api/attachments?name=" + encodeURIComponent(file.name),
          { method: "POST", body: file },
        );
        const item = await res.json();
        if (!res.ok) throw Error(item.error || "上传失败");
        if (!refs.some((r) => r.kind === item.kind && r.id === item.id))
          refs.push(item);
      } catch (error) {
        toast(file.name + " · " + error.message);
      }
    }
  } finally {
    pendingUploads.set(session, pendingUploads.get(session) - 1);
    if (currentComposer === session) renderQuotes();
  }
}
function imageThumbnail(ref) {
  const image = document.createElement("img");
  image.className = "chatImageThumb";
  image.src = "./api/attachments/" + encodeURIComponent(ref.id);
  image.alt = ref.title || "粘贴的图片";
  image.loading = "lazy";
  return image;
}
function renderQuotes() {
  const area = $("references");
  area.replaceChildren();
  if (pendingUploads.get(currentComposer)) {
    const note = document.createElement("small");
    note.setAttribute("role", "status");
    note.textContent = "正在解析附件…";
    area.append(note);
  }
  $("askForm").querySelector(".send").disabled =
    !!pendingUploads.get(currentComposer);
  quoted.forEach((ref, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ref";
    b.title = (ref.kind === "range" ? referenceLabel(ref) : ref.text || referenceLabel(ref)) + " · 点击移除";
    if (ref.kind === "image") {
      b.append(imageThumbnail(ref), " ×");
      b.setAttribute("aria-label", "移除图片 " + ref.title);
    } else b.textContent = referenceLabel(ref) + " ×";
    b.onclick = () => {
      quoted.splice(i, 1);
      renderQuotes();
    };
    area.append(b);
  });
}
function fileTitle() {
  return doc?.title || "";
}
function chatTarget() {
  return doc;
}
function targetContent(target) {
  return target.html;
}
const editPlans = new WeakMap();
let visibleProposal, writeSource;
let rawMode = false;
function setHtmlMode(raw) {
  rawMode = raw;
  if (raw) previewOriginal = false;
  reviewDraft();
}
function refreshSourceQuote() {
  const input = $("htmlInput");
  $("quoteSource").hidden = $("htmlSourceEditor").hidden || input.selectionStart === input.selectionEnd;
}
function updateHtmlView(sourceDiff, renderSource = doc.html) {
  $("renderMode").setAttribute("aria-pressed", String(!rawMode));
  $("sourceMode").setAttribute("aria-pressed", String(rawMode));
  const frame = $("resultFrame");
  if (
    !rawMode &&
    (frame.hidden || frame.getAttribute("srcdoc") !== renderSource)
  ) {
    const fresh = frame.cloneNode(false);
    fresh.hidden = false;
    fresh.srcdoc = renderSource;
    frame.replaceWith(fresh);
  } else frame.hidden = rawMode;
  $("htmlSourceEditor").hidden = !rawMode || sourceDiff;
  $("htmlDiff").hidden = !rawMode || !sourceDiff;

  if (rawMode && !sourceDiff) writeSource(doc.html);
  refreshSourceQuote();
}
function reviewDraft(focusIndex) {
  const target = chatTarget();

  const pending = selectedSession(target)?.messages.findLast(m => typeof m.proposed === "string" && !m.resolved)
    || target?.externalReviews?.find(m => typeof m.proposed === "string" && !m.resolved);
  const isHtml = page === "result" && target?.type === "交互 HTML";
  const preview = $(isHtml ? "htmlDiff" : "draftPreview");
  const review = $("agentReview");
  const bar = $(isHtml ? "htmlChangeBar" : "changeBar");
  bar.hidden = !pending || (isHtml && !rawMode);

  review.hidden = !pending;
  const stale =
    pending &&
    (pending.reviewCurrent ?? pending.base) !== targetContent(target);
  if (visibleProposal !== pending) previewOriginal = false;
  const inline = !!pending && !stale && !previewOriginal;
  if (!isHtml) {
    preview.hidden = !inline;
    $("editor").hidden = inline;
    $("work").classList.toggle("reviewing-inline", inline);
  }

  if (!pending) {
    if (isHtml) updateHtmlView(false);
    visibleProposal = null;
    return;
  }
  if (!editPlans.has(pending))
    editPlans.set(
      pending,
      isHtml
        ? sourceEdits(pending.base, pending.proposed)
        : planEdits(pending.base, pending.proposed, false),
    );
  const plan = editPlans.get(pending),
    previousChoices = pending.reviewChoices,
    choices = previousChoices || {};
  const scopedDocument = !isHtml && pending.refsUsed?.some(r => r.kind === "range");
  const remaining = scopedDocument ? 1 : plan.count - Object.keys(choices).length;
  if (isHtml) {
    const renderSource = stale
      ? target.html
      : previousChoices
        ? plan.content((id) => choices[id] || "keep")
        : pending.proposed;
    updateHtmlView(inline, renderSource);
  }
  if (visibleProposal !== pending && focusIndex === undefined) focusIndex = 0;
  visibleProposal = pending;
  bar.replaceChildren(
    stale
      ? "正文已变化，请放弃旧建议并重新请求修改。"
      : remaining + " 处修改待审阅",
  );
  const action = (label, cb) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.onclick = cb;
    bar.append(button);
  };
  function decide(id, keep) {
    if (scopedDocument) id = null;
    if (
      target !== chatTarget() ||
      pending.resolved ||
      pending.reviewChoices !== previousChoices ||
      (id !== null && choices[id])
    )
      return;
    if (
      (keep || id !== null) &&
      (pending.reviewCurrent ?? pending.base) !== targetContent(target)
    ) {
      toast("正文已变化，请重新请求修改");
      reviewDraft();
      return;
    }
    const next = { ...choices };
    for (let i = 0; i < plan.count; i++)
      if (!next[i] && (id === null || i === id))
        next[i] = keep ? "keep" : "undo";
    const done = id === null || Object.keys(next).length === plan.count;
    if (keep) {
      const clean = plan.count && !scopedDocument
        ? plan.content((i) => next[i] || "undo")
        : pending.proposed;
      if (isHtml) doc.html = clean;
      else {
        editor.commands.setContent(DOMPurify.sanitize(clean), {
          emitUpdate: false,
        });
        doc.html = scopedDocument ? pending.proposed : editor.getHTML();
      }
      if (!done) pending.reviewCurrent = targetContent(target);
    }
    if (done) {
      const values = Object.values(next);
      pending.resolved =
        values.includes("keep") && values.includes("undo")
          ? "已部分采用"
          : values.includes("keep") || keep
            ? "已采纳"
            : "已放弃";
      delete pending.base;
      delete pending.proposed;
      delete pending.reviewChoices;
      delete pending.reviewCurrent;
      editPlans.delete(pending);
      previewOriginal = false;
    } else pending.reviewChoices = next;
    changed();
    if (done) chat();
    else reviewDraft(id);
    header();
  }
  const toggle = () => {
    previewOriginal = !previewOriginal;
    reviewDraft(0);
  };
  if (!stale) action(previewOriginal ? "查看行内修改" : "查看原文", toggle);
  if (stale || !remaining) action("放弃建议", () => decide(null, false));
  if (!stale && !remaining) action("Keep", () => decide(null, true));
  review.querySelector("span").textContent =
    doc.title + " · " + remaining + " 处";
  $("adoptAgentEdit").disabled = !!stale;
  $("adoptAgentEdit").onclick = () => decide(null, true);
  $("discardAgentEdit").onclick = () => decide(null, false);
  $("compareAgentEdit").disabled = !!stale;
  $("compareAgentEdit").onclick = () => {
    if (isHtml) rawMode = true;
    previewOriginal = false;
    reviewDraft(0);
  };
  if (!inline || (isHtml && !rawMode)) return;
  const content = plan.preview(choices);
  preview.replaceChildren(...content.body.childNodes);
  wireEdits(preview, decide, focusIndex);
}
function directory() {
  return directoryIndex(folders, docs);
}
function reveal(key) {
  for (const entry of directory().ancestors(key)) closed.delete(entry.key);
}
function tree() {
  renderDirectory({
    folders,
    docs,
    closed,
    selectDoc: openDoc,
    quoteFile(ref) {
      openAgent = true;
      $("sidebar").classList.remove("open");
      header();
      attachFile(ref);
    },
    createChild: create,
    selected(entry) {
      return (
        doc === entry.item && ["work", "boardPage", "result"].includes(page)
      );
    },
    moved(key) {
      changed();
      tree();
      header();
      [...$("tree").querySelectorAll(".tree-row")]
        .find((row) => row.dataset.treeKey === key)
        ?.querySelector(".node")
        ?.focus({ preventScroll: true });
    },
    renamed(entry) {
      changed();
      if (entry.type === "doc" && entry.item === doc) {
        $("title").value = doc.title;
        $("boardTitle").textContent = doc.title;
      }
      renderQuotes();
      if (page === "result" && doc) $("resultName").textContent = doc.title;
      header();
    },
    remove: confirmDeletion,
  });
}
function firstDocument() {
  const index = directory();
  function first(key) {
    for (const entry of index.groups.get(key) || []) {
      if (entry.type === "doc") return entry.item;
      const child = first(entry.key);
      if (child) return child;
    }
  }
  return first("") || docs.find((d) => !d.detachedSource);
}
function openFirstFile() {
  const next = firstDocument();
  if (next) return openDoc(next);
  openDoc(folders[0] || null);
}
function confirmDeletion(entry) {
  const { title } = entry;
  const index = directory(),
    removed = new Set([entry.key]);
  // Delete the visible subtree. A generated file moved elsewhere keeps its identity and share URL.
  for (const key of removed) {
    for (const child of index.groups.get(key) || []) removed.add(child.key);
  }
  const removing = Array.from(removed, (key) => index.entries.get(key));
  const removesPrd = removing.some((e) => e.item.type === "文档");
  const removesShare = true;
  const detail =
    removing.length > 1
      ? "<p>将同时删除 " +
        (removing.length - 1) +
        " 个子项或关联交付件：" +
        removing
          .slice(1, 7)
          .map((e) => esc(e.title))
          .join("、") +
        (removing.length > 7 ? "等" : "") +
        "。</p>"
      : "";
  dialog(
    "删除 " + title,
    "<p>确定永久删除「" +
      esc(title) +
      "」？</p>" +
      detail +
      (removesShare ? "<p>对应的工作区分享链接会失效。</p>" : "") +
      (removesPrd ? "<p>被删除的 PRD 评论也会一起删除。</p>" : ""),
    () => {
      for (const { item, type } of removing) {
        const list = type === "folder" ? folders : docs;
        list.splice(list.indexOf(item), 1);
      }
      changed();
      if (!docs.includes(doc) && !folders.includes(doc)) openFirstFile();
      else tree();
      flush()
        .then(() => toast("已删除"))
        .catch((e) => toast(e.message));
    },
    "删除",
  );
}
function lastVersion(d) {
  return Math.max(
    d.lastOutputVersion || 0,
    ...(d.outputs || []).map((a) => a.version),
  );
}
function header() {
  const isDoc = page === "work";
  $("canvasContext").hidden = page !== "boardPage";
  $("writingContext").hidden = page === "boardPage";
  $("question").placeholder =
    page === "boardPage"
      ? "描述要绘制的原型、业务流程或状态变化…"
      : doc?.type === "交互 HTML"
        ? "描述要修改的页面样式或交互…"
        : "提问或描述想修改的内容…";
  const mount = isDoc
    ? $("workRail")
    : page === "result"
      ? $("resultRail")
      : $(page).querySelector(".pagehead") || $(page);
  if ($("menu").parentNode !== mount) mount.prepend($("menu"));
  if ($("assistantToggle").parentNode !== mount)
    mount.append($("assistantToggle"));
  const completionButton = $("completionToggle");
  completionButton.hidden = !isDoc;
  if (!completionButton.hidden && completionButton.parentNode !== mount)
    mount.insertBefore(completionButton, $("assistantToggle"));
  const share = $("share");
  share.hidden = !doc || (!isDoc && page !== "boardPage" && page !== "result");
  if (share.parentNode !== mount)
    mount.insertBefore(share, $("assistantToggle"));
  const commands = $("generationRuns").parentElement;
  const dest = isDoc ? $("paper").querySelector(".meta") : mount;
  if (commands.parentNode !== dest) dest.append(commands);
  commands.hidden = !doc || !["work", "boardPage", "result"].includes(page);
  $("generationRuns").hidden = !online || commands.hidden;
  $("assistantToggle").hidden =
    !isDoc &&
    page !== "boardPage" &&
    !(
      page === "result" &&
      (doc?.type === "交互 HTML" || folders.includes(doc))
    );
  const agentOpen = openAgent;
  $("agent").hidden = !agentOpen || $("assistantToggle").hidden;
  $("assistantToggle").setAttribute("aria-expanded", String(agentOpen));
  $("wordCount").textContent =
    (editor?.getText().replace(/\s/g, "").length || 0) + " 字";
}
function show(p) {
  hideSuggestion();
  stopReview();
  if (page === "boardPage" && p !== page) {
    unmountBoard();
    mountedBoard = mountedPatch = null;
  }
  page = p;
  switchComposer(selectedSession(chatTarget()));
  for (const id of ["work", "boardPage", "result", "emptyPage"])
    $(id).hidden = p !== id;
  $("sidebar").classList.remove("open");
  tree();
  header();
}
let mountedBoard, mountedPatch;
function updateBoard() {
  const session = selectedSession(doc),
    msg = session.messages.findLast((m) => m.canvasPatch && !m.resolved)
      || doc.externalReviews?.find(m => m.canvasPatch && !m.resolved);
  const bar = $("boardReview");
  const stale = msg && sceneVersion(doc.scene) !== msg.canvasBase;
  const patch = !stale && msg ? msg.canvasPatch : null;
  const editable = !patch;
  $("icons").disabled = !editable;
  $("pasteArt").disabled = !editable;
  bar.hidden = !msg;
  if (mountedBoard === doc && mountedPatch === patch && !msg) return;
  if (mountedBoard !== doc || mountedPatch !== patch) {
    mountedBoard = doc;
    mountedPatch = patch;
    mountBoard(
      doc,
      $("boardMount"),
      changed,
      patch ? proposedScene(doc.scene, patch) : undefined,
      patch && new Set(patch.elements.map((e) => e.id)),
    );
  }
  if (!msg) return;
  bar.replaceChildren();
  const label = document.createElement("span");
  label.textContent = stale
    ? "画布已更新，请放弃旧建议后重新提问"
    : "画布修改预览";
  bar.append(label);
  for (const keep of [false, true]) {
    const button = document.createElement("button");
    button.textContent = keep ? "采用 Keep" : "放弃 Undo";
    button.disabled = keep && stale;
    button.onclick = () => {
      if (keep) {
        if (sceneVersion(doc.scene) !== msg.canvasBase) return updateBoard();
        doc.scene = proposedScene(doc.scene, msg.canvasPatch);
        delete doc.view;
      }
      msg.resolved = keep ? "已采用画布修改" : "已放弃画布修改";
      delete msg.canvasPatch;
      delete msg.canvasBase;
      mountedBoard = null;
      changed();
      chat();
    };
    bar.append(button);
  }
}
function openDoc(d) {
  if (!d) {
    doc = null;
    loadedDoc = null;
    show("emptyPage");
    return;
  }
  const switching = loadedDoc !== d;
  if (switching) {
    previewOriginal = false;
  }
  loadedDoc = d;
  doc = d;
  reveal(d.parent);
  if (d.type === "交互 HTML" || folders.includes(d)) {
    show("result");
    $("resultName").textContent = d.title;
    $("resultFrame").hidden = folders.includes(d);
    $("folderItems").hidden = !folders.includes(d);
    const isHtml = d.type === "交互 HTML";
    $("htmlModes").hidden = !isHtml;
    if (isHtml) {
      if (switching) {
        rawMode = false;
        $("resultFrame").removeAttribute("srcdoc");
        writeSource(d.html, true);
      }
      chat();
    } else {
      $("htmlSourceEditor").hidden =
        $("htmlDiff").hidden =
        $("htmlChangeBar").hidden =
          true;
      const area = $("folderItems");
      area.replaceChildren();
      for (const child of directory().groups.get(d.id) || []) {
        const b = document.createElement("button");
        b.textContent = child.title;
        b.onclick = () => openDoc(child.item);
        area.append(b);
      }
      if (!area.childElementCount) area.textContent = "文件夹为空";
      chat();
    }
    return;
  }
  if (boardType(d.type)) {
    show("boardPage");
    $("boardTitle").textContent = d.title;
    chat();
    return;
  }
  if (switching) {
    editor.commands.setContent(d.html || "<p></p>", { emitUpdate: false });
    const state = editor.state;
    editor.view.updateState(
      EditorState.create({
        schema: state.schema,
        doc: state.doc,
        plugins: state.plugins,
      }),
    );
  }
  $("title").value = d.title;
  $("docType").textContent = d.type;
  $("date").textContent = date;
  show("work");
  openDiscussion(d, editor.view.dom, () => {
    previewOriginal = true;
    reviewDraft();
  });
  chat();
  if ($("draftPreview").hidden) $("paperScroll").scrollTop = 0;
}
function create(parent = "") {
  const entry = directory().entries.get(parent);
  dialog(
    entry ? "新建子文件" : "新建文件",
    '<label for="kind">类型</label><select id="kind" name="kind"><option>文档</option><option>画布</option><option value="交互 HTML">HTML</option><option>文件夹</option></select>' +
      '<label for="name">名称</label><input id="name" name="name" required autocomplete="off">' +
      "<p>位置：" +
      esc(
        entry
          ? directory()
              .ancestors(parent)
              .reverse()
              .map((e) => e.title)
              .join(" / ")
          : "工作空间根目录",
      ) +
      "</p>",
    ({ name, kind }) => {
      if (!name.trim()) {
        toast("请输入名称");
        return false;
      }
      const item = {
        id: crypto.randomUUID(),
        title: name.trim(),
        parent,
        type: kind,
      };
      reveal(parent);
      if (kind === "文件夹") {
        folders.push(item);
        openDoc(item);
      } else {
        docs.push(
          Object.assign(item, {
            type: kind,
            html:
              kind === "交互 HTML"
                ? emptyHtml(item.title)
                : boardType(kind)
                  ? ""
                  : "<p></p>",
          }),
        );
        openDoc(item);
      }
      changed();
    },
    "创建",
  );
  $("name").focus();
}
function migrateDirectory() {
  let migrated = false;
  for (const file of [...docs, ...folders]) {
    if (migrateExternalReviews(file)) migrated = true;
  }
  const groups = new Map();
  const locations = [...docs, ...folders];
  for (const owner of docs)
    for (const output of owner.outputs || []) {
      const key = owner.id + "-" + output.version;
      groups.set(key, output.location?.parent ?? owner.id);
      for (const file of outputKeys(output)) {
        const location = output.fileLocations?.[file];
        if (location) locations.push(location);
        else if (output.location) {
          (output.fileLocations ||= {})[file] = { ...output.location };
          locations.push(output.fileLocations[file]);
          migrated = true;
        }
      }
      if (output.location) {
        delete output.location;
        migrated = true;
      }
    }
  for (const item of locations) {
    const seen = new Set();
    while (groups.has(item.parent) && !seen.has(item.parent)) {
      seen.add(item.parent);
      item.parent = groups.get(item.parent);
      migrated = true;
    }
  }
  for (const source of [...docs]) {
    if (
      boardType(source.type) ||
      (!source.scene && !source.files && !source.view)
    )
      continue;
    const board = {
      id: crypto.randomUUID(),
      title: source.title + " · 草图",
      type: "原型画布",
      parent: source.id,
      html: "",
    };
    for (const prop of ["scene", "files", "view"]) {
      if (prop in source) {
        board[prop] = source[prop];
        delete source[prop];
      }
    }
    docs.push(board);
    migrated = true;
  }
  for (const folder of folders)
    if (folder.type !== "文件夹") {
      folder.type = "文件夹";
      migrated = true;
    }
  for (const d of [...docs]) {
    if (d.outputs) {
      d.lastOutputVersion = lastVersion(d);
      for (const out of d.outputs) docs.push(...generatedFiles(d, out));
      delete d.outputs;
      migrated = true;
    }
    if (d.detachedSource) {
      docs.splice(docs.indexOf(d), 1);
      migrated = true;
      continue;
    }
    const type = boardType(d.type)
      ? "画布"
      : d.type === "交互 HTML"
        ? d.type
        : "文档";
    if (type !== d.type) {
      d.type = type;
      migrated = true;
    }
  }
  return migrated;
}
let completionEnabled = true;
const completion = documentCompletion({
  getEditor: () => editor,
  getDocument: () => doc,
  enabled: () => completionEnabled && page === "work" && doc?.type === "文档" && !$("editor").hidden,
  popup: $("suggest"),
  scrollport: $("paperScroll"),
});
const hideSuggestion = completion.clear;
async function addImage(file) {
  const target = doc,
    view = editor.view;
  let bookmark = editor.state.selection.getBookmark();
  const track = ({ transaction }) => {
    bookmark = bookmark.map(transaction.mapping);
  };
  editor.on("transaction", track);
  try {
    const src = await readDocumentImage(file);
    const image = new window.Image();
    image.src = src;
    await image.decode();
    if (doc !== target || page !== "work") return;
    const selection = bookmark.resolve(editor.state.doc);
    const dom = view.domAtPos(selection.from).node;
    const cell = (dom.nodeType === 1 ? dom : dom.parentElement)?.closest(
      "td,th",
    );
    const width = cell
      ? Math.max(1, Math.min(image.naturalWidth, cell.clientWidth - 20))
      : null;
    const attrs = { src, alt: file.name || "文档图片" };
    if (width)
      Object.assign(attrs, {
        width,
        height: Math.max(
          1,
          Math.round((width * image.naturalHeight) / image.naturalWidth),
        ),
      });
    editor
      .chain()
      .focus()
      .command(({ tr }) => {
        closeHistory(tr).setSelection(selection);
        return true;
      })
      .setImage(attrs)
      .run();
  } catch (error) {
    toast(error.message);
  } finally {
    editor.off("transaction", track);
  }
}
function documentBody(html) {
  const body = new DOMParser().parseFromString(html, "text/html").body;
  body.querySelectorAll("style,script,noscript").forEach((el) => el.remove());
  const wrapper = document.createElement("div");
  wrapper.innerHTML = DOMPurify.sanitize(body.innerHTML);
  const parsed = SchemaParser.fromSchema(editor.schema).parse(wrapper);
  wrapper.replaceChildren(
    DOMSerializer.fromSchema(editor.schema).serializeFragment(parsed.content),
  );
  return wrapper.innerHTML;
}
function markdownHTML(text) {
  const node = editor.schema.nodeFromJSON(editor.markdown.parse(text));
  const container = document.createElement("div");
  container.append(
    DOMSerializer.fromSchema(editor.schema).serializeFragment(node.content),
  );
  return container.innerHTML;
}
function renderChatMarkdown(reply, value) {
  try {
    reply.innerHTML = DOMPurify.sanitize(markdownHTML(value), {
      ALLOWED_TAGS: [
        "p",
        "br",
        "strong",
        "em",
        "s",
        "blockquote",
        "ul",
        "ol",
        "li",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "pre",
        "code",
        "table",
        "thead",
        "tbody",
        "tr",
        "th",
        "td",
        "hr",
        "a",
      ],
      ALLOWED_ATTR: ["href", "start"],
    });
    for (const a of reply.querySelectorAll("a")) {
      a.target = "_blank";
      a.rel = "noopener noreferrer";
    }
  } catch {
    reply.textContent = value;
  }
}
function selectChat(file, session) {
  file.selectedChat = session.id;
  session.closed = false;
  switchComposer(session);
  previewOriginal = false;
  changed();
  chat();
}
function renderTabs(file, active) {
  const tabs = $("chatTabs");
  tabs.replaceChildren();
  const open = sessions(file).filter((s) => !s.closed);
  for (const session of open) {
    const tab = document.createElement("div");
    tab.className = "sessionTab";
    tab.classList.toggle("current", session === active);
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(session === active));
    button.textContent = sessionName(session);
    button.title = button.textContent;
    button.onclick = () => selectChat(file, session);
    tab.append(button);
    if (open.length > 1) {
      const close = document.createElement("button");
      close.type = "button";
      close.className = "closeTab";
      close.textContent = "×";
      close.ariaLabel = "关闭标签 " + button.title;
      close.onclick = () => {
        session.closed = true;
        selectChat(
          file,
          active === session ? open.find((s) => s !== session) : active,
        );
      };
      tab.append(close);
    }
    tabs.append(tab);
  }
  tabs
    .querySelector(".current")
    ?.scrollIntoView({ block: "nearest", inline: "nearest" });
}
function editQuestion(box, session, message) {
  edits.set(session, { message, text: message.q });
  chat();
  const input = $("conversation").querySelector(".turnEditor textarea");
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}
function mountQuestionEditor(box, session, message) {
  const index = session.messages.indexOf(message),
    later = session.messages.length - index - 1;
  const form = document.createElement("form");
  form.className = "turnEditor";
  const input = document.createElement("textarea");
  input.required = true;
  input.ariaLabel = "编辑历史提问";
  input.value = edits.get(session).text;
  input.oninput = () => {
    edits.get(session).text = input.value;
  };
  const note = document.createElement("small");
  note.textContent = later
    ? "重新发送将替换这条提问和后续 " + later + " 轮对话。"
    : "重新发送将替换这条提问及其回复。";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "取消";
  cancel.onclick = () => {
    edits.delete(session);
    chat();
  };
  const send = document.createElement("button");
  send.type = "submit";
  send.textContent = "重新发送";
  send.className = "primary";
  form.onsubmit = (e) => {
    e.preventDefault();
    if (!input.value.trim()) return;
    edits.delete(session);
    ask(input.value.trim(), index, message.refsUsed || []);
  };
  form.append(input, note, cancel, send);
  box.replaceChildren(form);
}
function openChatHistory() {
  const file = chatTarget();
  const entries = sessions(file).map(session => ({ file, session }));
  entries.sort((a, b) => b.session.updatedAt - a.session.updatedAt);
  const list = $("historyList");
  list.replaceChildren();
  for (const { file, session } of entries) {
    const button = document.createElement("button"),
      title = document.createElement("b"),
      meta = document.createElement("small");
    title.textContent = sessionName(session);
    meta.textContent = [
      file.title,
      session.updatedAt
        ? new Date(session.updatedAt).toLocaleString("zh-CN")
        : null,
    ]
      .filter(Boolean)
      .join(" · ");
    button.append(title, meta);
    button.onclick = () => {
      $("historyDialog").close();
      openDoc(file);
      openAgent = true;
      header();
      selectChat(file, session);
    };
    list.append(button);
  }
  $("historyDialog").showModal();
}
async function openAgentSettings() {
  try {
    const catalog = online
      ? await api("agent-catalog")
      : {
          tools: Object.entries(toolDescriptions).map(
            ([name, description]) => ({ name, description }),
          ),
          skills: [],
        };
    $("importSkill").hidden = !online;
    $("skillStatus").textContent = (catalog.warnings || []).join("；");
    $("importSkill").onclick = () => $("skillFolder").click();
    $("skillFolder").onchange = async (event) => {
      const files = Array.from(event.target.files).filter(
        (f) => !f.webkitRelativePath.split("/").some((s) => s.startsWith(".")),
      );
      event.target.value = "";
      if (!files.length) return;
      const name = files[0].webkitRelativePath.split("/")[0];
      try {
        const payload = [];
        for (const file of files) {
          const data = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result.split(",")[1]);
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(file);
          });
          payload.push({
            path: file.webkitRelativePath.slice(name.length + 1),
            data,
          });
        }
        await api("skills/import", { name, files: payload });
        await openAgentSettings();
        toast("已安装技能 " + name);
      } catch (error) {
        $("skillStatus").textContent = error.message;
      }
    };
    for (const [id, items] of [
      ["agentToolList", catalog.tools],
      ["agentSkillList", catalog.skills],
    ]) {
      const list = $(id);
      list.replaceChildren();
      const rows = id === "agentToolList"
        ? Object.entries(toolGroups).flatMap(([group, names]) => names.map(name => ({ ...items.find(i => i.name === name), group })).filter(i => i.name))
        : items;
      let lastGroup;
      for (const item of rows) {
        if (item.group && item.group !== lastGroup) {
          const label = document.createElement("dt");
          label.className = "toolGroup";
          label.textContent = lastGroup = item.group;
          list.append(label);
        }
        const name = document.createElement("dt"),
          detail = document.createElement("dd");
        name.textContent = item.title
          ? item.title + " · " + item.name
          : item.name;
        detail.textContent = item.description;
        if (id === "agentSkillList" && online) {
          const actions = document.createElement("span");
          actions.className = "skillActions";
          const download = document.createElement("a");
          download.href =
            "./api/skills/export?name=" + encodeURIComponent(item.name);
          download.download = item.name + ".zip";
          download.textContent = "导出";
          const remove = document.createElement("button");
          remove.type = "button";
          remove.textContent = "删除";
          remove.setAttribute("aria-label", "删除技能 " + item.name);
          remove.onclick = () => confirmDelete("删除技能「" + item.name + "」？之后可以重新导入。", async () => {
            try {
              await api("skills/delete", { name: item.name });
              await openAgentSettings();
              toast("已删除技能 " + item.name);
            } catch (error) {
              $("skillStatus").textContent = error.message;
            }
          });
          actions.append(download, remove);
          name.append(actions);
        }
        list.append(name, detail);
      }
    }
  } catch (e) {
    toast(e.message);
  }
}
function updateChatProgress(pending) {
  const panel = pending.panel;
  if (!panel?.isConnected) return;
  const seconds = Math.max(
    0,
    Math.floor((Date.now() - pending.createdAt) / 1000),
  );
  const status = panel.querySelector("[role=status]");
  const label = pending.pausing ? "正在暂停并保存执行记录…" : pending.label;
  if (status.textContent !== label) status.textContent = label;
  pending.pauseButton.disabled = !!pending.pausing;
  panel.querySelector("time").textContent = seconds + " 秒";
  panel.querySelector("pre").textContent = pending.partial;
}
const transcripts = new WeakMap();
function loadTranscript(file, session) {
  const state = { turns: transcripts.get(session)?.turns || [] };
  transcripts.set(session, state);
  state.promise = flush().then(() => readTurns(file, session))
    .then((turns) => {
      if (transcripts.get(session) !== state) return;
      state.turns = turns;
      if (
        doc === file &&
        selectedSession(file) === session &&
        !sending.has(session)
      )
        chat();
    })
    .catch(() => {
      if (transcripts.get(session) === state) transcripts.delete(session);
    });
  return state.promise;
}
function chat(focusIndex) {
  const area = $("conversation");
  area.replaceChildren();
  const file = chatTarget(),
    session = selectedSession(file);
  const pending = sending.get(session);
  const messages = session.messages.slice(
    0,
    pending?.editIndex ?? session.messages.length,
  );
  if (online && session && file && !transcripts.has(session))
    loadTranscript(file, session);
  const turns = transcripts.get(session)?.turns || [];
  const failures = (session.failedAttempts || []).filter(
    (m) => !findTurn(turns, m)?.control,
  );
  for (const t of turns) {
    if (
      t.control &&
      !findTurn([t], pending || {}) &&
      !messages.some((m) => findTurn([t], m))
    ) {
      messages.push(t);
      continue;
    }
    if (
      t.control ||
      t.status !== "unanswered" ||
      failures.some((m) => m.requestId === t.requestId) ||
      findTurn([t], pending || {})
    )
      continue;
    failures.push({
      ...t,
      failure:
        t.reason === "turn_limit"
          ? "工具执行达到轮次上限，本次未收到最终回复。"
          : "本次处理未完成 · " + (t.reason || t.status),
    });
  }
  messages.push(...failures);
  messages.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  if (pending) messages.push(pending);
  if (online) {
    const state = queueState(session);
    const blocked = hasProposal(file, session.messages);
    renderQueue(session, pending, blocked, item => prioritize(file, session, item));
    if (!state.initialized) {
      state.initialized = true;
      state.stopped = !!session.pausedQuestion;
      syncQueue(file, session, "list").then(() => {
        refreshChat(file, session);
        drainQueue(file, session);
      }).catch(error => toast(error.message));
    } else if (!blocked) queueMicrotask(() => drainQueue(file, session));
  }
  renderTabs(file, session);
  if (!messages.length) {
    area.innerHTML =
      '<div class="chatWelcome">' +
      icon("chat") +
      "<h2>写作助手</h2><p>从「" +
      esc(fileTitle()) +
      "」开始</p></div>";
    for (const [name, ico] of page === "boardPage"
      ? [
          ["绘制需求评审状态流转图", "board"],
          ["设计后台列表原型", "doc"],
        ]
      : file?.type === "交互 HTML"
        ? [
            ["检查页面交互", "code"],
            ["优化窄屏布局", "panel"],
          ]
        : [
            ["补充验收条件", "check"],
            ["检查字段说明", "table"],
            ["查询工作区文档", "search"],
          ]) {
      const b = document.createElement("button");
      b.className = "prompt";
      b.innerHTML = icon(ico) + esc(name) + "<span aria-hidden=true>↗</span>";
      b.onclick = () => {
        if (name.startsWith("查询")) {
          $("question").value = "查询 ";
          $("question").focus();
        } else ask(name);
      };
      area.append(b);
    }
  }
  for (const m of messages) {
    const block = document.createElement("div");
    block.className = "msg";
    const question = document.createElement("div");
    question.className = "userTurn";
    const body = document.createElement("div");
    body.className = "agentReply questionBody";
    renderChatMarkdown(body, m.q || "");
    question.append(body);
    block.append(question);
    if (!pending && !m.failure && !m.control) {
      const edit = document.createElement("button");
      edit.className = "editQuestion";
      edit.type = "button";
      edit.title = edit.ariaLabel = "编辑并重新发送";
      edit.innerHTML = icon("pencil");
      edit.onclick = () => editQuestion(question, session, m);
      question.append(edit);
    }
    if (m.refsUsed?.length) {
      const sources = document.createElement("small");
      sources.textContent =
        "引用：" +
        m.refsUsed
          .map((r) => (r.kind === "file" ? r.title : referenceLabel(r)))
          .join("、");
      for (const ref of m.refsUsed.filter((r) => r.kind === "image"))
        sources.append(imageThumbnail(ref));
      question.append(sources);
    }
    if (m === pending) {
      const panel = document.createElement("div");
      panel.className = "working agentProgress";
      panel.innerHTML = '<span role="status"></span> <time></time><pre></pre>';
      const pause = document.createElement("button");
      pause.className = "requestControl";
      pause.type = "button";
      pause.textContent = "暂停";
      pending.sendPause = async () => {
        try {
          await api("agent/pause", {
            doc: file.id,
            chatId: session.id,
            attemptId: pending.attemptId,
          });
        } catch (error) {
          if (sending.get(session) === pending) toast(error.message);
          pending.pausing = false;
          updateChatProgress(pending);
        }
      };
      pause.onclick = () => {
        queueState(session).stopped = true;
        interrupt(pending);
      };
      pending.pauseButton = pause;
      question.append(pause);
      pending.panel = panel;
      block.append(panel, tracePanel(file, session, undefined, [], pending));
    } else {
      const turn = findTurn(turns, m);
      if (m.compactions) {
        const label = document.createElement("small");
        label.textContent = "上下文压缩 " + m.compactions + " 次";
        block.append(label);
      }
      if (
        turn?.toolCalls.length ||
        turn?.submissions.length ||
        m.toolCalls?.length ||
        m.compactions
      )
        block.append(tracePanel(file, session, turn, m.toolCalls));
      if (m.control) {
        const status = document.createElement("small");
        status.textContent =
          m.control === "followed" || pending?.resumeFrom === m.requestId
            ? "已接续到后续请求"
            : "已暂停";
        block.append(status);
        if (m.control === "paused" && !pending) {
          const resume = document.createElement("button");
          resume.type = "button";
          resume.className = "requestControl";
          resume.textContent = "继续";
          resume.onclick = () => ask(m.q, m.editIndex, m.refsUsed || [], m);
          question.append(resume);
        }
        area.append(block);
        continue;
      }
      if (m.failure) {
        const notice = document.createElement("div"),
          retry = document.createElement("button");
        notice.className = "agentFailure";
        notice.textContent = m.failure;
        retry.type = "button";
        retry.textContent = "重新发送";
        retry.disabled = !!pending;
        retry.onclick = () => ask(m.q, undefined, m.refsUsed || []);
        block.append(notice, retry);
        area.append(block);
        continue;
      }
      const reply = document.createElement("div");
      reply.className = "agentReply";
      renderChatMarkdown(reply, m.answer || "");
      block.append(reply);
      const actions = document.createElement("div");
      actions.className = "replyActions";
      const copy = document.createElement("button");
      copy.type = "button";
      copy.title = copy.ariaLabel = "复制回复";
      copy.innerHTML = icon("copy");
      copy.onclick = async () => {
        try {
          await navigator.clipboard.writeText(m.answer);
          toast("已复制回复");
        } catch {
          toast("请选中回复后复制");
        }
      };
      actions.append(copy);
      if (m.createdAt) {
        const time = document.createElement("time");
        time.textContent = new Date(m.createdAt).toLocaleTimeString("zh-CN", {
          hour: "2-digit",
          minute: "2-digit",
        });
        time.title = new Date(m.createdAt).toLocaleString("zh-CN");
        actions.append(time);
      }
      block.append(actions);
    }
    area.append(block);
    if (!pending && edits.get(session)?.message === m)
      mountQuestionEditor(question, session, m);
    for (const id of m.refs || []) {
      const d = directory().entries.get(id)?.item;
      if (d) {
        const b = document.createElement("button");
        b.textContent = d.title;
        b.onclick = () => openDoc(d);
        block.append(b);
      }
    }
    if (
      typeof m.proposed === "string" ||
      m.resolved ||
      m.canvasPatch ||
      (!pending && boardType(doc?.type) && m.toolCalls?.length)
    ) {
      const status = document.createElement("small");
      status.textContent =
        m.resolved ||
        (m.canvasPatch
          ? "画布修改待采用"
          : boardType(doc?.type)
            ? "本轮未提交画布修改"
            : "已提出正文修改");
      block.append(status);
    }
  }
  if (pending) updateChatProgress(pending);
  else if (session.lastAgentFailure && !failures.length) {
    const failure = document.createElement("div");
    failure.className = "agentFailure";
    failure.setAttribute("role", "status");
    failure.textContent = session.lastAgentFailure;
    area.append(failure);
  }
  $("askForm").querySelector(".send").disabled =
    !!pendingUploads.get(session);
  if (page === "boardPage") {
    $("agentReview").hidden = true;
    updateBoard();
  } else reviewDraft(focusIndex);
  if (messages.length) area.scrollTop = area.scrollHeight;
}
function refreshChat(file, session) {
  if (chatTarget() === file && selectedSession(file) === session) chat();
}
function hasProposal(file, messages) {
  return [...messages, ...(file.externalReviews || [])]
    .some(m => (typeof m.proposed === "string" || m.canvasPatch) && !m.resolved);
}
function interrupt(pending) {
  if (pending.pausing || pending.ending) return;
  pending.pausing = true;
  updateChatProgress(pending);
  if (pending.canPause) pending.sendPause();
}
async function prioritize(file, session, item) {
  const state = queueState(session);
  if (state.promoting) return;
  state.promoting = true;
  const current = sending.get(session);
  refreshChat(file, session);
  try {
    await current?.admission;
    await syncQueue(file, session, "prioritize", { requestId: item.requestId });
    state.stopped = false;
    if (current && sending.get(session) === current) interrupt(current);
  } catch (error) {
    toast(error.message);
  } finally {
    state.promoting = false;
    refreshChat(file, session);
    drainQueue(file, session);
  }
}
function drainQueue(file, session) {
  const state = queueState(session);
  if (sending.has(session) || state.loading || state.promoting || state.stopped ||
      !state.items.length || hasProposal(file, session.messages) || (!docs.includes(file) && !folders.includes(file))) return;
  const item = state.items[0];
  runQuestion(file, session, item.question, undefined, item.refs, undefined, item);
}
async function ask(q, editIndex, editRefs, resume) {
  if (!doc || !q.trim()) return;
  editComposer?.();
  const file = chatTarget(), session = selectedSession(file);
  if (pendingUploads.get(session)) return toast("附件解析完成后即可发送");
  if (!online || editIndex !== undefined || resume) {
    if (sending.has(session)) return;
    if (resume) queueState(session).stopped = false;
    return runQuestion(file, session, q, editIndex, editRefs, resume);
  }
  const state = queueState(session);
  const refs = (editRefs || quoted).map(r => r.kind === "file" ? { ...r, title: referenceLabel(r) } : { ...r });
  if (!sending.has(session)) state.stopped = false;
  const item = { question: q, requestId: crypto.randomUUID(), refs, modelId: selectedModel("agent") };
  if (!editRefs) {
    if ($("question").value.trim() === q.trim()) $("question").value = "";
    quoted = [];
    renderQuotes();
  }
  try {
    changed();
    await syncQueue(file, session, "add", item);
  } catch (error) {
    // Keep a rejected submission accessible even if another draft was typed.
    (session.failedAttempts ||= []).push({ q, refsUsed: refs, createdAt: Date.now(), requestId: item.requestId, failure: error.message });
    changed();
    toast(error.message);
  }
  refreshChat(file, session);
  drainQueue(file, session);
}
async function runQuestion(owner, session, q, editIndex, editRefs, resume, queued) {
  if (owner.type === "交互 HTML" && !online)
    return toast("请在登录版工作台使用 HTML 助手");
  if (boardType(owner.type) && !online)
    return toast("画布助手需要登录服务版工作台");
  const modelId = queued?.modelId || selectedModel("agent");
  const target = owner, base = targetContent(target);
  const pausedTurn = transcripts
    .get(session)
    ?.turns.findLast((t) => t.control === "paused");
  if (pausedTurn && !resume && editIndex !== undefined)
    return toast("当前请求已暂停，可以继续或发送一条新消息");
  if (pausedTurn) editIndex = pausedTurn.editIndex;
  const prefix = session.messages.slice(
    0,
    editIndex ?? session.messages.length,
  );
  if (hasProposal(owner, prefix)) {
    toast("请先处理当前文件中的待采纳修改");
    return;
  }
  const refs = (editRefs ?? quoted).map((r) =>
    r.kind === "file" ? { ...r, title: referenceLabel(r) } : { ...r },
  );
  const msg = {
    q,
    refsUsed: refs,
    createdAt: resume?.createdAt || Date.now(),
    requestId: queued?.requestId || resume?.requestId || crypto.randomUUID(),
  };
  const sentFromComposer = !queued && !resume && $("question").value.trim() === q.trim();
  if (sentFromComposer) $("question").value = "";
  if (sentFromComposer || (editIndex === undefined && editRefs === undefined)) {
    quoted = [];
    renderQuotes();
  }
  function finish() {
    session.messages.splice(
      editIndex ?? session.messages.length,
      editIndex === undefined ? 0 : session.messages.length - editIndex,
      msg,
    );
    session.updatedAt = Date.now();
    changed();
  }
  if (online) {
    const pending = {
      ...msg,
      editIndex,
      attemptId: crypto.randomUUID(),
      resumeFrom: pausedTurn?.requestId,
      controller: new AbortController(),
      label: "正在保存当前文档",
      partial: "",
    };
    let admit;
    pending.admission = new Promise(resolve => { admit = resolve; });
    sending.set(session, pending);
    delete session.lastAgentFailure;
    const timer = setInterval(() => updateChatProgress(pending), 1000);
    refreshChat(owner, session);
    try {
      await transcripts.get(session)?.promise;
      const bookmark = transcripts.get(session)?.turns.findLast(t => t.control === "paused");
      pending.resumeFrom = bookmark?.requestId;
      if (bookmark) editIndex = pending.editIndex = bookmark.editIndex;
      changed();
      await flush();
      renderQuotes();
      const r = await streamChat(
        {
          doc: owner.id,

          mode: "chat",
          modelId,
          question: q,
          refs,
          chatId: session.id,
          requestId: msg.requestId,
          queued: !!queued,
          attemptId: pending.attemptId,
          resumeFrom: pending.resumeFrom,
          editIndex,
        },
        pending.controller,
        (event) => {
          if (event.canPause && !pending.canPause) {
            pending.canPause = true;
            admit();
            if (pending.pausing) pending.sendPause();
          }
          pending.label = event.label;
          pending.partial = event.partial || "";
          updateChatProgress(pending);
        },
      );
      if (r.status === "paused") {
        session.updatedAt = Date.now();
        session.pausedQuestion = q;
        changed();
        return;
      }
      if (!docs.includes(owner) && !folders.includes(owner)) return;
      Object.assign(msg, {
        answer: r.answer,
        answerEntry: r.answerEntry,
        toolCalls: r.toolCalls,
        compactions: r.compactions,
        skillsUsed: r.skillsUsed,
        elapsedMs: Date.now() - msg.createdAt,
        canvasPatch: r.canvasPatch,
        canvasBase: r.canvasBase,
        proposed: r.proposed,
        base: r.proposed != null ? (r.base ?? base) : undefined,
      });
      if (
        typeof r.proposed === "string" &&
        owner === doc &&
        selectedSession(owner) === session &&
        owner.type === "交互 HTML"
      )
        rawMode = true;
      session.conversationId = r.conversationId;
      delete session.pausedQuestion;
      if (r.delivery)
        msg.refs = archiveDelivery(owner, r.delivery).map((c) => c.id);
      finish();
      if (r.delivery) {
        if (folders.includes(doc)) openDoc(doc);
        tree();
        await flush();
      }
    } catch (e) {
      const error = pending.controller.signal.reason?.message || e.message;
      queueState(session).stopped = !e.selectionExpired;
      if (!queued || pending.canPause || e.selectionExpired) (session.failedAttempts ||= []).push({ ...msg, failure: error });
      else session.lastAgentFailure = error;
      session.updatedAt = Date.now();
      changed();
      toast(error);
    } finally {
      pending.ending = true;
      admit();
      clearInterval(timer);
      await loadTranscript(owner, session);
      try { await syncQueue(owner, session, "list"); }
      catch (error) { queueState(session).stopped = true; toast(error.message); }
      sending.delete(session);
      refreshChat(owner, session);
      drainQueue(owner, session);
    }
    return;
  }
  const source = editor.view.dom;
  const cur = source.textContent.trim();
  if (/^(查|搜|找)/.test(q)) {
    const term = q.replace(/^(查询|搜索|查找|查|搜|找)\s*/, "").trim();
    const hits = docs.filter((d) => {
      const box = document.createElement("div");
      box.innerHTML = d.html;
      return (d.title + box.textContent).includes(term);
    });
    msg.refs = hits.map((d) => d.id);
    msg.answer = hits.length
      ? "找到 " + hits.length + " 篇文档，点击标题查看来源。"
      : "没有匹配文档，请换一个关键词。";
  } else if (/字段/.test(q)) {
    const hs = [...source.querySelectorAll("th")].map((t) => t.textContent);
    msg.answer = hs.length
      ? "原文列出了「" +
        hs.join("」「") +
        "」。请逐列核对类型和空值展示，并确认枚举是否完整。"
      : "正文尚无字段表。请补充字段名、类型、含义、可选值和缺失值处理。";
    msg.draft = true;
  } else {
    msg.answer = /验收/.test(q)
      ? "验收「" +
        doc.title +
        "」时，按正文中的「" +
        (cur.split("\n").filter(Boolean)[0] || "需求目标") +
        "」核对默认状态、成功操作和无结果反馈。"
      : "围绕「" +
        doc.title +
        "」补充「" +
        q +
        "」时，请记录触发条件、用户操作、页面反馈和待确认事项。";
    msg.draft = true;
  }
  if (msg.draft) {
    msg.base = base;
    const paragraph = "<p>" + esc(msg.answer) + "</p>";
    msg.proposed = base + paragraph;
  }
  finish();
  chat();
}
async function shareFile() {
  if (!online) return toast("请在登录版工作台分享文件");
  const ref = doc.origin || { doc: doc.id, file: "document" };
  const title = doc.title;
  const button = $("share");
  button.disabled = true;
  try {
    await flush();
    let state = await api("share", { ...ref, lookup: true });
    dialog("分享「" + title + "」",
      '<label class="shareSetting"><span>开启链接分享</span><input type="checkbox" role="switch" id="shareEnabled"></label><input aria-label="分享链接" id="fileShareUrl" readonly>',
      () => {
        navigator.clipboard.writeText(state.url).then(() => toast("链接已复制"))
          .catch(() => { $("fileShareUrl").select(); toast("请复制选中的链接"); });
        return false;
      }, "复制链接");
    const toggle = $("shareEnabled"), link = $("fileShareUrl");
    const refresh = () => {
      toggle.checked = state.enabled;
      link.hidden = $("submit").hidden = !state.enabled;
      link.value = state.url || "";
    };
    refresh();
    $("cancel").textContent = "关闭";
    toggle.onchange = async () => {
      toggle.disabled = true;
      try { state = await api("share", { ...ref, enabled: toggle.checked }); }
      catch (error) { toast(error.message); }
      finally {
        toggle.disabled = false;
        if (toggle.isConnected) refresh();
      }
    };
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
}
function archiveWorkspaceFiles(output) {
  const all = new Map([...docs, ...folders].map((f) => [f.id, f]));
  const added = output.files
    .filter((f) => !all.has(f.id))
    .map(({ drawing, ...f }) => {
      if (boardType(f.type))
        f.scene = drawing ? proposedScene([], drawing) : [];
      else if (f.type === "交互 HTML") f.html ??= emptyHtml(f.title);
      else if (f.type === "文档") f.html = documentBody(f.html || "<p></p>");
      return f;
    });
  const changes = output.changes.filter(
    (c) => all.get(c.id)?.workspaceChangeRun !== output.runId,
  );
  const projected = new Map(all);
  for (const f of added) projected.set(f.id, f);
  for (const c of changes) {
    const f = all.get(c.id);
    if (
      !f ||
      f.title !== c.base.title ||
      (f.parent || "") !== c.base.parent ||
      (c.base.html !== undefined && (f.html || "") !== c.base.html) ||
      (c.base.scene !== undefined && sceneVersion(f.scene) !== c.base.scene)
    )
      throw Error("目标文件在任务期间已变更，请刷新并核对：" + c.base.title);
    projected.set(c.id, {
      ...f,
      ...(c.title !== undefined && { title: c.title }),
      ...(c.parent !== undefined && { parent: c.parent }),
    });
  }
  for (const id of [...added.map((f) => f.id), ...changes.map((c) => c.id)]) {
    const f = projected.get(id);
    if (
      [...projected.values()].some(
        (p) =>
          p.id !== id &&
          (p.parent || "") === (f.parent || "") &&
          p.title === f.title,
      )
    )
      throw Error("目标位置有同名文件：" + f.title);
    const seen = new Set([id]);
    let parent = f.parent;
    while (parent) {
      if (!projected.has(parent) || seen.has(parent))
        throw Error("目标父文件已变更：" + f.title);
      seen.add(parent);
      parent = projected.get(parent).parent;
    }
  }
  for (const f of added) (f.type === "文件夹" ? folders : docs).push(f);
  for (const c of changes) {
    const f = all.get(c.id);
    if (c.title !== undefined) f.title = c.title;
    if (c.parent !== undefined) f.parent = c.parent;
    if (c.html !== undefined || c.drawing) {
      (f.externalReviews ||= []).push({
        ...(c.html !== undefined && { proposed: c.html, base: f.html }),
        ...(c.drawing && { canvasPatch: c.drawing, canvasBase: c.base.scene }),
      });
    }
    f.workspaceChangeRun = output.runId;
  }
  const result = [
    ...output.files.map((f) => f.id),
    ...output.changes.map((c) => c.id),
  ]
    .map((id) => directory().entries.get(id)?.item)
    .filter(Boolean);
  for (const f of result) reveal(f.parent);
  changed();
  return result;
}
function archiveDelivery(d, output, title = d.title) {
  if (Array.isArray(output.files)) return archiveWorkspaceFiles(output);
  const existing =
    output.runId && docs.filter((f) => f.origin?.runId === output.runId);
  if (
    existing?.length &&
    ["prd", "html"].every(
      (k) => !output[k] || existing.some((f) => f.origin.file === k),
    )
  )
    return existing;
  const version = lastVersion(d) + 1,
    suffix = version > 1 ? " · v" + version : "";
  const children = generatedFiles(d, {
    ...output,
    version,
    fileNames: {
      prd: title + " · 图文 PRD" + suffix,
      html: title + " · 交互 HTML" + suffix,
    },
  });
  if (output.prd)
    children.find((c) => c.type === "文档").html = documentBody(output.prd);
  if (output.runId)
    for (const child of children) child.origin.runId = output.runId;
  docs.push(...children);
  d.lastOutputVersion = version;
  reveal(d.id);
  changed();
  return children;
}
async function setup() {
  decorate();
  const img = await sceneImage(demoScene(), {}, "#f0eef8");
  docs[0].html =
    '<h2>需求背景</h2><p>客户反馈分散在访谈记录和评审备忘中。产品经理需要一个统一的反馈池，按标题检索、按处理状态筛选，在评审时快速定位原始问题。</p><h2>页面草图</h2><img src="' +
    img +
    '" alt="反馈池列表与交互备注"><h2>交互与字段</h2><p>标题支持关键词匹配；状态为单选，默认全部。状态枚举：待评估、已采纳、暂缓。点击行展开该条反馈的详情。</p><p>反馈标题（文本）：该条反馈的简短描述。状态（枚举）：产品经理对反馈的处理结论。来源（文本）：记录该反馈的渠道。</p><table><tr><th>反馈标题</th><th>状态</th><th>来源</th></tr><tr><td>希望支持批量归档</td><td>待评估</td><td>客户访谈</td></tr><tr><td>补充快捷键说明</td><td>已采纳</td><td>评审备忘</td></tr><tr><td>列表支持自定义列</td><td>暂缓</td><td>客户访谈</td></tr><tr><td>搜索保留最近条件</td><td>待评估</td><td>产品体验</td></tr></table>';
  docs[0].scene = demoScene();
  const saved = await boot(snapshot,setModels);
  if (saved) {
    folders.splice(0, folders.length, ...saved.folders);
    docs.splice(0, docs.length, ...saved.docs);
    completionEnabled = saved.completionEnabled !== false;
    if (migrateDirectory()) changed();
    doc = firstDocument();
  } else {
    migrateDirectory();
    changed();
    await flush();
  }
  if (!online)
    completionEnabled = localStorage.getItem("xuye.completion") !== "off";
  const completionButton = $("completionToggle");
  const updateCompletion = () => {
    completionButton.setAttribute("aria-pressed", String(completionEnabled));
    completionButton.textContent = completionEnabled
      ? "AI 补全 · 开"
      : "AI 补全 · 关";
  };
  updateCompletion();
  completionButton.onclick = () => {
    completionEnabled = !completionEnabled;
    updateCompletion();
    hideSuggestion();
    if (!online)
      localStorage.setItem("xuye.completion", completionEnabled ? "on" : "off");
    changed();
  };
  editor = new Editor({
    element: $("editor"),
    extensions: [
      StarterKit.configure({ link: { openOnClick: false } }),
      TaskList,
      TaskItem.configure({ nested: true }),
      TableKit.configure({ table: { resizable: true } }),
      DocumentImage.configure({
        allowBase64: true,
        resize: {
          enabled: true,
          minWidth: 32,
          minHeight: 24,
          directions: ["bottom-right", "right", "bottom"],
          alwaysPreserveAspectRatio: false,
        },
      }),
      Markdown,
    ],
    editorProps: {
      attributes: { "aria-label": "文档正文" },
      handlePaste: (_, e) => {
        const file = [...e.clipboardData.files].find((f) =>
          f.type.startsWith("image/"),
        );
        if (file) {
          addImage(file);
          return true;
        }
        return false;
      },
      handleKeyDown: (view, e) => {
        if (
          !e.isComposing &&
          !e.altKey &&
          (e.ctrlKey || e.metaKey) &&
          e.key.toLowerCase() === "z"
        ) {
          e.preventDefault();
          return e.shiftKey ? editor.commands.redo() : editor.commands.undo();
        }
        const selection = view.state.selection;
        if (
          !e.isComposing &&
          ["Backspace", "Delete"].includes(e.key) &&
          selection instanceof NodeSelection &&
          selection.node.type.name === "image" &&
          !view.dom.querySelector(".marqueeSelected")
        ) {
          view.dispatch(
            closeHistory(view.state.tr).deleteSelection().scrollIntoView(),
          );
          return true;
        }
        return completion.handleKey(view, e);
      },
    },
    onUpdate: () => {
      if (doc?.type !== "文档") return;
      doc.html = editor.getHTML();
      changed();
      reviewDraft();
      header();
      completion.request();
    },
    onBlur: hideSuggestion,
  });
  editComposer = installComposer(renderChatMarkdown);
  installBlockTools(editor, () => $("file").click(), quoteSelection);
  $("htmlInput").addEventListener("select", refreshSourceQuote);
  $("htmlInput").addEventListener("selectionchange", refreshSourceQuote);
  $("quoteSource").onmousedown = e => e.preventDefault();
  $("quoteSource").onclick = () => quoteSelection();
  installDocumentOutline(editor.view.dom);
  editor.view.dom.addEventListener("compositionstart", () => {
    completion.composition(true);
  });
  editor.view.dom.addEventListener("compositionend", () => {
    completion.composition(false);
  });
  editor.view.dom.addEventListener("pointerdown", hideSuggestion);
  $("paperScroll").addEventListener("scroll", completion.reposition, { passive: true });
  writeSource = installHtmlSource((value) => {
    if (doc?.type !== "交互 HTML") return;
    doc.html = value;
    changed();
    if (
      selectedSession(doc)?.messages.some(
        (m) => typeof m.proposed === "string" && !m.resolved,
      )
    )
      reviewDraft();
  });
  $("renderMode").onclick = () => setHtmlMode(false);
  $("sourceMode").onclick = () => setHtmlMode(true);
  if (doc) openDoc(doc);
  else openFirstFile();
  $("title").oninput = (e) => {
    doc.title = e.target.value.trim() || "未命名文档";
    changed();
    tree();
    header();
  };
  $("title").onblur = () => ($("title").value = doc.title);
  $("newDoc").onclick = $("emptyNewDoc").onclick = () => create();
  $("serverLink").hidden = online;
  const reviewStyle = document.createElement("style");
  reviewStyle.textContent = deltaStyle;
  document.head.append(reviewStyle);
  installLayout();
  initModels(hideSuggestion);
  editor.view.dom.addEventListener("dragstart", (e) => {
    const sel = editor.state.selection;
    const text = editor.state.doc.textBetween(sel.from, sel.to, "\n");
    if (text)
      e.dataTransfer.setData(
        "application/x-xuye-selection",
        JSON.stringify({ title: doc.title, id: doc.id, text }),
      );
  });
  const agent = $("agent");
  const selectionType = "application/x-xuye-selection";
  const accepts = (transfer) =>
    [contextTransfer, selectionType, "text/plain", "Files"].some((type) =>
      transfer.types.includes(type),
    );
  agent.ondragover = (e) => {
    if (!accepts(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    agent.classList.add("accept-context");
  };
  agent.ondragleave = (e) => {
    if (!agent.contains(e.relatedTarget))
      agent.classList.remove("accept-context");
  };
  document.addEventListener("dragend", () =>
    agent.classList.remove("accept-context"),
  );
  agent.ondrop = (e) => {
    agent.classList.remove("accept-context");
    if (!accepts(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.files.length) {
      uploadFiles(Array.from(e.dataTransfer.files));
      return;
    }
    let ref;
    try {
      if (e.dataTransfer.types.includes(contextTransfer)) {
        const data = JSON.parse(e.dataTransfer.getData(contextTransfer));
        attachFile(data);
        return;
      } else if (e.dataTransfer.types.includes(selectionType)) {
        ref = JSON.parse(e.dataTransfer.getData(selectionType));
      } else
        ref = { title: doc.title, text: e.dataTransfer.getData("text/plain") };
    } catch {
      return;
    }
    if (ref.kind !== "file") {
      if (!ref.text?.trim()) return;
      ref = {
        kind: "selection",
        title: ref.title,
        id: ref.id,
        text: ref.text.slice(0, 12000),
      };
    }
    quoted.push(ref);
    renderQuotes();
    $("question").focus();
  };

  $("icons").onclick = () =>
    dialog(
      "插入图标",
      '<label for="symbol">基础图标</label><select name="symbol" id="symbol"><option>搜索</option><option>返回</option><option>菜单</option><option>添加</option></select>',
      ({ symbol }) => addIcon(symbol),
      "插入图标",
    );
  $("pasteArt").onclick = async () => {
    try {
      const src = await currentImage();
      const choices = docs.filter(
        (d) => !d.detachedSource && d.type === "文档",
      );
      if (!choices.length) return toast("请先在目录中新建文档");
      const ancestor = directory()
        .ancestors(doc.parent)
        .find((e) => choices.includes(e.item));
      dialog(
        "插入到文档",
        '<label for="targetDoc">目标文档</label><select id="targetDoc" name="id">' +
          choices
            .map(
              (d) =>
                '<option value="' +
                esc(d.id) +
                '"' +
                (ancestor?.item === d ? " selected" : "") +
                ">" +
                esc(
                  directory()
                    .ancestors(d.id)
                    .reverse()
                    .map((e) => e.title)
                    .join(" / "),
                ) +
                "</option>",
            )
            .join("") +
          "</select>",
        ({ id }) => {
          openDoc(choices.find((d) => d.id === id));
          editor.chain().focus("end").setImage({ src, alt: "画布选区" }).run();
          toast("画布图片已插入正文");
        },
        "插入图片",
      );
    } catch (e) {
      toast(e.message);
    }
  };
  $("copyArt").onclick = async () => {
    try {
      const make = async () => {
        const url = await currentImage();
        const b = atob(url.split(",")[1]);
        return new Blob([Uint8Array.from(b, (c) => c.charCodeAt(0))], {
          type: "image/png",
        });
      };
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": make() }),
      ]);
      toast("已复制 PNG，可粘贴到文档");
    } catch {
      toast("未能复制，请使用「插入到文档」");
    }
  };
  const settingsDialog = $("settingsDialog");
  function settingsPane(pane) {
    for (const b of settingsDialog.querySelectorAll("[data-pane]")) {
      $(b.dataset.pane).hidden = b.dataset.pane !== pane;
      b.setAttribute("aria-pressed", String(b.dataset.pane === pane));
    }
    if (pane === "agentPage") openAgentSettings();
  }
  settingsDialog
    .querySelector(".settingsTabs")
    .addEventListener("click", (e) => {
      if (e.target.dataset.pane) settingsPane(e.target.dataset.pane);
    });
  $("workspaceSettings").onclick = () => {
    settingsDialog.showModal();
    settingsPane("agentPage");
  };
  $("closeSettings").onclick = () => settingsDialog.close();
  $("assistantToggle").onclick = () => {
    openAgent = !openAgent;
    header();
  };
  $("closeAgent").onclick = () => {
    openAgent = false;
    header();
  };

  $("question").addEventListener("paste", (event) => {
    const data = event.clipboardData;
    if (!data) return;
    const images = Array.from(data.files).filter((file) =>
      file.type.startsWith("image/"),
    );
    if (!images.length) {
      for (const item of data.items) {
        if (item.kind === "file" && item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) images.push(file);
        }
      }
    }
    if (!images.length) return;
    // Keep the browser's normal text insertion for mixed text-and-image clips.
    if (!data.getData("text/plain")) event.preventDefault();
    uploadFiles(images);
  });
  $("question").onkeydown = (e) => {
    if (
      e.key === "Enter" &&
      !e.shiftKey &&
      !e.isComposing &&
      e.keyCode !== 229
    ) {
      e.preventDefault();
      $("askForm").requestSubmit();
    }
  };
  $("newChat").onclick = () => {
    const file = chatTarget();
    const session = {
      id: crypto.randomUUID(),
      messages: [],
      updatedAt: Date.now(),
    };
    sessions(file).push(session);
    selectChat(file, session);
    $("question").focus();
  };
  $("chatHistory").onclick = openChatHistory;
  $("closeHistory").onclick = () => $("historyDialog").close();

  $("attachContext").onclick = () => {
    if (online) $("chatFiles").click();
    else toast("请在登录版写作助手中上传附件");
  };
  $("chatFiles").onchange = (event) => {
    const files = Array.from(event.target.files);
    event.target.value = "";
    uploadFiles(files);
  };
  $("askForm").onsubmit = (e) => {
    e.preventDefault();
    ask($("question").value.trim());
  };
  editor.on("selectionUpdate", completion.selectionChanged);
  $("file").onchange = (e) => {
    addImage(e.target.files[0]);
    e.target.value = "";
  };
  $("generationRuns").onclick = () => {
    const file = doc;
    openGenerationLog(file, async (output) => {
      if (!docs.includes(file) && !folders.includes(file))
        throw Error("源文档已移除");
      archiveDelivery(file, output);
      await flush();
      tree();
      toast("已恢复到指定位置");
    });
  };
  $("share").onclick = shareFile;
}
async function publicBoard() {
  const endpoint = "../api/public/" + location.pathname.split("/").pop();
  const title = document.createElement("h1"),
    mount = document.createElement("div");
  mount.style.cssText = "height:calc(100dvh - 50px);width:100%";
  title.style.cssText = "font-size:18px;padding:10px 20px;margin:0";
  document.body.replaceChildren(title, mount);
  let revision,
    seq = 0;
  const stream = new EventSource(endpoint + "/events");
  async function refresh() {
    const id = ++seq;
    try {
      const response = await fetch(endpoint);
      if (id !== seq) return;
      if (!response.ok) {
        if (response.status === 404) {
          stream.close();
          unmountBoard();
          title.textContent = "分享链接不可用";
        }
        return;
      }
      const file = await response.json();
      if (id !== seq || revision === file.revision) return;
      revision = file.revision;
      title.textContent = document.title = file.title;
      mountBoard(file, mount, null, file.scene);
    } catch {
      title.textContent = "暂时无法读取画布";
    }
  }
  stream.onopen = stream.onmessage = refresh;
  await refresh();
}
(/\/s\/[^/]+$/.test(location.pathname) ? publicBoard() : setup()).catch((e) => {
  console.error(e);
  toast("初始化失败：" + e.message);
});
