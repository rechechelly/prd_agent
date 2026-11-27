import { randomUUID } from "node:crypto";
import { boardType, onlineFileTypes, workspacePath } from "../../shared/workspace-files.mjs";
import { editOnlineFileBody } from "../../shared/online-file-edit.mjs";
import { resolveFile } from "../../shared/assistant-context.mjs";
import {
  describeCanvas,
  sceneVersion,
  validateDrawing,
} from "../../shared/canvas-model.mjs";

export function checkOnlineFileSize(content) {
  if (Buffer.byteLength(content) > 12_000_000) throw Error("单文件超过 12 MB");
}

function fileName(value) {
  const name = value.trim();
  if (!name || name === "." || name === ".." || /[\/\\\x00-\x1f]/.test(name))
    throw Error("请输入有效的在线文件名，不能使用路径分隔符、空段或上级目录");
  return name;
}

function relativeNames(path) {
  if (typeof path !== "string" || /^(?:\/|[a-z][a-z0-9+.-]*:\/\/)/i.test(path) || path.includes("\\"))
    throw Error("请使用在线工作区内的相对路径");
  const names = path.replace(/^\.\//, "").split("/").map(fileName);
  if (/^[a-z]:/i.test(names[0])) throw Error("请使用在线工作区内的相对路径");
  return names;
}

// Paths resolve against workspace nodes only. An unsuccessful call adds no ancestors.
export function onlineWorkspace(nodes, currentId, current) {
  const entries = [],
    changes = [];
  function effective() {
    return [...nodes, ...entries].map((n) => ({
      ...n,
      ...(n.id === currentId && current?.read()),
      ...changes.find((c) => c.id === n.id),
    }));
  }
  function target(id, path) {
    const all = effective();
    if (id !== undefined && path !== undefined)
      throw Error("请选择 id 或 path");
    if (path !== undefined) {
      let parent = "";
      for (const title of relativeNames(path)) {
        const matches = all.filter(
          (n) => (n.parent || "") === parent && n.title === title,
        );
        if (!matches.length)
          throw Error("路径中找不到「" + title + "」，请用 list_online_files 核对位置");
        if (matches.length > 1)
          throw Error("路径中有重名文件「" + title + "」，请用 list_online_files 返回的 ID");
        parent = matches[0].id;
      }
      id = parent;
    }
    const node = all.find((n) => n.id === (id ?? currentId));
    if (!node) throw Error("文件不存在");
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
        if (Object.keys(item).length === 2)
          changes.splice(changes.indexOf(item), 1);
      }
    }
  }
  function saveDrawing(node, patch) {
    if (node.id === currentId && current?.writeDrawing)
      current.writeDrawing(patch);
    else recordUpdate(node, { drawing: patch });
  }

  function read({ id, path, version, file, offset = 0, limit = 16000 }) {
    let n;
    if (version !== undefined || file !== undefined) {
      if (!id || path !== undefined || !Number.isSafeInteger(version) || !file)
        throw Error("历史交付引用需要 id、version 和 file");
      const revision = resolveFile(nodes, { id, version, file });
      if (!revision) throw Error("找不到此版本的交付文件");
      n = { ...revision, id, html: revision.content };
    } else n = target(id, path);
    if (offset < 0 || limit < 1)
      throw Error("offset 需非负，limit 需为正数");
    let body = n.html || "";
    if (n.type === "文件夹") {
      const children = effective().filter(child => child.parent === n.id);
      body = JSON.stringify(children.map(({ id, type, title }) => ({ id, type, title })));
    } else if (boardType(n.type)) {
      body = JSON.stringify({ elements: describeCanvas(n.scene), pending: n.drawing });
    }
    return {
      id: n.id,
      title: n.title,
      type: n.type,
      parent: n.parent || "",
      length: body.length,
      content: body.slice(offset, offset + Math.min(limit, 40000)),
    };
  }

  function list({ id, path, offset = 0, limit = 100 }) {
    if (offset < 0 || limit < 1) throw Error("分页参数无效");
    const root =
      id === undefined && (path === undefined || path === "." || path === "./")
        ? ""
        : target(id, path).id;
    const children = new Map();
    const nodes = effective();
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
        parent: node.parent || "",
        title: node.title,
        type: node.type,
        depth,
        path,
      });
      for (const child of [...(children.get(node.id) || [])].reverse())
        stack.push({ node: child, depth: depth + 1, path: path + "/" + child.title });
    }
    const end = offset + Math.min(limit, 300);
    return {
      current_id: currentId,
      root,
      total: rows.length,
      next_offset: end < rows.length ? end : null,
      files: rows.slice(offset, end),
    };
  }

  function create({ path, type, parent_id, content, source }) {
    if (!Object.hasOwn(onlineFileTypes, type)) throw Error("不支持的文件类型");
    const names = relativeNames(path);
    if (source !== undefined) throw Error("请用 content 提交正文。任务文件可先用 read 读取");
    const working = effective(),
      pending = [];
    let parent = parent_id ?? "";
    if (parent && !working.some((n) => n.id === parent))
      throw Error("父文件不存在，请使用 list_online_files 核对 ID");
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
    for (const [i, title] of names.entries()) {
      const leaf = i === names.length - 1;
      const matches = working.filter(
        (n) => (n.parent || "") === parent && n.title === title,
      );
      if (matches.length > 1)
        throw Error("路径中有重名文件「" + title + "」，请指定父文件 ID");
      let item = matches[0];
      if (leaf && item) {
        if (
          !entries.some((f) => f.id === item.id) ||
          item.type !== onlineFileTypes[type] ||
          ["html", "drawing"].some(
            (k) => JSON.stringify(item[k]) !== JSON.stringify(material[k]),
          )
        )
          throw Error(
            "同名文件已存在：「" + title + "」，请核对路径或使用其他名称",
          );
      } else if (!item) {
        item = {
          id: randomUUID(),
          parent,
          title,
          type: leaf ? onlineFileTypes[type] : "文件夹",
          ...(leaf && material),
        };
        pending.push(item);
        working.push(item);
      }
      parent = item.id;
    }
    entries.push(...pending);
    const byId = new Map(working.map(node => [node.id, node]));
    return {
      id: parent,
      path: workspacePath(byId, byId.get(parent)),
      type,
      status: "已登记，任务完成后归档",
    };
  }

  async function edit({ id, path, title, parent_id, content, source, append, old_text, drawing }) {
    const n = target(id, path),
      all = effective();
    const update = {};
    if (source !== undefined) throw Error("请用 content 提交正文。任务文件可先用 read 读取");
    if (
      append &&
      ((n.type !== "文档" && !["需求文档", "备忘录"].includes(n.type)) ||
        content === undefined ||
        old_text !== undefined)
    )
      throw Error("append 需要文档和正文，并与 old_text 互斥");
    if (title !== undefined) update.title = fileName(title);
    if (parent_id !== undefined) {
      let parent = parent_id;
      const seen = new Set([n.id]);
      while (parent) {
        if (seen.has(parent)) throw Error("文件不能移到自身或后代之下");
        seen.add(parent);
        const ancestor = all.find((f) => f.id === parent);
        if (!ancestor) throw Error("父文件不存在");
        parent = ancestor.parent;
      }
      update.parent = parent_id;
    }
    if ((title !== undefined || parent_id !== undefined) && !(update.parent ?? n.parent))
      relativeNames(update.title ?? n.title);
    if (
      (title !== undefined || parent_id !== undefined) &&
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
      old_text !== undefined
    ) {
      if (boardType(n.type) || drawing !== undefined)
        throw Error("编辑画布图元请使用 draw_online_canvas");
      if (n.type === "文件夹" || content === undefined)
        throw Error("该类型不支持此正文操作");
      update.html = editOnlineFileBody(n.id, n.html || "", { content, oldText: old_text, append });
      checkOnlineFileSize(update.html);
    }
    if (!Object.keys(update).length) throw Error("请提供要修改的内容");
    if (n.id === currentId && current && update.html !== undefined) {
      await current.write(update.html);
      delete update.html;
    }
    if (Object.keys(update).length) recordUpdate(n, update);
    return "已登记修改 " + n.id;
  }

  return { entries, changes, target, saveDrawing, read, list, create, edit };
}
