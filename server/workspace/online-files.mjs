import { createHash, randomUUID } from "node:crypto";
import { boardType, onlineFileTypes, workspacePath } from "../../shared/workspace-files.mjs";
import { editOnlineFileBody, textEditOperations } from "../../shared/online-file-edit.mjs";
import { resolveFile } from "../../shared/assistant-context.mjs";
import {
  describeCanvas,
  sceneVersion,
  validateDrawing,
} from "../../shared/canvas-model.mjs";

export function checkOnlineFileSize(content) {
  if (Buffer.byteLength(content) > 12_000_000) throw Error("单文件超过 12 MB");
}

export function contentVersion(body) {
  return createHash("sha256").update(body).digest("hex");
}

function fileName(value) {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name || name === "." || name === ".." || /[\/\\\x00-\x1f]/.test(name))
    throw Error("请输入有效的在线文件名，不能使用路径分隔符、空段或上级目录");
  return name;
}

function parentKey(id, nodes) {
  if (id === null) return "";
  if (typeof id !== "string" || !id.trim())
    throw Error("请传父节点的 parent_id；根目录使用 null");
  if (!nodes.some(node => node.id === id))
    throw Error("父节点不存在，请用 list_online_files({parent_id:null}) 核对 ID");
  return id;
}

function checkFields(extra) {
  const fields = Object.keys(extra);
  if (fields.length)
    throw Error("不支持字段 " + fields.join("、") + "。已有文件用 id，列目录和新建文件用 parent_id。");
}

function keepNetChange(change, sameHtml) {
  // A field restored to its original value must not conflict with subsequent user edits.
  for (const field of ["title", "parent"]) {
    if (change[field] === change.base[field]) delete change[field];
  }
  if (change.html !== undefined && sameHtml(change.html, change.base.html)) delete change.html;
  if (change.html === undefined) delete change.base.html;
  return Object.keys(change).length > 2; // id and base alone are not a change
}

