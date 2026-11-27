import { migrateDirectory } from "../shared/migrate-directory.mjs";
import { applyDelivery } from "./workspace/deliveries";
import { shareFile, publicBoard } from "./review/file-sharing";
import { initModels, setModels, selectedModel } from "./workspace/providers";
import { editorCompletion } from "./editor/inline-completion";
import { queueState, syncQueue, renderQueue } from "./chat/chat-queue";
import { readTurns, findTurn, tracePanel } from "./chat/chat-trace";
import { boardType, onlineFileTypes } from "../shared/workspace-files.mjs";
import { markdownInsertion } from "./editor/completion-range";
import { installSourceEditor } from "./workspace/source-editor";
import { emptyHtml, sourceEdits } from "./workspace/html-source";
import { createDocumentEditor } from "./editor/document-editor";
import { sceneVersion } from "../shared/canvas-model.mjs";
import { targetsFile } from "../shared/chat-sessions.mjs";
import { editableTab, historyPopover, installContextWindow } from "./chat/session-controls";
import { configureNavigation, addressKey, visitFile, loadFile } from "./workspace/navigation";
import { chats, sessions, newSession, latestSession, chooseSession, selectedSession, sessionName } from "./chat/chat-sessions";
import { installComposer } from "./chat/composer";
import { renderChatMarkdown } from "./chat/markdown";
import { installReferenceInput } from "./chat/reference-input";
import { documentRange, rangeReference } from "./editor/selection-reference";
import { installWorkspaceSettings } from "./workspace/settings";
import { exampleWorkspace } from "./workspace/example";
import { planEdits, wireEdits } from "./editor/edit-comparison";
import { fileKey, resolveFile } from "../shared/assistant-context.mjs";
import {
  directoryIndex,
  renderDirectory,
} from "./workspace/directory";
import { DOMSerializer, DOMParser as SchemaParser } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import {
  mountBoard,
  unmountBoard,
  proposedScene,
  currentImage,
  addIcon,
} from "./workspace/board";
import { openGenerationLog } from "./workspace/generation-log";
import { $, esc, icon, decorate, dialog, toast } from "./shared";
import DOMPurify from "dompurify";
import { installLayout } from "./workspace/layout";
import {
  api,
  boot,
  changed,
  flush,
  forkChat,
  online,
  streamChat,
} from "./service";
import { openDiscussion, stopReview } from "./review/review";
import "./style.css";
import "./editor/block-tools.css";
import "./editor/inline-review.css";
import "./editor/document-outline.css";
import "./workspace/html-source.css";
import "./workspace/settings.css";
import "./chat/conversation.css";

const folders = [], docs = [];
const date = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "long",
  day: "numeric",
}).format(new Date());
const closed = new Set(["research"]);
let doc,
  loadedDoc,
  page = "work",
  editor,
  openAgent = innerWidth > 820;
let quoted = [],
  previewOriginal = false;
