import React from "react";
import { createRoot } from "react-dom/client";
import {
  Excalidraw,
  convertToExcalidrawElements,
  exportToCanvas,
} from "@excalidraw/excalidraw";
const purple = "#6554ae",
  ink = "#36354c";
const rect = (
  x,
  y,
  width,
  height,
  backgroundColor,
  strokeColor = "transparent",
) => ({
  type: "rectangle",
  x,
  y,
  width,
  height,
  backgroundColor,
  strokeColor,
  fillStyle: "solid",
  roughness: 0,
  strokeWidth: 1,
});
const label = (x, y, text, fontSize = 17, strokeColor = ink) => ({
  type: "text",
  x,
  y,
  text,
  fontFamily: 2,
  fontSize,
  strokeColor,
  roughness: 0,
});
const sketch = [
  rect(0, 0, 730, 286, "#f0eef8"),
  rect(27, 24, 504, 237, "#ffffff", "#c2bdd6"),
  rect(27, 24, 504, 32, "#e5e0f3", "#c2bdd6"),
  label(40, 31, "●   ●   ●", 13, "#a59abc"),
  label(48, 71, "客户反馈池", 23),
  rect(49, 111, 137, 27, "#f6f5fa", "#d5d2e1"),
  label(57, 117, "搜索反馈标题", 13, "#8a8798"),
  rect(201, 111, 95, 27, "#f6f5fa", "#d5d2e1"),
  label(209, 117, "状态   ▾", 13),
  rect(49, 151, 459, 24, "#f0eef6"),
  label(58, 155, "反馈标题", 13),
  label(372, 155, "状态", 13),
  label(58, 186, "希望支持批量归档", 15),
  label(58, 218, "补充快捷键说明", 15),
  rect(369, 182, 72, 23, "#e9e3f8"),
  label(379, 186, "待评估", 13, purple),
  rect(369, 214, 72, 23, "#e1eee8"),
  label(379, 218, "已采纳", 13, "#466651"),
  rect(552, 89, 150, 104, "#fff2ce", "#d5c18c"),
  label(566, 104, "交互备注", 17, "#786139"),
  label(566, 138, "按状态筛选\n点击行查看详情", 14, "#756950"),
];
export const demoScene = () => convertToExcalidrawElements(sketch);
let root, api, owner;
export function unmountBoard() {
  owner = null;
  root?.unmount();
  root = api = null;
}
export function mountBoard(doc, mount, onSceneChange, preview, focusIds) {
  unmountBoard();
  owner = doc;
  api = null;
  root = createRoot(mount);
  const elements = preview ?? doc.scene ?? [];
  let focusElements = focusIds?.size
    ? elements.filter((e) => focusIds.has(e.id) || focusIds.has(e.containerId))
    : null;
  root.render(
    React.createElement(Excalidraw, {
      langCode: "zh-CN",
      theme: "light",
      detectScroll: true,
      viewModeEnabled: Boolean(preview),
      excalidrawAPI: (value) => {
        api = value;
      },
      initialData: {
        elements,
        files: doc.files || {},
        appState: {
          currentItemFontFamily: 2,
          currentItemRoughness: 0,
          viewBackgroundColor: "#fbfafc",
          ...(preview ? {} : doc.view),
        },
        scrollToContent: !focusElements?.length && (!!preview || !doc.view),
      },
      onChange: (items, state, files) => {
        if (
          focusElements?.length &&
          api &&
          state.width &&
          state.height &&
          items.length
        ) {
          const target = focusElements,
            board = api;
          focusElements = null;
          requestAnimationFrame(() => {
            if (api === board)
              board.scrollToContent(target, {
                fitToContent: true,
                viewportZoomFactor: 0.83,
              });
          });
        }
        if (preview || owner !== doc) return;
        if (
          doc.scene !== items ||
          doc.files !== files ||
          doc.view?.scrollX !== state.scrollX ||
          doc.view?.scrollY !== state.scrollY ||
          doc.view?.zoom?.value !== state.zoom.value
        )
          onSceneChange?.();
        doc.scene = items;
        doc.files = files;
        doc.view = {
          scrollX: state.scrollX,
          scrollY: state.scrollY,
          zoom: state.zoom,
        };
      },
      UIOptions: {
        canvasActions: {
          loadScene: false,
          saveToActiveFile: false,
          export: false,
        },
      },
      autoFocus: true,
    }),
  );
}
export function addIcon(name) {
  if (!api) return;
  const s = api.getAppState(),
    x = s.width / 2 / s.zoom.value - s.scrollX,
    y = s.height / 2 / s.zoom.value - s.scrollY;
  const group = crypto.randomUUID();
  const paths = {
    搜索: [
      { type: "ellipse", x, y, width: 23, height: 23 },
      {
        type: "line",
        x: x + 19,
        y: y + 19,
        points: [
          [0, 0],
          [11, 11],
        ],
      },
    ],
    返回: [
      {
        type: "line",
        x,
        y,
        points: [
          [15, 0],
          [0, 13],
          [15, 26],
        ],
      },
    ],
    菜单: [0, 9, 18].map((d) => ({
      type: "line",
      x,
      y: y + d,
      points: [
        [0, 0],
        [28, 0],
      ],
    })),
    添加: [
      {
        type: "line",
        x,
        y: y + 13,
        points: [
          [0, 0],
          [26, 0],
        ],
      },
      {
        type: "line",
        x: x + 13,
        y,
        points: [
          [0, 0],
          [0, 26],
        ],
      },
    ],
  };
  const items = convertToExcalidrawElements(
    paths[name].map((item) => ({
      ...item,
      groupIds: [group],
      strokeColor: purple,
      strokeWidth: 2,
      roughness: 0,
    })),
  );
  api.updateScene({
    elements: [...api.getSceneElements(), ...items],
    appState: {
      selectedElementIds: Object.fromEntries(items.map((i) => [i.id, true])),
    },
  });
}
export async function sceneImage(elements, files = {}, bg = "#ffffff") {
  if (!elements?.length) throw new Error("请先在画布上添加图层");
  const canvas = await exportToCanvas({
    elements,
    files,
    appState: {
      exportBackground: true,
      viewBackgroundColor: bg,
      exportScale: 1,
    },
    exportPadding: 10,
  });
  return canvas.toDataURL("image/png");
}
export async function currentImage() {
  if (!api || !owner) throw new Error("画布正在加载");
  const all = api.getSceneElements(),
    selected = all.filter(
      (item) =>
        api.getAppState().selectedElementIds[item.id] ||
        api.getAppState().selectedElementIds[item.containerId] ||
        api.getAppState().selectedElementIds[item.frameId],
    );
  return sceneImage(selected.length ? selected : all, api.getFiles());
}

