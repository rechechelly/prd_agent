import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("provider migration, independent model routing, key rotation and removal", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "xuye-models-"));
  process.env.XUYE_DATA = data;
  const { db, seal, set } = await import("../storage.mjs");
  const servers = [];
  t.after(async () => {
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    db.close();
    await rm(data, { recursive: true, force: true });
  });
  const calls = [];
  async function endpoint(name) {
    const server = http.createServer(async (req, res) => {
      const body = [];
      for await (const chunk of req) body.push(chunk);
      const input = JSON.parse(Buffer.concat(body).toString() || "{}");
      calls.push({
        name,
        key: req.headers.authorization,
        model: input.model,
        path: req.url,
      });
      if (input.stream) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        for (const [delta, finish_reason] of [
          [{ role: "assistant", content: "hello" }, null],
          [{}, "stop"],
        ]) {
          res.write(
            "data: " +
              JSON.stringify({
                id: "turn",
                model: input.model,
                object: "chat.completion.chunk",
                choices: [{ index: 0, delta, finish_reason }],
              }) +
              "\n\n",
          );
        }
        res.end("data: [DONE]\n\n");
      } else {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify(
            req.url.endsWith("/models")
              ? { data: [{ id: "shared" }] }
              : { choices: [{ message: { content: "next" } }] },
          ),
        );
      }
    });
    await new Promise((resolve, reject) =>
      server.once("error", reject).listen(0, "127.0.0.1", resolve),
    );
    servers.push(server);
    return "http://127.0.0.1:" + server.address().port + "/v1";
  }
  const a = await endpoint("first"),
    b = await endpoint("second");
  db.exec(
    "CREATE TABLE profiles(id TEXT PRIMARY KEY,name TEXT,base TEXT,model TEXT,secret TEXT)",
  );
  const insert = db.prepare("INSERT INTO profiles VALUES(?,?,?,?,?)");
  insert.run("a", "First", a + "/", "shared", seal("first-test"));
  insert.run("a2", "First", a, "other", seal("first-test"));
  set("active", "a2");
  const { modelRoute } = await import("../models/routes.mjs");
  const { profiles, modelConfig } = await import("../models/providers.mjs");
  const post = (route, data) =>
    modelRoute("/api/" + route, "POST", async () => data);
  assert.equal(profiles().providers.length, 1);
  assert.deepEqual(profiles().selections, { agent: "a2", completion: "a2" });
  const added = await post("providers/save", {
    name: "Second",
    base: b,
    apiKey: "second-test",
    models: ["shared"],
  });
  const second = added.providers.find((p) => p.id === added.savedProviderId);
  assert(!JSON.stringify(added).includes("second-test"));
  await post("models/switch", { id: second.models[0].id, scope: "agent" });
  assert.equal(profiles().selections.completion, "a2");
  assert.deepEqual(
    await post("providers/discover", { id: second.id, base: b }),
    { models: ["shared"] },
  );
  const { complete } = await import("../models/client.mjs");
  const { completionMessages } = await import("../agent/prompts.mjs");
  assert.equal(
    await complete(
      modelConfig("completion"),
      completionMessages("Example", "hello"),
      160,
    ),
    "next",
  );
  const { runAgent } = await import("../agent.mjs");
  const doc = {
    id: "doc",
    title: "Example",
    html: "<p>Test</p>",
    type: "文档",
  };
  assert.equal(
    (
      await runAgent(
        { doc, docs: [doc] },
        { mode: "chat", question: "你好" },
        modelConfig("agent"),
      )
    ).answer,
    "hello",
  );
  assert.deepEqual(
    calls.map((c) => [c.name, c.key, c.model, c.path]),
    [
      ["second", "Bearer second-test", undefined, "/v1/models"],
      ["first", "Bearer first-test", "other", "/v1/chat/completions"],
      ["second", "Bearer second-test", "shared", "/v1/chat/completions"],
    ],
  );
  await assert.rejects(
    post("providers/discover", { id: second.id, base: a }),
    /API Key/,
  );
  await post("providers/save", {
    id: second.id,
    name: "Second",
    base: b,
    apiKey: "rotated-test",
    models: ["shared", "new"],
  });
  assert.equal(modelConfig("agent").secret, "rotated-test");
  await post("providers/delete", { id: second.id });
  assert.throws(() => modelConfig("agent", second.models[0].id), /已移除/);
  const empty = await post("providers/delete", {
    id: profiles().providers[0].id,
  });
  assert.deepEqual(empty.selections, { agent: null, completion: null });
  assert.throws(() => modelConfig("completion"), /添加模型/);
});