// File IDs are the only selectors. Paths in tool results are display labels.
export function onlineWorkspace(nodes, currentId, current, { entries = [], changes = [], sameHtml = Object.is } = {}) {
  const currentBaseHtml = current?.baseHtml ?? current?.read().html;
  changes = changes.filter(change => keepNetChange(change, sameHtml));
  // A batch sees its own earlier writes. Publish its draft only after every item succeeds.
  async function transaction(apply) {
    const pending = {};
    const draft = onlineWorkspace(nodes, currentId, current && {
      baseHtml: currentBaseHtml,
      read: () => ({ ...current.read(), ...pending }),
      write: html => { pending.html = html; },
      ...(current.writeDrawing && { writeDrawing: drawing => { pending.drawing = drawing; } }),
    }, {
      sameHtml,
      entries: entries.map(entry => ({ ...entry })),
      changes: changes.map(change => ({ ...change, base: { ...change.base } })),
    });
    const result = await apply(draft);
    if (Object.hasOwn(pending, "html")) await current.write(pending.html);
    if (Object.hasOwn(pending, "drawing")) current.writeDrawing(pending.drawing);
    entries = draft.entries;
    changes = draft.changes;
    return result;
  }
  function effective() {
    return [...nodes, ...entries].map((n) => ({
      ...n,
      ...(n.id === currentId && current?.read()),
      ...changes.find((c) => c.id === n.id),
    }));
  }
  function target(id) {
    if (typeof id !== "string" || !id.trim())
      throw Error("请传在线文件的 id；可用 list_online_files({parent_id:null}) 查询");
    const node = effective().find(n => n.id === id);
    if (!node) throw Error("文件 ID 不存在，请用 list_online_files({parent_id:null}) 核对 ID");
    return node;
  }
  function recordUpdate(node, update) {
    const original = nodes.find((f) => f.id === node.id);
    if (!original) {
      Object.assign(
        entries.find((f) => f.id === node.id),
        update,
      );
      return;
    }
    let item = changes.find((c) => c.id === node.id);
    if (!item) {
      item = {
        id: node.id,
        base: { title: original.title, parent: original.parent || "" },
      };
      changes.push(item);
    }
    if (update.html !== undefined) item.base.html ??= original.html || "";
    Object.assign(item, update);
    if (Object.hasOwn(update, "drawing")) {
      if (update.drawing) item.base.scene ??= sceneVersion(original.scene);
      else {
        delete item.drawing;
        delete item.base.scene;
      }
    }
    if (!keepNetChange(item, sameHtml)) changes.splice(changes.indexOf(item), 1);
  }
  function saveDrawing(node, patch) {
    if (node.id === currentId && current?.writeDrawing)
      current.writeDrawing(patch);
    else recordUpdate(node, { drawing: patch });
  }

  function read({ id, version, file, offset = 0, limit = 16000, ...extra }, maxChars = 40000) {
    checkFields(extra);
    let n;
    if (version !== undefined || file !== undefined) {
      if (typeof id !== "string" || !id.trim() || !Number.isSafeInteger(version) || !file)
        throw Error("历史交付引用需要 id、version 和 file");
      const revision = resolveFile(nodes, { id, version, file });
      if (!revision) throw Error("找不到此版本的交付文件");
      n = { ...revision, id, html: revision.content };
    } else n = target(id);
    if (maxChars < 1) throw Error("读取项目太多，请分批读取");
    if (offset < 0 || limit < 1)
      throw Error("offset 需非负，limit 需为正数");
    let body = n.html || "", content_version;
    if (n.type === "文件夹") {
      const children = effective().filter(child => child.parent === n.id);
      body = JSON.stringify(children.map(({ id, type, title }) => ({ id, type, title })));
    } else if (boardType(n.type)) {
      body = JSON.stringify({ elements: describeCanvas(n.scene), pending: n.drawing });
    } else if (version === undefined) content_version = contentVersion(body);
    const end = offset + Math.min(limit, maxChars);
    return {
      id: n.id,
      title: n.title,
      type: n.type,
      ...(version === undefined && { parent_id: n.parent || null }),
      content_version,
      length: body.length,
      content: body.slice(offset, end),
      next_offset: end < body.length ? end : null,
    };
  }

  function list({ parent_id, offset = 0, limit = 100, ...extra }) {
    checkFields(extra);
    if (offset < 0 || limit < 1) throw Error("分页参数无效");
    const children = new Map();
    const nodes = effective();
    const root = parentKey(parent_id, nodes);
    for (const node of nodes) {
      const key = node.parent || "";
      if (!children.has(key)) children.set(key, []);
      children.get(key).push(node);
    }
    const rows = [],
      seen = new Set([root]);
    const byId = new Map(nodes.map(node => [node.id, node]));
    const prefix = root ? workspacePath(byId, byId.get(root)) + "/" : "";
    const stack = (children.get(root) || [])
      .map((node) => ({ node, depth: 0, path: prefix + node.title }))
      .reverse();
    while (stack.length) {
      const { node, depth, path } = stack.pop();
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      rows.push({
        id: node.id,
        parent_id: node.parent || null,
        title: node.title,
        type: node.type,
        depth,
        display_path: path,
      });
      for (const child of [...(children.get(node.id) || [])].reverse())
        stack.push({ node: child, depth: depth + 1, path: path + "/" + child.title });
    }
    const end = offset + Math.min(limit, 300);
    return {
      current_id: currentId,
      parent_id,
      total: rows.length,
      next_offset: end < rows.length ? end : null,
      files: rows.slice(offset, end),
    };
  }

  function create({ title, type, parent_id, content, ...extra }) {
    checkFields(extra);
    if (!Object.hasOwn(onlineFileTypes, type)) throw Error("不支持的文件类型");
    title = fileName(title);
    const working = effective();
    const parent = parentKey(parent_id, working);
    if (type === "folder" && content !== undefined) throw Error("文件夹不能设置正文");
    const material = { html: content };
    if (content !== undefined) checkOnlineFileSize(content);
    if (type === "canvas" && material.html) {
      const parsed = JSON.parse(material.html);
      if (!Array.isArray(parsed?.elements))
        throw Error("画布内容需要 elements 数组");
      if (parsed.remove !== undefined && (!Array.isArray(parsed.remove) || parsed.remove.length))
        throw Error("新画布没有可删除的图元，remove 应为空数组");
      if (parsed.elements.length)
        material.drawing = validateDrawing(parsed, []);
      delete material.html;
    }
    const siblings = working.filter(n => (n.parent || "") === parent && n.title === title);
    if (siblings.length > 1)
      throw Error(`该父节点下有 ${siblings.length} 个同名文件「${title}」。请用 list_online_files 传入相同的 parent_id 核对各文件 ID，或更换 title 新建。`);
    let item = siblings[0];
    if (item) {
      const retry = entries.some(f => f.id === item.id) &&
        item.type === onlineFileTypes[type] && item.html === material.html &&
        JSON.stringify(item.drawing) === JSON.stringify(material.drawing);
      if (!retry)
        throw Error("同名文件已存在：「" + title + "」（ID " + item.id +
          "）。请用 list_online_files 核对 ID 后编辑已有文件，或更换 title 新建。");
    } else {
      item = { id: randomUUID(), title, parent, type: onlineFileTypes[type], ...material };
      entries.push(item);
    }
    return {
      id: item.id, parent_id, title, type,
      display_path: workspacePath(new Map(working.map(node => [node.id, node])), item),
      status: "已登记，任务完成后归档",
    };
  }

  async function edit({ id, title, parent_id, content, append, old_text, drawing, list, replace_all, base_version, ...extra }) {
    checkFields(extra);
    const n = target(id),
      all = effective();
    const update = {};
    if (list !== undefined && (!Array.isArray(list) || !list.length ||
      content !== undefined || old_text !== undefined || append !== undefined))
      throw Error("list 需要至少一项替换，且不能与 content、old_text 或 append 混用");
    if (
      append &&
      ((n.type !== "文档" && !["需求文档", "备忘录"].includes(n.type)) ||
        content === undefined ||
        old_text !== undefined)
    )
      throw Error("append 需要文档和正文，并与 old_text 互斥");
    const wholeBody = content !== undefined && old_text === undefined && !append && list === undefined;
    if (!wholeBody && (replace_all || base_version !== undefined))
      throw Error("replace_all 和 base_version 仅用于整篇替换，请从局部编辑或元数据修改中移除");
    if (title !== undefined) {
      const name = fileName(title);
      if (name !== n.title) update.title = name;
    }
    const oldParent = n.parent || "";
    const destination = parent_id === undefined ? oldParent : parentKey(parent_id, all);
    if (destination !== oldParent) {
      let parent = destination;
      const seen = new Set([n.id]);
      while (parent) {
        if (seen.has(parent)) throw Error("文件不能移到自身或后代之下");
        seen.add(parent);
        const ancestor = all.find((f) => f.id === parent);
        if (!ancestor) throw Error("父文件不存在");
        parent = ancestor.parent;
      }
      update.parent = destination;
    }
    const pathChanged = update.title !== undefined || update.parent !== undefined;
    if (
      pathChanged &&
      all.some(
        (f) =>
          f.id !== n.id &&
          (f.parent || "") === (update.parent ?? n.parent ?? "") &&
          f.title === (update.title ?? n.title),
      )
    )
      throw Error("目标位置有同名文件");
    if (
      content !== undefined ||
      drawing !== undefined ||
      old_text !== undefined ||
      list !== undefined
    ) {
      if (boardType(n.type) || drawing !== undefined)
        throw Error("编辑画布图元请使用 draw_online_canvas");
      if (n.type === "文件夹" || (content === undefined && list === undefined))
        throw Error("该类型不支持此正文操作");
      const body = n.html || "";
      if (wholeBody) {
        if (replace_all !== true || !base_version)
          throw Error("局部替换请传 list 或 old_text。整篇替换需先用 read_online_file 读取目标，再传 replace_all:true、base_version（读取结果的 content_version）和完整 content");
        if (base_version !== contentVersion(body))
          throw Error("正文版本不匹配，请用 read_online_file 重读目标，基于最新内容修订后使用新的 content_version 作为 base_version");
      }
      const edits = list
        ? textEditOperations(list)
        : [{ content, oldText: old_text, append }];
      const after = editOnlineFileBody(n.id, body, edits);
      if (!sameHtml(after, body)) {
        checkOnlineFileSize(after);
        update.html = after;
      }
    }
    if (!Object.keys(update).length) {
      if ([title, parent_id, content, list].every(value => value === undefined))
        throw Error("请提供要修改的内容");
      return "文件无变化 " + n.id + "。本次操作没有产生新修改。";
    }
    if (n.id === currentId && current && update.html !== undefined) {
      await current.write(sameHtml(update.html, currentBaseHtml) ? currentBaseHtml : update.html);
      delete update.html;
    }
    if (Object.keys(update).length) recordUpdate(n, update);
    const currentState = n.id === currentId && current?.read();
    const pending = entries.some(f => f.id === n.id) || changes.some(c => c.id === n.id) ||
      (currentState && (currentState.html !== currentBaseHtml || currentState.drawing));
    if (!pending) return "文件已恢复原状 " + n.id + "，没有待提交的修改。";
    const count = list?.filter(item => item.old_text !== item.new_text).length;
    return "已登记修改 " + n.id + (count ? `（${count} 处）` : "");
  }

  return {
    get entries() { return entries; },
    get changes() { return changes; },
    target, saveDrawing, read, list, create, edit, transaction,
  };
}
