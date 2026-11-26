// Only scene content participates in review conflicts. Pan and zoom are local view state.
export function sceneVersion(elements = []) {
  return JSON.stringify(
    elements
      .filter((e) => !e.isDeleted)
      .map((e) => [e.id, e.version, e.versionNonce]),
  );
}
export function describeCanvas(elements = []) {
  return elements
    .filter((e) => !e.isDeleted)
    .map((e) => ({
      id: e.id,
      type: e.type,
      x: e.x,
      y: e.y,
      width: e.width,
      height: e.height,
      ...(e.text && { text: e.text }),
      ...(e.containerId && { container: e.containerId }),
      ...(e.startBinding && { from: e.startBinding.elementId }),
      ...(e.endBinding && { to: e.endBinding.elementId }),
    }));
}
const types = new Set([
  "rectangle",
  "diamond",
  "ellipse",
  "text",
  "line",
  "arrow",
]);
const shapes = new Set(["rectangle", "diamond", "ellipse"]);
export function validateDrawing(raw, scene) {
  const current = new Map(
    scene.filter((e) => !e.isDeleted).map((e) => [e.id, e]),
  );
  const { elements = [], remove = [] } = raw || {};
  if (
    !Array.isArray(elements) ||
    !Array.isArray(remove) ||
    !(elements.length + remove.length) ||
    elements.length + remove.length > 400
  )
    throw Error("请提交 1 至 400 个图元变更");
  const ids = new Set(),
    removed = new Set(remove);
  for (const id of removed)
    if (!current.has(id)) throw Error("找不到要删除的图元 " + id);
  const normalized = elements.map((e) => {
    if (
      !e ||
      typeof e.id !== "string" ||
      !/^[\w-]{1,100}$/.test(e.id) ||
      ids.has(e.id) ||
      removed.has(e.id) ||
      !types.has(e.type)
    )
      throw Error("图元必须有独立 id 和有效 type");
    const old = current.get(e.id);
    if (old && (old.type !== e.type || old.containerId))
      throw Error("修改现有图元请保留类型，绑定文字请修改所属框或箭头的 text");
    ids.add(e.id);
    const item = { id: e.id, type: e.type };
    for (const k of ["x", "y", "width", "height", "fontSize"]) {
      if (e[k] === undefined) continue;
      if (
        !Number.isFinite(e[k]) ||
        Math.abs(e[k]) > 100000 ||
        (["width", "height", "fontSize"].includes(k) && e[k] <= 0)
      )
        throw Error("无效尺寸或坐标 " + k);
      item[k] = e[k];
    }
    if (e.text !== undefined) {
      if (typeof e.text !== "string" || e.text.length > 5000)
        throw Error("文字格式有误");
      item.text = e.text;
    }
    for (const k of ["fill", "stroke"])
      if (e[k] !== undefined) {
        if (!/^#[a-f\d]{6}$/i.test(e[k])) throw Error("颜色请使用六位 HEX");
        item[k] = e[k];
      }
    if (e.points !== undefined) {
      if (
        !Array.isArray(e.points) ||
        e.points.length < 2 ||
        e.points.length > 80 ||
        e.points.some(
          (p) =>
            !Array.isArray(p) ||
            p.length !== 2 ||
            p.some((n) => !Number.isFinite(n) || Math.abs(n) > 100000),
        )
      )
        throw Error("线段需要有效的二维坐标点");
      item.points = e.points;
    }
    if (e.from !== undefined || e.to !== undefined) {
      if (
        e.type !== "arrow" ||
        typeof e.from !== "string" ||
        typeof e.to !== "string"
      )
        throw Error("绑定箭头需要 from 和 to");
      item.from = e.from;
      item.to = e.to;
    }
    if (e.type === "text" && !(e.text ?? old?.text))
      throw Error("文本框缺少文字");
    return item;
  });
  const available = new Map([...current, ...normalized.map((e) => [e.id, e])]);
  for (const e of normalized)
    for (const id of [e.from, e.to]) {
      if (
        id !== undefined &&
        (!shapes.has(available.get(id)?.type) || removed.has(id))
      )
        throw Error("箭头指向的状态框不存在：" + id);
    }
  return { elements: normalized, remove: [...removed] };
}
