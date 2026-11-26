import test from "node:test";
import assert from "node:assert/strict";
import { workspaceCreation } from "../create-file.mjs";

test("relative paths, duplicate calls, ambiguous parents and failed batches", async () => {
  const nodes = [
    { id: "current", title: "当前", type: "文档" },
    { id: "one", title: "同名", type: "画布" },
    { id: "two", title: "同名", type: "交互 HTML" },
  ];
  const plan = workspaceCreation(nodes, "current", () => {
    throw Error("不存在的工作文件");
  });
  const [create, read, edit] = plan.tools.map((t) => (args) => t.execute(args));
  const add = { type: "folder", path: "产品/授信" };
  const first = await create(add);
  const id = JSON.parse(first.output[0].text).id;
  assert.equal(JSON.parse((await create(add)).output[0].text).id, id);
  assert.equal(plan.entries.length, 2);
  assert.equal(plan.entries[0].parent, "current");
  assert.equal(
    (await create({ type: "document", path: "/同名/说明" })).isError,
    true,
  );
  assert.equal(
    (await create({ type: "canvas", path: "/不会留下/坏画布", content: "{}" }))
      .isError,
    true,
  );
  assert.equal(plan.entries.length, 2);
  const result = await create({
    type: "html",
    path: "页面",
    parent_id: "two",
    content: "<button>确认</button>",
  });
  assert.equal(result.isError, false);
  const page = JSON.parse(
    (await read({ id: JSON.parse(result.output[0].text).id })).output[0].text,
  );
  assert.equal(page.parent, "two");
  assert.equal(page.content, "<button>确认</button>");
  assert.equal((await edit({ id: "current", parent_id: id })).isError, true);
  assert.equal((await create({ type: "html", path: "../越界" })).isError, true);
  assert.deepEqual(plan.changes, []);
});

test("list_file paginates the effective tree after creates and moves", async () => {
  const workspace = workspaceCreation(
    [
      { id: "a", type: "文档", title: "项目" },
      { id: "b", type: "画布", title: "流程", parent: "a" },
    ],
    "a",
  );
  const tools = Object.fromEntries(
    workspace.tools.map((t) => [t.name, (args) => t.execute(args)]),
  );
  const data = async (result) => JSON.parse((await result).output[0].text);
  const added = await data(
    tools.write_file({ path: "/资料/预览", type: "html" }),
  );
  const start = await data(tools.list_file({ limit: 2 }));
  assert.equal(start.total, 4);
  assert.deepEqual(
    start.files.map((n) => [n.id, n.parent, n.depth]),
    [
      ["a", "", 0],
      ["b", "a", 1],
    ],
  );
  assert.equal(start.next_offset, 2);
  const rest = await data(tools.list_file({ offset: start.next_offset }));
  assert.deepEqual(
    rest.files.map((n) => n.type),
    ["文件夹", "交互 HTML"],
  );
  assert.equal(rest.next_offset, null);
  assert.equal(
    (await tools.edit_file({ id: "b", parent_id: added.id })).isError,
    false,
  );
  const subtree = await data(tools.list_file({ path: "/资料/预览" }));
  assert.deepEqual(
    subtree.files.map((n) => [n.id, n.parent]),
    [["b", added.id]],
  );
  assert.equal((await data(tools.list_file({ id: "a" }))).total, 0);
});