// Convert only touched elements. Untouched layers retain native styling, images and IDs.
export function proposedScene(scene = [], patch) {
  const live = scene.filter((e) => !e.isDeleted);
  const original = new Map(live.map((e) => [e.id, e]));
  const remove = new Set(patch.remove);
  const changes = new Map(patch.elements.map((e) => [e.id, e]));
  for (const e of live) {
    if (e.type !== "arrow") continue;
    const ends = [e.startBinding?.elementId, e.endBinding?.elementId].filter(
      Boolean,
    );
    if (ends.some((id) => remove.has(id)) && !changes.has(e.id))
      remove.add(e.id);
    else if (ends.some((id) => changes.has(id)) && !changes.has(e.id))
      changes.set(e.id, { id: e.id, type: e.type });
  }
  const stubs = new Map(),
    skeletons = [],
    labels = new Map();
  for (const e of live) if (e.containerId) labels.set(e.containerId, e);
  for (const item of changes.values()) {
    if (remove.has(item.id)) continue;
    const old = original.get(item.id),
      oldLabel = labels.get(item.id);
    const shape = {
      id: item.id,
      type: item.type,
      x: item.x ?? old?.x ?? 0,
      y: item.y ?? old?.y ?? 0,
      width: item.width ?? old?.width ?? 160,
      height: item.height ?? old?.height ?? 70,
      roughness: old?.roughness ?? 0,
      fillStyle: old?.fillStyle ?? "solid",
      strokeColor: item.stroke ?? old?.strokeColor ?? "#43465b",
      backgroundColor: item.fill ?? old?.backgroundColor ?? "transparent",
    };
    const text = item.text ?? oldLabel?.text ?? old?.text;
    const fontSize = item.fontSize ?? oldLabel?.fontSize ?? old?.fontSize ?? 18;
    if (item.type === "text")
      Object.assign(shape, { text, fontFamily: 2, fontSize });
    else if (text) shape.label = { text, fontSize, fontFamily: 2 };
    if (item.type === "line" || item.type === "arrow") {
      shape.points = item.points ??
        old?.points ?? [
          [0, 0],
          [shape.width, 0],
        ];
      if (item.type === "arrow") {
        const ends = [
          item.from ?? old?.startBinding?.elementId,
          item.to ?? old?.endBinding?.elementId,
        ];
        const nodes = ends.map((id) => {
          if (!id || remove.has(id)) return;
          const oldNode = original.get(id),
            change = changes.get(id);
          const node = {
            id,
            type: change?.type ?? oldNode?.type,
            x: change?.x ?? oldNode?.x ?? 0,
            y: change?.y ?? oldNode?.y ?? 0,
            width: change?.width ?? oldNode?.width ?? 160,
            height: change?.height ?? oldNode?.height ?? 70,
          };
          if (!change) stubs.set(id, node);
          return node;
        });
        if (nodes[0]) shape.start = { id: nodes[0].id };
        if (nodes[1]) shape.end = { id: nodes[1].id };
        if (nodes.every(Boolean) && !item.points) {
          const [a, b] = nodes;
          const dx = b.x + b.width / 2 - a.x - a.width / 2,
            dy = b.y + b.height / 2 - a.y - a.height / 2;
          const edge = (n) =>
            Math.min(
              dx ? n.width / 2 / Math.abs(dx) : Infinity,
              dy ? n.height / 2 / Math.abs(dy) : Infinity,
              0.49,
            );
          const start = edge(a),
            end = edge(b);
          shape.x = a.x + a.width / 2 + dx * start;
          shape.y = a.y + a.height / 2 + dy * start;
          shape.points = [
            [0, 0],
            [dx * (1 - start - end), dy * (1 - start - end)],
          ];
        }
      }
    }
    skeletons.push(shape);
  }
  const built = convertToExcalidrawElements([...stubs.values(), ...skeletons], {
    regenerateIds: false,
  });
  const updated = new Map(built.map((e) => [e.id, e]));
  const result = [];
  for (const e of live) {
    if (
      remove.has(e.id) ||
      (e.containerId &&
        (remove.has(e.containerId) || changes.has(e.containerId)))
    )
      continue;
    const replacement = updated.get(e.id);
    updated.delete(e.id);
    const bindings = (e.boundElements || []).filter(
      (b) =>
        !changes.has(b.id) &&
        !remove.has(b.id) &&
        (!changes.has(e.id) || b.type !== "text"),
    );
    const newBindings = replacement?.boundElements || [];
    if (
      changes.has(e.id) ||
      replacement ||
      bindings.length !== (e.boundElements || []).length
    ) {
      const next = changes.has(e.id) ? { ...e, ...replacement } : { ...e };
      next.boundElements = [
        ...new Map(
          [...bindings, ...newBindings].map((b) => [b.id, b]),
        ).values(),
      ];
      next.version = e.version + 1;
      result.push(next);
    } else result.push(e);
  }
  result.push(...updated.values());
  return result;
}
