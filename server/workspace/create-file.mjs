import { randomUUID } from "node:crypto";
import { defineTool } from "@earendil-works/pi-durable";
import { obj, oneOf, opt, str, int, bool } from "@earendil-works/pi-schema";
import {
  describeCanvas,
  sceneVersion,
  validateDrawing,
} from "../../shared/canvas-model.mjs";

const types = {
  folder: "文件夹",
  document: "文档",
  canvas: "画布",
  html: "交互 HTML",
};
export const createFileDescription =
  "在工作区创建文件夹、文档、原型画布或 HTML。path 是含文件名的工作区路径，以 / 开头从根目录解析，否则以 parent_id 或当前文件为起点。中间缺失目录自动创建；任何文件都能作为父级。同名路径不会覆盖已有文件。每次返回新 ID，可用于后续调用。";
const reply = (text, isError = false) => ({
  output: [{ type: "text", text }],
  isError,
});

// Paths resolve against workspace nodes only. An unsuccessful call adds no ancestors.
export function workspaceCreation(nodes, currentId, readSource, current) {
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
      let parent = path.startsWith("/") ? "" : currentId;
      for (const title of (path.startsWith("/") ? path.slice(1) : path).split(
        "/",
      )) {
        const matches = all.filter(
          (n) => (n.parent || "") === parent && n.title === title,
        );
        if (matches.length !== 1)
          throw Error("路径不存在或有重名，请用 list_file 返回的 ID");
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
  const selector = { id: opt(str()), path: opt(str()) };
  const read = defineTool({
    name: "read_file",
    description:
      "按工作区文件 ID 或路径读取，默认当前文件。返回文档正文、HTML 源码、画布图元或文件夹清单。可用 offset、limit 按字符读取长内容。",
    parameters: obj({ ...selector, offset: opt(int()), limit: opt(int()) }),
    async execute({ id, path, offset = 0, limit = 16000 }) {
      try {
        const n = target(id, path);
        const children = effective()
          .filter((c) => c.parent === n.id)
          .map(({ id, type, title }) => ({ id, type, title }));
        const body =
          n.type === "文件夹"
            ? JSON.stringify(children)
            : ["画布", "原型画布"].includes(n.type)
              ? JSON.stringify({
                  elements: describeCanvas(n.scene),
                  pending: n.drawing,
                })
              : n.html || "";
        if (offset < 0 || limit < 1)
          throw Error("offset 需非负，limit 需为正数");
        return reply(
          JSON.stringify({
            id: n.id,
            title: n.title,
            type: n.type,
            parent: n.parent || "",
            length: body.length,
            content: body.slice(offset, offset + Math.min(limit, 40000)),
          }),
        );
      } catch (error) {
        return reply(error.message, true);
      }
    },
  });
  const edit = defineTool({
    name: "edit_file",
    description:
      "按 ID 或路径重命名、移动任意文件。编辑文档或 HTML 的正文可传 content 完整替换，或传 old_text 和 content 精确替换。编辑画布图元使用 draw_canvas。",
    parameters: obj({
      ...selector,
      title: opt(str()),
      parent_id: opt(str()),
      content: opt(str()),
      source: opt(
        str({
          description:
            "从本轮 Bash 工作目录读取 UTF-8 文件，用于包含内嵌图片或表格的正文，与 content 二选一。",
        }),
      ),
      append: opt(bool({ description: "向文档末尾追加，保留已有正文。" })),
      old_text: opt(str()),
    }),
    async execute({
      id,
      path,
      title,
      parent_id,
      content,
      source,
      append,
      old_text,
      drawing,
    }) {
      try {
        const n = target(id, path),
          all = effective();
        const update = {};
        if (source !== undefined) {
          if (content !== undefined) throw Error("请选择 source 或 content");
          content = (await readSource(source, n.type)).html;
        }
        if (
          append &&
          ((n.type !== "文档" && !["需求文档", "备忘录"].includes(n.type)) ||
            content === undefined ||
            old_text !== undefined)
        )
          throw Error("append 需要文档和正文，并与 old_text 互斥");
        if (title !== undefined) {
          if (!title.trim() || title.includes("/"))
            throw Error("请输入有效文件名");
          update.title = title.trim();
        }
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
          if (["画布", "原型画布"].includes(n.type) || drawing !== undefined)
            throw Error("编辑画布图元请使用 draw_canvas");
          if (n.type === "文件夹" || content === undefined)
            throw Error("该类型不支持此正文操作");
          const old = n.html || "";
          if (
            old_text !== undefined &&
            (!old_text ||
              old.indexOf(old_text) < 0 ||
              old.indexOf(old_text) !== old.lastIndexOf(old_text))
          )
            throw Error("old_text 需要唯一匹配");
          update.html = append
            ? /<\/body\s*>/i.test(old)
              ? old.replace(/<\/body\s*>/i, (match) => content + match)
              : old + content
            : old_text === undefined
              ? content
              : old.replace(old_text, () => content);
        }
        if (!Object.keys(update).length) throw Error("请提供要修改的内容");
        if (
          update.html !== undefined &&
          Buffer.byteLength(update.html) > 12_000_000
        )
          throw Error("单文件超过 12 MB");
        if (n.id === currentId && current && update.html !== undefined) {
          await current.write(update.html);
          delete update.html;
        }
        if (Object.keys(update).length) recordUpdate(n, update);
        return reply("已登记修改 " + n.id);
      } catch (error) {
        return reply(error.message, true);
      }
    },
  });
  const tool = defineTool({
    name: "write_file",
    description: createFileDescription,
    parameters: obj({
      path: str(),
      type: oneOf(Object.keys(types)),
      parent_id: opt(
        str({
          description: "明确的父文件 ID，与绝对路径互斥；空字符串为根目录",
        }),
      ),
      content: opt(
        str({
          description:
            "文档富文本 HTML、单文件 HTML 源码或画布 JSON（含 elements 数组）；省略创建空文件。",
        }),
      ),
      source: opt(
        str({
          description:
            "从本次 Bash 工作目录读取一个 UTF-8 文件，传文件名，与 content 二选一。",
        }),
      ),
    }),
    async execute({ path, type, parent_id, content, source }) {
      try {
        if (!Object.hasOwn(types, type)) throw Error("不支持的文件类型");
        const absolute = path.startsWith("/");
        if (absolute && parent_id !== undefined)
          throw Error("绝对路径和 parent_id 请选择一种");
        const names = (absolute ? path.slice(1) : path)
          .split("/")
          .map((s) => s.trim());
        if (
          names.some(
            (s) => !s || s === "." || s === ".." || /[\x00-\x1f]/.test(s),
          )
        )
          throw Error("路径需要有效文件名，不能包含空段、. 或 ..");
        const working = effective(),
          pending = [];
        let parent = absolute ? "" : (parent_id ?? currentId);
        if (parent && !working.some((n) => n.id === parent))
          throw Error("父文件不存在，请使用 list_file 核对 ID");
        if (content !== undefined && source !== undefined)
          throw Error("请选择 content 或 source");
        if (
          type === "folder" &&
          (content !== undefined || source !== undefined)
        )
          throw Error("文件夹不能设置正文");
        const material =
          source !== undefined
            ? await readSource(source, type)
            : { html: content };
        if (
          material.html !== undefined &&
          Buffer.byteLength(material.html) > 12_000_000
        )
          throw Error("单文件超过 12 MB 工作副本限制");
        if (type === "canvas" && material.html) {
          const parsed = JSON.parse(material.html);
          if (!Array.isArray(parsed?.elements))
            throw Error("画布内容需要 elements 数组");
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
              item.type !== types[type] ||
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
              type: leaf ? types[type] : "文件夹",
              ...(leaf && material),
            };
            pending.push(item);
            working.push(item);
          }
          parent = item.id;
        }
        entries.push(...pending);
        return reply(
          JSON.stringify({
            id: parent,
            path,
            type,
            status: "已登记，任务完成后归档",
          }),
        );
      } catch (error) {
        return reply(error.message, true);
      }
    },
  });
  const list = defineTool({
    name: "list_file",
    description:
      "列出工作区文件树，含名称、类型、ID、父 ID 和层级。默认从根目录开始；传 id 或 path 可只列该节点的后代。offset 和 limit 用于分页。",
    parameters: obj({ ...selector, offset: opt(int()), limit: opt(int()) }),
    async execute({ id, path, offset = 0, limit = 100 }) {
      try {
        if (offset < 0 || limit < 1) throw Error("分页参数无效");
        const root =
          id === undefined && (path === undefined || path === "/")
            ? ""
            : target(id, path).id;
        const children = new Map();
        for (const node of effective()) {
          const key = node.parent || "";
          if (!children.has(key)) children.set(key, []);
          children.get(key).push(node);
        }
        const rows = [],
          seen = new Set([root]);
        const stack = (children.get(root) || [])
          .map((node) => ({ node, depth: 0 }))
          .reverse();
        while (stack.length) {
          const { node, depth } = stack.pop();
          if (seen.has(node.id)) continue;
          seen.add(node.id);
          rows.push({
            id: node.id,
            parent: node.parent || "",
            title: node.title,
            type: node.type,
            depth,
          });
          for (const child of [...(children.get(node.id) || [])].reverse())
            stack.push({ node: child, depth: depth + 1 });
        }
        const end = offset + Math.min(limit, 300);
        return reply(
          JSON.stringify({
            current_id: currentId,
            root,
            total: rows.length,
            next_offset: end < rows.length ? end : null,
            files: rows.slice(offset, end),
          }),
        );
      } catch (error) {
        return reply(error.message, true);
      }
    },
  });
  return {
    tools: [tool, read, edit, list],
    entries,
    changes,
    effective,
    target,
    saveDrawing,
  };
}
