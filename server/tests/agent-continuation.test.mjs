import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

test("Pi resumes workspace edits, generated files and native compaction", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "xuye-agent-test-"));
  process.env.XUYE_DATA = directory;
  const { runAgent, pauseAgent } = await import("../agent.mjs");
  const { db } = await import("../storage.mjs");
  const captures = [];
  let responses = [];
  const modelServer = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    captures.push(request);
    const next = responses.shift();
    if (next?.hold) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.flushHeaders();
      next.hold();
      return;
    }
    if (!next || next.overflow) {
      res.writeHead(400, { "content-type": "application/json" });
      return res.end(
        JSON.stringify({
          error: {
            message: next
              ? "This model's maximum context length is 128000 tokens. However, you requested 145000 tokens."
              : "unexpected request",
          },
        }),
      );
    }
    const delta = next.name
      ? {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "call_" + captures.length,
              type: "function",
              function: {
                name: next.name,
                arguments:
                  typeof next.args === "string"
                    ? next.args
                    : JSON.stringify(next.args),
              },
            },
          ],
        }
      : { role: "assistant", content: next.text };
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const [piece, finish_reason] of [
      [delta, null],
      [{}, next.reason ?? (next.name ? "tool_calls" : "stop")],
    ])
      res.write(
        "data: " +
          JSON.stringify({
            id: "local",
            object: "chat.completion.chunk",
            created: 1,
            model: "local",
            choices: [{ index: 0, delta: piece, finish_reason }],
          }) +
          "\n\n",
      );
    res.end("data: [DONE]\n\n");
  });
  t.after(async () => {
    modelServer.closeAllConnections();
    await new Promise((resolve) => modelServer.close(resolve));
    db.close();
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) =>
    modelServer.once("error", reject).listen(0, "127.0.0.1", resolve),
  );
  const model = {
    name: "local",
    model: "test",
    base: "http://127.0.0.1:" + modelServer.address().port,
    secret: "test",
  };
  const doc = { type: "文档", title: "根", id: "current", html: "<p>原文</p>" };
  const context = { doc, docs: [doc], rule: "" };
  const tool = (name, args) => ({ name, args });
  const ask = (question, session) =>
    runAgent({ ...context, session }, { mode: "chat", question }, model);
  const lastMessages = () => JSON.stringify(captures.at(-1).messages);
  const badCall = {
    ...tool("edit_file", {
      path: "prototype.html",
      content: "SHOULD_NEVER_COMMIT",
    }),
    reason: "length",
  };
  responses = [
    tool("write_file", {
      path: "prototype.html",
      type: "html",
      content: "<body>SKELETON</body>",
    }),
    badCall,
    tool("read_file", { path: "prototype.html" }),
    tool("edit_file", {
      path: "prototype.html",
      old_text: "SKELETON",
      content: "<button>演示</button>",
    }),
    tool("write_file", {
      path: "prd.html",
      type: "document",
      content: "<p>待补齐</p>",
    }),
    { ...badCall, args: '{"path":"prd.html","content":"BROKEN' },
    tool("read_file", { path: "prd.html" }),
    tool("edit_file", {
      path: "prd.html",
      old_text: "待补齐",
      content: "用户点击演示",
    }),
    { text: "已完成" },
  ];
  const result = await ask("创建原型和需求文档");
  assert.deepEqual(
    result.workspaceFiles.map((f) => [f.title, f.html]),
    [
      ["prototype.html", "<body><button>演示</button></body>"],
      ["prd.html", "<p>用户点击演示</p>"],
    ],
  );
  assert.match(
    JSON.stringify(captures[2].messages),
    /截断回复中的工具调用均未执行/,
  );
  assert.doesNotMatch(
    JSON.stringify(captures[2].messages),
    /SHOULD_NEVER_COMMIT/,
  );
  assert.match(JSON.stringify(captures[3].messages), /SKELETON/);
  assert.equal(
    captures[0].max_completion_tokens ?? captures[0].max_tokens,
    32768,
  );
  assert.equal(responses.length, 0);

  responses = [
    tool("write_file", { type: "html", path: "原型", content: "draft" }),
    { ...badCall, args: { path: "原型", content: "INVALID" } },
    tool("list_file", {}),
    tool("edit_file", { path: "原型", old_text: "draft", content: "saved" }),
    tool("edit_file", { old_text: "原文", content: "修改" }),
    tool("read_file", {}),
    { text: "已完成" },
  ];
  const chat = await ask("创建 HTML 并更新原文");
  assert.deepEqual(
    chat.workspaceFiles.map((f) => [f.parent, f.title, f.html]),
    [["current", "原型", "saved"]],
  );
  assert.equal(chat.proposed, "<p>修改</p>");
  assert.match(lastMessages(), /修改/);
  assert.deepEqual(
    captures
      .at(-1)
      .tools.map((t) => t.function.name)
      .sort(),
    [
      "bash",
      "compact_context",
      "draw_canvas",
      "edit_file",
      "embed_view_screenshots",
      "list_file",
      "read_file",
      "read_resource",
      "skill_load",
      "write_file",
    ],
  );

  const skillMarker = "在叙页工作台的对话中";
  responses = [{ text: "你好！" }];
  const greeting = await ask("你好", { id: "greeting", messages: [] });
  assert.deepEqual(greeting.skillsUsed, []);
  assert.match(lastMessages(), /<available_skills>/);
  assert.ok(!lastMessages().includes(skillMarker));

  responses = [
    tool("read_resource", { path: "skills/prd-writing/SKILL.md" }),
    tool("skill_load", { name: "prd-writing" }),
    tool("read_resource", {
      path: "skills/prd-writing/references/prototype.md",
    }),
    { text: "说明完成" },
  ];
  const loaded = await ask("解释需求设计规范", {
    id: "auto-skill",
    messages: [],
  });
  assert.deepEqual(
    loaded.toolCalls.map((t) => t.status),
    ["failed", "done", "done"],
  );
  assert.deepEqual(loaded.skillsUsed, ["prd-writing"]);
  assert.ok(
    captures
      .at(-1)
      .messages.some(
        (m) =>
          m.role === "tool" && JSON.stringify(m.content).includes(skillMarker),
      ),
  );

  responses = [{ text: "已按要求评审" }];
  const explicit = await ask("/skill:prd-writing 评审现有正文", {
    id: "explicit-skill",
    messages: [],
  });
  assert.deepEqual(explicit.skillsUsed, ["prd-writing"]);
  assert.ok(!JSON.stringify(captures.at(-1).messages[0]).includes(skillMarker));
  assert.ok(JSON.stringify(captures.at(-1).messages[1]).includes(skillMarker));
  responses = [
    tool("bash", {
      command: "node -e 'process.stdout.write(String(6*7))' > result.txt",
    }),
    tool("bash", { command: "cat result.txt" }),
    tool("write_file", {
      type: "document",
      path: "计算结果",
      source: "result.txt",
    }),
    { text: "完成" },
  ];
  const shell = await ask("计算并保存结果");
  assert.deepEqual(
    shell.toolCalls.map((t) => t.status),
    ["done", "done", "done"],
  );
  assert.equal(shell.workspaceFiles[0].html, "42");
  // Real native Bash and pip. Only the model and remote image provider are fixtures.
  const {
    default: { CFB },
  } = await import("xlsx");
  const whl = CFB.utils.cfb_new();
  const packageName = "workbench_fixture";
  const dist = packageName + "-1.0.dist-info/";
  const wheelFiles = {
    [packageName + ".py"]: "caption = '海报说明'\n",
    [dist + "METADATA"]:
      "Metadata-Version: 2.1\nName: workbench-fixture\nVersion: 1.0\n",
    [dist + "WHEEL"]:
      "Wheel-Version: 1.0\nGenerator: fixture\nRoot-Is-Purelib: true\nTag: py3-none-any\n",
  };
  wheelFiles[dist + "RECORD"] = [...Object.keys(wheelFiles), dist + "RECORD"]
    .map((name) => name + ",,")
    .join("\n");
  for (const [name, data] of Object.entries(wheelFiles))
    CFB.utils.cfb_add(whl, name, Buffer.from(data));
  const wheel = CFB.write(whl, { type: "buffer", fileType: "zip" });
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jAp0AAAAASUVORK5CYII=";
  const key = "image-test-key-never-in-model";
  const requests = [];
  const imageApi = http.createServer((req, res) => {
    requests.push([
      req.method,
      req.url,
      req.headers.authorization === "Bearer " + key,
    ]);
    if (req.url === "/v1/wheel") return res.end(wheel);
    if (
      req.url === "/v1/images/generations" &&
      req.method === "POST" &&
      req.headers.authorization === "Bearer " + key
    )
      return res.end(JSON.stringify({ data: [{ b64_json: png }] }));
    res.writeHead(403);
    res.end();
  });
  await new Promise((resolve) => imageApi.listen(0, "127.0.0.1", resolve));
  t.after(() => imageApi.close());
  const drawScript = [
    "import workbench_fixture, json, os, urllib.request",
    "from pathlib import Path",
    "response = urllib.request.urlopen(os.environ['TASK_API_BASE_URL']+'/images/generations',data=b'{}')",
    "image = json.load(response)['data'][0]['b64_json']",
    `Path('poster.html').write_text('<p>'+workbench_fixture.caption+'</p><img src="data:image/png;base64,'+image+'"><table><tr><td>1</td></tr></table>')`,
  ].join("\n");
  responses = [
    tool("bash", {
      command: "cat > draw.py <<'PY'\n" + drawScript + "\nPY\npython3 draw.py",
    }),
    tool("bash", {
      command:
        'curl -fsS "$TASK_API_BASE_URL/wheel" -o workbench_fixture-1.0-py3-none-any.whl && python3 -m pip install --no-index ./workbench_fixture-1.0-py3-none-any.whl',
    }),
    tool("bash", { command: "python3 draw.py" }),
    tool("edit_file", { source: "poster.html", append: true }),
    tool("read_file", {}),
    { text: "图文已提交。" },
  ];
  const poster = await runAgent(
    context,
    {
      mode: "chat",
      question: "在文档中追加海报和表格",
      externalApi: {
        base: "http://127.0.0.1:" + imageApi.address().port + "/v1",
        key,
      },
    },
    model,
  );
  assert.deepEqual(
    poster.toolCalls.map((t) => t.status),
    ["failed", "done", "done", "done", "done"],
  );
  assert.match(poster.toolCalls[0].output, /ModuleNotFoundError/);
  assert.deepEqual(requests, [
    ["GET", "/v1/wheel", true],
    ["POST", "/v1/images/generations", true],
  ]);
  assert.equal(
    poster.proposed,
    '<p>原文</p><p>海报说明</p><img src="data:image/png;base64,' +
      png +
      '"><table><tr><td>1</td></tr></table>',
  );
  assert.ok(!lastMessages().includes(key));
  assert.ok(!JSON.stringify(poster).includes(key));

  const { discoverSkills, removeSkill, installSkill, skillPackage } =
    await import("../skills.mjs");
  const pkg = skillPackage("prd-writing");
  removeSkill({ name: "prd-writing" });
  assert.ok(!discoverSkills().skills.has("prd-writing"));
  responses = [{ text: "你好" }];
  await ask("你好", { id: "no-skills", messages: [] });
  assert.doesNotMatch(lastMessages(), /skills\/prd-writing/);
  installSkill({
    name: "prd-writing",
    files: pkg.map((f) => ({
      path: f.path,
      data: (f.path === "SKILL.md"
        ? Buffer.from(
            "---\nname: prd-writing\ndescription: 独立写作\n---\n只写一份备忘文档。",
          )
        : f.data
      ).toString("base64"),
    })),
  });
  responses = [
    tool("write_file", { path: "备忘", type: "document", content: "单篇" }),
    { text: "完成" },
  ];
  const replaced = await ask("/skill:prd-writing 写一份备忘文档", {
    id: "replacement",
    messages: [],
  });
  assert.match(lastMessages(), /只写一份备忘文档/);
  assert.deepEqual(
    replaced.workspaceFiles.map((f) => f.html),
    ["单篇"],
  );
  removeSkill({ name: "prd-writing" });
  assert.ok(!discoverSkills().skills.has("prd-writing"));
  const { uploadAttachment } = await import("../attachments.mjs");
  const { Readable } = await import("node:stream");
  const upload = Readable.from([Buffer.from(png, "base64")]);
  upload.headers = { "content-type": "image/png" };
  const imageRef = await uploadAttachment(upload, "截图.png");
  assert.equal(imageRef.kind, "image");
  responses = [{ text: "已收到图片" }];
  await runAgent(
    { ...context, session: { id: "vision", messages: [] } },
    { mode: "chat", question: "描述这张图", refs: [imageRef] },
    model,
  );
  const parts = captures
    .at(-1)
    .messages.findLast((m) => m.role === "user").content;
  assert.match(parts.find((p) => p.type === "text").text, /描述这张图/);
  assert.deepEqual(
    parts.filter((p) => p.type === "image_url").map((p) => p.image_url.url),
    ["data:image/png;base64," + png],
  );
  const external = {
    id: "other",
    type: "文档",
    title: "说明 B",
    html: "<p>旧说明</p>",
  };
  responses = [
    tool("read_file", { path: "/说明 B" }),
    tool("edit_file", { id: "other", old_text: "旧说明", content: "新说明" }),
    tool("write_file", {
      parent_id: "other",
      path: "页面 C",
      type: "html",
      content: "<button>确认</button>",
    }),
    tool("read_file", { path: "/说明 B/页面 C" }),
    { text: "完成" },
  ];
  const otherResult = await runAgent(
    { ...context, docs: [doc, external] },
    { mode: "chat", question: "读取 B、更新说明，并在 B 下创建 HTML" },
    model,
  );
  assert.equal(otherResult.proposed, null);
  assert.deepEqual(
    otherResult.workspaceChanges.map((c) => [c.id, c.base.html, c.html]),
    [["other", "<p>旧说明</p>", "<p>新说明</p>"]],
  );
  assert.equal(otherResult.workspaceFiles[0].parent, external.id);
  assert.match(lastMessages(), /旧说明/);
  assert.match(lastMessages(), /<button>确认/);
  const oldBoard = {
    id: "old",
    title: "原画布",
    type: "画布",
    scene: [{ id: "start", type: "rectangle", version: 2, versionNonce: 4 }],
  };
  const folder = { id: "folder", title: "项目", type: "文件夹" };
  const source = {
    ...doc,
    parent: folder.id,
    type: "交互 HTML",
    html: "<button>操作</button>",
  };
  const workspace = { doc: source, docs: [source, folder, oldBoard], rule: "" };
  const state = { id: "start", type: "rectangle", text: "待处理" };
  responses = [
    tool("draw_canvas", { elements: [state] }),
    tool("write_file", { type: "canvas", path: "流程 B" }),
    tool("draw_canvas", {
      path: "流程 B",
      elements: [state, { ...state, id: "end", text: "已完成" }],
    }),
    tool("draw_canvas", {
      path: "/项目/根/流程 B",
      elements: [{ id: "arrow", type: "arrow", from: "start", to: "end" }],
    }),
    tool("draw_canvas", {
      id: "old",
      elements: [{ ...state, text: "已有画布的修改" }],
    }),
    { text: "完成" },
  ];
  const before = captures.length;
  const cross = await runAgent(
    workspace,
    { mode: "chat", question: "在当前文件下创建画布，并修改原画布" },
    model,
  );
  assert.match(JSON.stringify(captures[before].messages), /项目\/根/);
  assert.match(JSON.stringify(captures[before].messages), /<button>操作/);
  assert.equal(cross.toolCalls[0].status, "failed");
  assert.equal(cross.workspaceFiles[0].parent, source.id);
  assert.deepEqual(
    cross.workspaceFiles[0].drawing.elements.map((e) => e.id),
    ["start", "end", "arrow"],
  );
  assert.deepEqual(
    cross.workspaceChanges.map((c) => [
      c.id,
      c.base.scene,
      c.drawing.elements[0].text,
    ]),
    [["old", '[["start",2,4]]', "已有画布的修改"]],
  );
  assert.equal(cross.canvasPatch, undefined);
  assert.equal(cross.proposed, null);
  responses = [tool("draw_canvas", { elements: [state] }), { text: "完成" }];
  const local = await runAgent(
    { ...workspace, doc: oldBoard },
    { mode: "chat", question: "更新本画布" },
    model,
  );
  assert.equal(local.canvasPatch.elements[0].text, state.text);
  assert.equal(local.workspaceChanges, undefined);
  assert.match(lastMessages(), /原画布/);
  const progress = [];
  responses = [
    ...Array.from({ length: 44 }, () => tool("read_file", {})),
    { text: "已核对" },
  ];
  const continued = await runAgent(
    { ...context, session: { id: "live-continuation", messages: [] } },
    { mode: "chat", question: "核对当前文件" },
    model,
    { progress: (event) => progress.push(event.label) },
  );
  assert.equal(continued.answer, "已核对");
  assert.equal(
    captures.at(-1).messages.filter((m) => m.role === "tool").length,
    44,
  );
  const toolStart = progress.indexOf("正在执行 read_file");
  const toolEnd = progress.indexOf("read_file 完成");
  assert.ok(toolStart >= 0 && toolEnd > toolStart);
  assert.ok(!progress.some((label) => label.includes("轮工具调用达到上限")));
  const { agentHistory } = await import("../agent-history.mjs");
  // Each runAgent opens a fresh Harness. Resume twice, then steer the stopped
  // request with a real pi.user and read a Bash file left by the first run.
  const interrupted = {
    ...context,
    session: { id: "pause-test", messages: [] },
  };
  const requestId = randomUUID();
  async function pauseAfter(steps, params) {
    let reached;
    const waiting = new Promise((resolve) => {
      reached = resolve;
    });
    responses = [...steps, { hold: reached }];
    const attemptId = randomUUID();
    const running = runAgent(
      interrupted,
      { question: "修改原文", requestId, ...params, attemptId },
      model,
    );
    await Promise.race([
      waiting,
      running.then(() => {
        throw Error("run exited before model hold");
      }),
    ]);
    await assert.rejects(
      () => pauseAgent(doc.id, "wrong-session", attemptId),
      /已结束/,
    );
    assert.equal(
      (await pauseAgent(doc.id, "pause-test", attemptId)).status,
      "paused",
    );
    assert.equal((await running).status, "paused");
  }
  await pauseAfter(
    [
      tool("edit_file", { old_text: "原文", content: "草稿" }),
      tool("write_file", {
        path: "旁注",
        type: "document",
        content: "旁注内容",
      }),
      tool("bash", { command: "echo 已核对 > note.txt" }),
    ],
    {},
  );
  assert.equal(agentHistory(doc.id, "pause-test").turns[0].control, "paused");
  await pauseAfter([tool("read_file", {})], { resumeFrom: requestId });
  assert.match(lastMessages(), /草稿/);
  assert.equal(
    captures.at(-1).messages.filter((m) => m.role === "user").length,
    1,
  );
  await assert.rejects(
    () =>
      runAgent(
        interrupted,
        { question: "过期按钮", resumeFrom: randomUUID() },
        model,
      ),
    /暂停状态/,
  );
  responses = [
    tool("edit_file", { path: "旁注", source: "note.txt" }),
    { text: "按补充要求修改完成" },
  ];
  const finished = await runAgent(
    interrupted,
    {
      requestId: randomUUID(),
      resumeFrom: requestId,
      question: "把核对结果写到旁注",
    },
    model,
  );
  assert.equal(finished.proposed, "<p>草稿</p>");
  assert.equal(finished.workspaceFiles.length, 1);
  assert.equal(finished.workspaceFiles[0].html.trim(), "已核对");
  assert.equal(
    captures.at(-1).messages.filter((m) => m.role === "user").length,
    2,
  );
  const pausedTurns = agentHistory(doc.id, "pause-test").turns;
  assert.equal(pausedTurns.length, 2);
  assert.equal(pausedTurns[0].control, "followed");
  assert.equal(pausedTurns[1].status, "done");
  const firstGeneration = randomUUID();
  await pauseAfter([], { requestId: firstGeneration });
  responses = [{ text: "第一次推理也可以恢复" }];
  assert.equal(
    (
      await runAgent(
        interrupted,
        { requestId: firstGeneration, resumeFrom: firstGeneration },
        model,
      )
    ).answer,
    "第一次推理也可以恢复",
  );
  const shellRequest = randomUUID();
  let runningShell;
  const shellStarted = new Promise((resolve) => {
    runningShell = resolve;
  });
  responses = [tool("bash", { command: "exec sleep 20" })];
  const shellRun = runAgent(
    interrupted,
    { requestId: shellRequest, question: "稍候" },
    model,
    {
      progress(event) {
        if (event.label === "正在执行 bash") runningShell();
      },
    },
  );
  await Promise.race([
    shellStarted,
    shellRun.then(() => {
      throw Error("shell did not start");
    }),
  ]);
  await pauseAgent(doc.id, "pause-test", shellRequest);
  assert.equal((await shellRun).status, "paused");
  responses = [{ text: "已接续" }];
  assert.equal(
    (
      await runAgent(
        interrupted,
        { requestId: shellRequest, resumeFrom: shellRequest },
        model,
      )
    ).answer,
    "已接续",
  );
  assert.equal(
    agentHistory(doc.id, "pause-test").turns.at(-1).toolCalls.length,
    1,
  );
  const savedTrace = agentHistory(doc.id, "live-continuation").turns[0];
  assert.equal(savedTrace.toolCalls.length, 44);
  assert.equal(savedTrace.submissions.length, 1);
  assert.equal(savedTrace.answerEntry, continued.answerEntry);
  const firstTool = agentHistory(
    doc.id,
    "live-continuation",
    savedTrace.toolCalls[0].key,
  );
  assert.deepEqual(firstTool.input, {});
  assert.match(firstTool.result[0], /原文/);
  assert.equal(firstTool.status, "done");
  const draftHtml = { ...doc, type: "交互 HTML", html: "<button>旧</button>" };
  responses = [
    tool("bash", { command: "echo '<button>新</button>' > current.html" }),
    { text: "请查看修改" },
  ];
  const drafted = await runAgent(
    {
      doc: draftHtml,
      docs: [draftHtml],
      session: { id: "shell-draft", messages: [] },
    },
    { mode: "chat", question: "修改按钮" },
    model,
  );
  assert.equal(drafted.proposed.trim(), "<button>新</button>");
  responses = [tool("bash", { command: "exit 3" })];
  await assert.rejects(() =>
    ask("检查命令", { id: "failed-trace", messages: [] }),
  );
  const failed = agentHistory(doc.id, "failed-trace").turns[0];
  assert.equal(failed.q, "检查命令");
  assert.equal(failed.status, "unanswered");
  assert.equal(failed.toolCalls[0].status, "failed");
  assert.match(
    agentHistory(doc.id, "failed-trace", failed.toolCalls[0].key).result.join(
      " ",
    ),
    /code 3/,
  );
  const pictured = {
    ...doc,
    html: ('<img src="data:image/png;base64,' + png + '">').repeat(5),
  };
  responses = [
    tool("read_resource", { path: "xuye-asset-5" }),
    { text: "已查看第五张图" },
  ];
  const pictureResult = await runAgent(
    {
      doc: pictured,
      docs: [pictured],
      session: { id: "doc-images", messages: [] },
    },
    { mode: "chat", question: "看第五张图" },
    model,
  );
  assert.equal(pictureResult.toolCalls[0].status, "done");
  const photo = agentHistory(doc.id, "doc-images").turns[0].toolCalls[0];
  assert.equal(
    agentHistory(doc.id, "doc-images", photo.key).result.find(
      (p) => p.type === "image",
    ).data,
    png,
  );
  responses = [{ text: "前半", reason: "length" }, { text: "后半" }];
  assert.equal((await ask("介绍一下")).answer, "前半后半");
  responses = [badCall, badCall, badCall];
  await assert.rejects(() => ask("创建文件"), /自动续写后仍未完成/);
  for (const manual of [false, true]) {
    const session = { id: "compaction-" + manual, messages: [] };
    responses = [{ text: "历史已记录" }];
    const seed = await ask("记住目标", session);
    session.conversationId = seed.conversationId;
    session.messages.push({
      q: "记住目标",
      answer: seed.answer,
      answerEntry: seed.answerEntry,
    });
    responses = [
      manual
        ? tool("compact_context", { focus: "保留测试目标" })
        : { overflow: true },
      { text: "SUMMARY_CHECKPOINT" },
      { text: "继续完成" },
    ];
    const completed = await ask("总结材料 " + "record ".repeat(18000), session);
    assert.equal(completed.answer, "继续完成");
    assert.ok(completed.compactions > 0);
    assert.match(lastMessages(), /SUMMARY_CHECKPOINT/);
    if (manual) assert.match(lastMessages(), /较早对话已压缩/);
    assert.equal(responses.length, 0);
  }
});