const sending = new Map();
const edits = new WeakMap();
const draftsBySession = new WeakMap();
const pendingUploads = new WeakMap();
let composerSession, composer, renderContextWindow;
let closeDirectoryDrawer;
function switchComposer(target) {
  if (composerSession === target) return;
  if (composerSession)
    draftsBySession.set(composerSession, {
      draft: composer.getDraft(),
      refs: quoted,
    });
  composerSession = target;
  const state = target && draftsBySession.get(target);
  quoted = state?.refs || [];
  composer.setDraft(state?.draft);
  $("agentContextInfo").open = false;
  renderQuotes();
}
function snapshot() {
  return { docs, folders, chats, completionEnabled };
}
async function quoteSelection(selection, rawSelection) {
  if (!online) return toast("请在登录版工作台使用划词提问");
  const file = doc, session = composerSession, source = file.html;
  try {
    const range = file.type === "交互 HTML"
      ? rawSelection || sourceEditor.selection()
      : documentRange(editor, source, selection);
    if (!range) return;
    const ref = await rangeReference(file, range, source);
    if (session !== composerSession || file !== doc || source !== file.html) return;
    const index = quoted.findIndex(item => item.kind === "range");
    if (index < 0) quoted.push(ref);
    else quoted[index] = ref;
    openAgent = true;
    header();
    renderQuotes();
    composer.focus();
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
  queueMicrotask(() => composer.focus());
}
async function uploadFiles(files) {
  const session = composerSession;
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
    if (composerSession === session) renderQuotes();
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
  if (pendingUploads.get(composerSession)) {
    const note = document.createElement("small");
    note.setAttribute("role", "status");
    note.textContent = "正在解析附件…";
    area.append(note);
  }
  $("askForm").querySelector(".send").disabled =
    !!pendingUploads.get(composerSession);
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
const editPlans = new WeakMap();
let visibleProposal, sourceEditor;
let rawMode = false;
function setHtmlMode(raw) {
  hideSuggestion();
  rawMode = raw;
  if (raw) previewOriginal = false;
  reviewDraft();
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

  if (rawMode && !sourceDiff) sourceEditor.set(doc.html);
  mountCompletionControls($("resultRail"), rawMode && !sourceDiff);
}
function reviewDraft(focusIndex) {
  const target = doc;

  const pending = selectedSession(target)?.messages.findLast(m => targetsFile(m, selectedSession(target), target) && typeof m.proposed === "string" && !m.resolved)
    || target?.externalReviews?.find(m => typeof m.proposed === "string" && !m.resolved);
  const isHtml = page === "result" && target?.type === "交互 HTML";
  const preview = $(isHtml ? "htmlDiff" : "draftPreview");
  const review = $("agentReview");
  const bar = $(isHtml ? "htmlChangeBar" : "changeBar");
  bar.hidden = !pending || (isHtml && !rawMode);

  review.hidden = !pending;
  const stale =
    pending &&
    (pending.reviewCurrent ?? pending.base) !== target.html;
  if (visibleProposal !== pending) previewOriginal = false;
  const inline = !!pending && !stale && !previewOriginal;
  if (inline) hideSuggestion();
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
        : planEdits(pending.base, pending.proposed),
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
      target !== doc ||
      pending.resolved ||
      pending.reviewChoices !== previousChoices ||
      (id !== null && choices[id])
    )
      return;
    if (
      (keep || id !== null) &&
      (pending.reviewCurrent ?? pending.base) !== target.html
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
      if (!done) pending.reviewCurrent = target.html;
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
      closeDirectoryDrawer();
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
  return first("") || docs[0];
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
      "<p>对应的工作区分享链接会失效。</p>" +
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
function header() {
  const isDoc = page === "work";
  $("canvasContext").hidden = page !== "boardPage";
  $("writingContext").hidden = page === "boardPage";
  composer.setPlaceholder(
    page === "boardPage"
      ? "描述要绘制的原型、业务流程或状态变化…"
      : doc?.type === "交互 HTML"
        ? "描述要修改的页面样式或交互…"
        : "提问或描述想修改的内容…",
  );
  const mount = isDoc
    ? $("workRail")
    : page === "result"
      ? $("resultRail")
      : $(page).querySelector(".pagehead") || $(page);
  if ($("assistantToggle").parentNode !== mount)
    mount.append($("assistantToggle"));
  mountCompletionControls(mount, isDoc || (page === "result" && doc?.type === "交互 HTML" && rawMode && !$("htmlSourceEditor").hidden));
  const comments = $("commentsToggle");
  if (doc && comments.parentNode !== mount) mount.insertBefore(comments, $("assistantToggle"));
  const share = $("share");
  share.hidden = !doc || (!isDoc && page !== "boardPage" && page !== "result");
  if (share.parentNode !== mount)
    mount.insertBefore(share, $("assistantToggle"));
  const generationRuns = $("generationRuns");
  generationRuns.hidden = !online || !doc || (page !== "boardPage" && page !== "result");
  if (!generationRuns.hidden) mount.append(generationRuns);
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
  switchComposer(selectedSession(doc));
  for (const id of ["work", "boardPage", "result", "emptyPage"])
    $(id).hidden = p !== id;
  closeDirectoryDrawer();
  tree();
  header();
}
let mountedBoard, mountedPatch;
function updateBoard() {
  const session = selectedSession(doc),
    msg = session.messages.findLast((m) => targetsFile(m, session, doc) && m.canvasPatch && !m.resolved)
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
let navigation = 0;
async function openDoc(d, replace = false) {
  const attempt = ++navigation;
  if (d?.deferred) {
    try { await loadFile(d); }
    catch (e) { toast(e.message); return false; }
    if (attempt !== navigation) return false;
  }
  visitFile(d, replace);
  if (!d) {
    doc = null;
    loadedDoc = null;
    show("emptyPage");
    return;
  }
  const switching = loadedDoc !== d;
  if (switching) {
    previewOriginal = false;
    latestSession(d);
  }
  loadedDoc = d;
  doc = d;
  reveal(d.parent);
  if (d.type === "交互 HTML" || folders.includes(d)) {
    show("result");
    openDiscussion(d);
    $("resultName").textContent = d.title;
    $("resultFrame").hidden = folders.includes(d);
    $("folderItems").hidden = !folders.includes(d);
    const isHtml = d.type === "交互 HTML";
    $("htmlModes").hidden = !isHtml;
    if (isHtml) {
      if (switching) {
        rawMode = false;
        $("resultFrame").removeAttribute("srcdoc");
        sourceEditor.set(d.html, true);
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
    openDiscussion(d);
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
  const options = Object.entries(onlineFileTypes).map(([kind, value]) => {
    const label = kind === "canvas" ? "原型画布" : kind === "html" ? "HTML" : value;
    return '<option value="' + value + '">' + label + '</option>';
  }).join("");
  dialog(
    entry ? "新建子文件" : "新建文件",
    '<label for="kind">类型</label><select id="kind" name="kind">' + options + '</select>' +
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
let completionEnabled = true;
function completionStatus(message = "", error) {
  const button = $("completionToggle");
  button.textContent = message || (completionEnabled ? "AI 补全 · 开" : "AI 补全 · 关");
  button.setAttribute("aria-pressed", String(completionEnabled));
  button.title = error || "输入后自动补全 · 单按 Tab 采纳，双按 Tab 生成或换一版，Esc 取消";
}
function mountCompletionControls(mount, visible) {
  for (const id of ["completionToggle", "completionModel"]) {
    const control = $(id);
    control.hidden = !visible || (id === "completionModel" && !online);
    if (visible && control.parentNode !== mount) mount.insertBefore(control, $("assistantToggle"));
  }
}
const commonCompletion = { getFile: () => doc, status: completionStatus };
const completion = editorCompletion({
  ...commonCompletion,
  enabled: () => completionEnabled && page === "work" && doc?.type === "文档" && !$("editor").hidden,
  markdown: (...args) => markdownInsertion(editor, ...args),
});
const codeCompletion = editorCompletion({
  ...commonCompletion,
  enabled: () => completionEnabled && page === "result" && doc?.type === "交互 HTML" && rawMode && !$("htmlSourceEditor").hidden,
});
function hideSuggestion() { completion.clear(); codeCompletion.clear(); }
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
function selectChat(file, session) {
  chooseSession(file, session);
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
    button.onclick = () => { if (active !== session) selectChat(file, session); };
    editableTab(button, session, name => { session.name = name; changed(); chat(); });
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
    ask(input.value, index, message.refsUsed || []);
  };
  form.append(input, note, cancel, send);
  box.replaceChildren(form);
}
function openChatHistory() {
  const file = doc;
  historyPopover(sessions(file), s => selectChat(file, s), s => {
    chats.splice(chats.indexOf(s), 1);
    latestSession(file);
    switchComposer(selectedSession(file));
    changed();
    chat();
    flush().catch(e => toast(e.message));
  }, s => sending.has(s));
}
async function branchAt(file, session, message, role) {
  try {
    const branch = await forkChat({ doc: file.id, chatId: session.id,
      index: session.messages.indexOf(message), entry: message.userEntry || findTurn(transcripts.get(session)?.turns || [], message)?.entry, role }, s => chats.push(s));
    const files = [...docs, ...folders];
    const target = sessions(file).includes(branch) ? file :
      files.find(f => f.id === (branch.messages.at(-1)?.fileId || branch.sourceId)) ||
      files.find(f => sessions(f).includes(branch));
    if (target) { await openDoc(target); selectChat(target, branch); }
  } catch (e) { toast(e.message); }
}
function branchButton(file, session, message, role) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "forkMessage";
  button.title = button.ariaLabel = role === "user" ? "从这条提问创建分支" : "从这条回复创建分支";
  button.innerHTML = icon("branch");
  button.onclick = () => branchAt(file, session, message, role);
  return button;
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
function currentContext() {
  const session = composerSession;
  const pending = sending.get(session), turns = transcripts.get(session)?.turns || [];
  const last = pending?.editIndex == null ? session?.messages.at(-1) : session.messages[pending.editIndex - 1];
  const paused = !pending && turns.findLast(t => t.control === "paused" || t.control === "ready");
  const used = pending?.contextTokens ?? (paused || last)?.contextTokens ??
    (last && findTurn(turns, last)?.contextTokens) ?? (pending || last || paused ? null : 0);
  return { session, used };
}
function loadTranscript(file, session) {
  const initial = !transcripts.has(session);
  const state = { turns: transcripts.get(session)?.turns || [] };
  transcripts.set(session, state);
  state.promise = flush().then(() => readTurns(file, session))
    .then((turns) => {
      if (transcripts.get(session) !== state) return;
      state.turns = turns;
      state.loaded = true;
      if (initial && !sending.has(session) && turns.some(t => t.control === "paused"))
        queueState(session).stopped = true;
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
  const file = doc,
    session = selectedSession(file);
  renderContextWindow();
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
    const blocked = hasProposal(file, session);
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
      esc(file.title) +
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
          composer.setText("查询 ");
          composer.focus();
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
    renderChatMarkdown(editor, body, m.q || "");
    question.append(body);
    block.append(question);
    if (online && (session.messages.includes(m) || findTurn(turns, m)?.entry)) question.append(branchButton(file, session, m, "user"));
    if (!pending && !m.failure && !m.control && !m.userOnly) {
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
          m.control === "ready" ? "结果已生成" :
          m.control === "followed" || pending?.resumeFrom === m.requestId
            ? "已接续到后续请求"
            : "已暂停";
        block.append(status);
        if (["paused", "ready"].includes(m.control) && !pending) {
          const resume = document.createElement("button");
          resume.type = "button";
          resume.className = "requestControl";
          resume.textContent = m.control === "ready" ? "取回结果" : "继续";
          resume.onclick = async () => {
            const target = directory().entries.get(m.fileId || session.sourceId)?.item;
            if (!target) return toast("请求的原文件已删除");
            await openDoc(target);
            if (target !== doc) return;
            selectChat(target, session);
            ask(m.q, m.editIndex, m.refsUsed || [], m);
          };
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
      if (m.userOnly) { area.append(block); continue; }
      const reply = document.createElement("div");
      reply.className = "agentReply";
      renderChatMarkdown(editor, reply, m.answer || "");
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
      if (online) actions.append(branchButton(file, session, m, "assistant"));
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
  if (doc && selectedSession(doc) === session) chat();
}
function hasProposal(file, session, messages = session.messages) {
  return [...messages.filter(m => (m.fileId || session?.sourceId) === file.id), ...(file.externalReviews || [])]
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
  const transcript = transcripts.get(session);
  if (!transcript?.loaded || transcript.turns.some(t => t.control === "ready")) return;
  if (sending.has(session) || state.loading || state.promoting || state.stopped ||
      !state.items.length || (!docs.includes(file) && !folders.includes(file))) return;
  const item = state.items[0];
  const target = directory().entries.get(item.doc || file.id)?.item;
  if (!target) { state.stopped = true; return; }
  if (target.deferred) { loadFile(target).then(() => drainQueue(target, session)).catch(e => toast(e.message)); return; }
  if (hasProposal(target, session)) return;
  runQuestion(target, session, item.question, undefined, item.refs, undefined, item);
}
async function ask(q, editIndex, editRefs, resume) {
  if (!doc || !q.trim()) return;
  const file = doc, session = selectedSession(file);
  if (pendingUploads.get(session)) return toast("附件解析完成后即可发送");
  session.lastAskedAt = Date.now();
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
    if (composer.getText().trim() === q.trim()) composer.setText("");
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
  const base = owner.html;
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
  if (hasProposal(owner, session, prefix)) {
    toast("请先处理当前文件中的待采纳修改");
    return;
  }
  const refs = (editRefs ?? quoted).map((r) =>
    r.kind === "file" ? { ...r, title: referenceLabel(r) } : { ...r },
  );
  const msg = {
    fileId: owner.id,
    q,
    refsUsed: refs,
    createdAt: resume?.createdAt || Date.now(),
    requestId: queued?.requestId || resume?.requestId || crypto.randomUUID(),
  };
  const sentFromComposer = !queued && !resume && composer.getText().trim() === q.trim();
  if (sentFromComposer) composer.setText("");
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
          if (event.contextTokens != null && event.contextTokens !== pending.contextTokens) {
            pending.contextTokens = event.contextTokens;
            if (composerSession === session) renderContextWindow();
          }
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
        userEntry: r.userEntry,
        toolCalls: r.toolCalls,
        written: r.written,
        compactions: r.compactions,
        contextTokens: r.contextTokens,
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
      if (r.delivery) {
        await loadChangeTargets(r.delivery);
        msg.written = msg.refs = archiveDelivery(owner, r.delivery).map(c => c.id);
      }
      finish();
      if (r.delivery) {
        if (folders.includes(doc) || r.delivery.changes?.some(change => change.id === doc?.id))
          openDoc(doc);
        else tree();
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
async function loadChangeTargets(output) {
  const index = directory();
  await Promise.all((output.changes || []).map(c => loadFile(index.entries.get(c.id)?.item)));
}
function archiveDelivery(owner, output, title = owner.title) {
  const files = applyDelivery(docs, folders, owner, output, title, documentBody);
  for (const file of files) reveal(file.parent);
  changed();
  return files;
}
async function setup() {
  decorate();
  const saved = await boot(snapshot, setModels, configureNavigation);
  const initial = saved || await exampleWorkspace();
  folders.push(...initial.folders);
  docs.push(...initial.docs);
  chats.push(...initial.chats || []);
  completionEnabled = initial.completionEnabled !== false;
  if (!saved) { migrateDirectory(docs, folders); changed(); }
  if (!saved) await flush();
  doc = saved ? firstDocument() : docs[0];
  if (!online)
    completionEnabled = localStorage.getItem("xuye.completion") !== "off";
  const completionButton = $("completionToggle");
  completionStatus();
  completionButton.onclick = () => {
    completionEnabled = !completionEnabled;
    completionStatus();
    hideSuggestion();
    if (!online)
      localStorage.setItem("xuye.completion", completionEnabled ? "on" : "off");
    changed();
  };
  editor = createDocumentEditor({
    completion,
    getFile: () => page === "work" ? doc : null,
    quoteSelection,
    onChange(currentEditor) {
      if (doc?.type !== "文档") return;
      doc.html = currentEditor.getHTML();
      changed();
      reviewDraft();
      header();
    },
  });
  composer = installComposer(ask);
  renderContextWindow = installContextWindow(currentContext);
  sourceEditor = installSourceEditor({
    completion: codeCompletion,
    quote: () => quoteSelection(),
    onEdit(value) {
      if (doc?.type !== "交互 HTML") return;
      doc.html = value;
      changed();
      if (selectedSession(doc)?.messages.some(m => typeof m.proposed === "string" && !m.resolved))
        reviewDraft();
    },
  });
  $("renderMode").onclick = () => setHtmlMode(false);
  $("sourceMode").onclick = () => setHtmlMode(true);
  closeDirectoryDrawer = installLayout();
  const addressFile = () => {
    const key = addressKey();
    return key ? [...docs, ...folders].find(f => (f.key || f.id) === key) : firstDocument() || folders[0];
  };
  await openDoc(addressFile(), true);
  window.addEventListener("popstate", () => openDoc(addressFile(), true));
  $("title").oninput = (e) => {
    doc.title = e.target.value.trim() || "未命名文档";
    changed();
    tree();
    header();
  };
  $("title").onblur = () => ($("title").value = doc.title);
  $("newDoc").onclick = $("emptyNewDoc").onclick = () => create();
  $("serverLink").hidden = online;
  initModels(hideSuggestion);
  installReferenceInput({
    editor, getFile: () => doc, sourceSelection: () => sourceEditor.selection(), quoteSelection, attachFile, uploadFiles,
    attachText(text) {
      quoted.push({ kind: "selection", title: "外部文本", text: text.slice(0, 12000) });
      renderQuotes();
      composer.focus();
    },
  });

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
        (d) => d.type === "文档",
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
        async ({ id }) => {
          const target = choices.find(d => d.id === id);
          await openDoc(target);
          if (doc !== target) return;
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
  installWorkspaceSettings();
  $("assistantToggle").onclick = () => {
    openAgent = !openAgent;
    if (openAgent && doc) { latestSession(doc); switchComposer(selectedSession(doc)); chat(); }
    header();
  };
  $("closeAgent").onclick = () => {
    openAgent = false;
    header();
  };

  $("newChat").onclick = () => {
    const file = doc;
    const session = newSession(file);
    selectChat(file, session);
    composer.focus();
  };
  $("chatHistory").onclick = openChatHistory;
  $("closeHistory").onclick = () => $("historyDialog").hidePopover();

  $("generationRuns").onclick = () => {
    const file = doc;
    openGenerationLog(file, async (output) => {
      if (!docs.includes(file) && !folders.includes(file))
        throw Error("源文档已移除");
      await loadChangeTargets(output);
      archiveDelivery(file, output);
      await flush();
      tree();
      toast("已恢复到指定位置");
    });
  };
  $("share").onclick = () => shareFile(doc);
}
(document.querySelector("meta[name=public-token]") ? publicBoard() : setup()).catch((e) => {
  console.error(e);
  toast("初始化失败：" + e.message);
});
