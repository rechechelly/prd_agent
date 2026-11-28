import { toolDescriptions } from "../../shared/agent-catalog.mjs";
import { onlineBatchTool } from "./batch-tool.mjs";
import { arr, num, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { validateDrawing } from "../../shared/canvas-model.mjs";
import { boardType } from "../../shared/workspace-files.mjs";
export function drawCanvasTool(workspace) {
  return onlineBatchTool(workspace, {
    name: "draw_online_canvas",
    description: toolDescriptions.draw_online_canvas,
    parameters: obj({
      id: str({ pattern: "\\S", description: "目标画布的在线文件 ID" }),
      elements: opt(
        arr(
          obj({
            id: str({
              description: "唯一图元 ID，仅字母数字、下划线、短横线",
            }),
            type: oneOf([
              "rectangle",
              "diamond",
              "ellipse",
              "text",
              "line",
              "arrow",
            ]),
            x: opt(num()),
            y: opt(num()),
            width: opt(num()),
            height: opt(num()),
            text: opt(str()),
            fontSize: opt(num()),
            fill: opt(str()),
            stroke: opt(str()),
            from: opt(str({ description: "箭头起点框 ID" })),
            to: opt(str({ description: "箭头终点框 ID" })),
            points: opt(
              arr(arr(num()), {
                description: "相对于 x/y 的坐标点，如 [[0,0],[100,0]]",
              }),
            ),
          }),
        ),
      ),
      remove: opt(arr(str({ description: "要删除的已有图元 ID" }))),
      drawing: opt(
        str({
          description: "旧版完整 JSON 草案；新调用直接提供 elements、remove",
        }),
      ),
    }),
    execute(draft, args) {
      const doc = draft.target(args.id);
      if (!boardType(doc.type))
        throw Error(
          "目标不是画布。用 list_online_files 找到目标画布，或用 write_online_file 创建 canvas，再传入其 id。",
        );
      const scene = doc.scene || [];
      let patch;
      if (args.drawing !== undefined) {
        patch = validateDrawing(JSON.parse(args.drawing), scene);
      } else {
        const pending = new Map(doc.drawing?.elements.map((e) => [e.id, e]));
        const removed = new Set(doc.drawing?.remove);
        const effective = new Map(
          scene
            .filter((e) => !e.isDeleted && !removed.has(e.id))
            .map((e) => [e.id, e]),
        );
        for (const [id, item] of pending)
          effective.set(id, { ...effective.get(id), ...item });
        const batch = validateDrawing(args, [...effective.values()]);
        for (const item of batch.elements) {
          removed.delete(item.id);
          pending.set(item.id, { ...pending.get(item.id), ...item });
        }
        for (const id of batch.remove) {
          pending.delete(id);
          if (scene.some((e) => e.id === id && !e.isDeleted)) removed.add(id);
        }
        const all = {
          elements: [...pending.values()],
          remove: [...removed],
        };
        patch =
          all.elements.length || all.remove.length
            ? validateDrawing(all, scene)
            : undefined;
      }
      draft.saveDrawing(doc, patch);
      const summary = patch
        ? `本轮已记录 ${patch.elements.length} 个新增或更新图元，删除 ${patch.remove.length} 个。完成后用户可预览和采用。`
        : "本轮修改已撤回。";
      return `${doc.title}（${doc.id}）：${summary}`;
    },
  });
}
