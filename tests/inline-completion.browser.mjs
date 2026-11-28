import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const root = new URL("../", import.meta.url);
const { chromium } = createRequire(new URL("server/package.json", root))("playwright-core");
const local = "127.0.0.1";
const image = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";

async function listen(server) {
  server.listen(0, local);
  await once(server, "listening");
  return server.address().port;
}

// Run the actual HTTP route and provider client. Only the external model is substituted.
async function fixture(t) {
  const data = await mkdtemp(path.join(tmpdir(), "xuye-completion-"));
  const calls = [];
  let reply;
  const model = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const input = JSON.parse(body.messages.at(-1).content);
    calls.push({ input, tools: body.tools });
    const expected = reply;
    reply = undefined;
    if (!expected || req.url !== "/v1/chat/completions") {
      res.writeHead(500).end("Unexpected model request");
      return;
    }
    expected.received.resolve(input);
    await expected.gate;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(expected.output) } }] }));
  });
  let app, chrome;
  t.after(async () => {
    try {
      await chrome?.close();
      if (app && app.exitCode === null && app.signalCode === null) {
        const stopped = once(app, "exit");
        app.kill();
        await stopped;
      }
    } finally {
      model.closeAllConnections();
      if (model.listening) await new Promise(resolve => model.close(resolve));
      await rm(data, { recursive: true, force: true });
    }
  });

  const modelPort = await listen(model);
  const probe = createServer();
  const port = await listen(probe);
  await new Promise(resolve => probe.close(resolve));
  const origin = "http://" + local + ":" + port;
  app = spawn(process.execPath, ["server/index.mjs"], {
    cwd: root, stdio: ["ignore", "pipe", "inherit"],
    env: { PATH: process.env.PATH, HOST: local, PORT: String(port),
      XUYE_DATA: data, XUYE_ORIGIN: origin, XUYE_USERNAME: "qa", XUYE_PASSWORD: "local-fixture" },
  });
  await Promise.race([
    once(app.stdout, "data"),
    once(app, "exit").then(([code]) => { throw Error("Workspace exited with code " + code); }),
  ]);
  const executablePath = process.env.XUYE_CHROME || [chromium.executablePath(),
    "/usr/bin/chromium", "/usr/bin/chromium-browser"].find(file => existsSync(file));
  chrome = await chromium.launch(executablePath ? { executablePath } : { channel: "chrome" });
  const context = await chrome.newContext({ baseURL: origin });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  async function post(endpoint, input) {
    const res = await context.request.post("/api/" + endpoint, { data: input });
    assert.ok(res.ok(), await res.text());
  }
  await post("login", { username: "qa", password: "local-fixture" });
  await post("providers/save", { name: "Fixture", base: "http://" + local + ":" + modelPort + "/v1",
    apiKey: "local-fixture", models: ["completion"] });
  return { page, calls, post,
    expect(output, gate) {
      assert.equal(reply, undefined, "Previous expected model request was not received");
      const received = Promise.withResolvers();
      reply = { output, gate, received };
      return received.promise;
    },
    async saved(id) {
      await page.waitForFunction(() => document.querySelector("#saved").textContent === "已保存");
      const res = await context.request.get("/api/workspace/file", { params: { id } });
      assert.ok(res.ok(), await res.text());
      return (await res.json()).file.html;
    },
  };
}

async function caret(editor, text, offset) {
  // A highlighted source line can contain several DOM text nodes.
  await editor.evaluate((el, { text, offset }) => {
    el.focus();
    const start = el.textContent.indexOf(text);
    if (start < 0) throw Error("Missing caret anchor: " + text);
    const nodes = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let remaining = start + offset;
    for (let node = nodes.nextNode(); node; node = nodes.nextNode()) {
      if (remaining < node.length || (remaining === node.length && offset > 0)) {
        getSelection().collapse(node, remaining);
        return;
      }
      remaining -= node.length;
    }
    throw Error("Caret offset exceeds editor text");
  }, { text, offset });
}

test("Document and HTML inline completion in Chromium", { timeout: 60000 }, async t => {
  const { page, calls, post, expect, saved } = await fixture(t);
  const first = "现状：仅支持全额还款", second = "二、规则", last = "允许分期。";
  const doc = { id: randomUUID(), title: "含图片的说明", type: "文档",
    html: '<p>' + first + '</p><img src="' + image + '" alt="账单示意" width="20" height="15"><h2>' + second + '</h2><p>' + last + '</p>' };
  const source = { id: randomUUID(), title: "示例.html", type: "交互 HTML",
    html: "<!doctype html>\n<title\n<style>.item { color: greeen; } .item { display: block; }</style>" };
  await post("workspace", { revision: 0, data: { docs: [doc, source], folders: [], chats: [], completionEnabled: false } });
  const prose = page.getByRole("textbox", { name: "文档正文" });
  const code = page.locator("#htmlInput");
  const toggle = page.locator("#completionToggle");
  async function doubleTab() {
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
  }
  async function complete(output, trigger = doubleTab) {
    const modelInput = expect(output);
    const response = page.waitForResponse(r => r.url().endsWith("/api/agent") && r.request().method() === "POST");
    await trigger();
    const res = await response;
    assert.ok(res.ok(), await res.text());
    return { result: await res.json(), input: await modelInput, trigger: res.request().postDataJSON().trigger };
  }
  async function accept(editor) {
    const added = editor.locator(".completionAddition").first();
    await added.waitFor();
    await page.keyboard.press("Tab");
    await added.waitFor({ state: "detached" });
  }
  async function checkDocument(expected) {
    const html = await saved(doc.id);
    const nodes = await page.evaluate(html => {
      const body = new DOMParser().parseFromString(html, "text/html").body;
      const img = body.querySelector("img");
      return { blocks: [...body.children].map(el => [el.localName, el.textContent]),
        strong: body.querySelector("strong")?.textContent,
        image: ["src", "alt", "width", "height"].map(attr => img?.getAttribute(attr)) };
    }, html);
    assert.deepEqual(nodes.blocks, expected);
    assert.equal(nodes.strong, "变更点");
    assert.deepEqual(nodes.image, [image, "账单示意", "20", "15"]);
  }
  const beforeImage = [["p", first + "。"], ["p", "变更点：支持分期。"], ["img", ""], ["h2", second]];

  await t.test("manual Markdown at paragraph end before an image with auto off", async () => {
    await page.goto("/qa/" + doc.id);
    await prose.getByText(first, { exact: true }).waitFor();
    assert.equal(await toggle.getAttribute("aria-pressed"), "false");
    await caret(prose, first, first.length);
    await page.keyboard.insertText("。");
    // The workspace save debounce is longer than the autocomplete debounce.
    assert.ok((await saved(doc.id)).includes(first + "。"));
    assert.equal(calls.length, 0);
    const { input, trigger } = await complete({ insert: "\n\n**变更点**：支持分期。" });
    assert.equal(trigger, "manual");
    assert.ok(input.before.endsWith(first + "。"));
    assert.equal(input.after, "");
    assert.equal(input.boundary, "image");
    assert.ok(!JSON.stringify(input).includes(image));
    await accept(prose);
    await checkDocument([...beforeImage, ["p", last]]);
  });

  await t.test("reject a replacement across an image; distinguish no suggestion", async () => {
    await caret(prose, "支持分期。", "支持分期。".length);
    const before = await saved(doc.id);
    const { result } = await complete({ list: [{ old_text: second, new_text: "另一个标题" }] });
    assert.deepEqual(result.list, []);
    assert.match(result.reason, /匹配 0 处/);
    const empty = await complete({ insert: "" });
    assert.deepEqual(empty.result, { list: [] });
    assert.equal(await prose.locator(".completionAddition").count(), 0);
    assert.equal(await saved(doc.id), before);
  });

  await t.test("auto completion after the image; keep image data out of model input", async () => {
    await toggle.click();
    await caret(prose, last, last.length);
    const { input, trigger } = await complete({ insert: "每月核对。" }, () => page.keyboard.insertText("另："));
    assert.equal(trigger, "auto");
    assert.ok(input.before.includes("［图片］"));
    assert.ok(!JSON.stringify(input).includes(image));
    await accept(prose);
    await checkDocument([...beforeImage, ["p", last + "另：每月核对。"]]);
    await toggle.click();
    await saved(doc.id);
  });

  await t.test("paragraph start insertion and a mid-paragraph correction after Chinese IME commit", async () => {
    await prose.getByText(first + "。", { exact: true }).click();
    await page.keyboard.press("Home");
    const start = await complete({ insert: "1. 【旧版】" });
    assert.equal(start.input.cursorAt, "start", JSON.stringify(start.input));
    assert.equal(start.input.before, "");
    await accept(prose);
    assert.ok((await saved(doc.id)).includes("【旧版】" + first + "。"));

    await toggle.click();
    await prose.getByText("【旧版】" + first + "。", { exact: true }).click();
    await caret(prose, "全额还款", 0);
    const ime = await page.context().newCDPSession(page);
    try {
      const correction = await complete({ list: [{ old_text: "全额还款", new_text: "期还款" }] }, async () => {
        const count = calls.length;
        await ime.send("Input.imeSetComposition", { text: "an", selectionStart: 2, selectionEnd: 2 });
        await page.waitForTimeout(500); // Hold preedit beyond the automatic completion debounce.
        assert.equal(calls.length, count, "Uncommitted IME input must not trigger completion");
        await ime.send("Input.insertText", { text: "按" });
      });
      assert.equal(correction.trigger, "auto");
      assert.equal(correction.input.cursorAt, "middle");
      assert.ok(correction.input.before.endsWith("按"));
      assert.ok(correction.input.editableAfter.startsWith("全额还款。"));
      await accept(prose);
      await checkDocument([["p", "【旧版】现状：仅支持按期还款。"], ...beforeImage.slice(1), ["p", last + "另：每月核对。"]]);
    } finally {
      await ime.detach();
    }
    await toggle.click();
    await saved(doc.id);
  });

  let html = source.html;
  await t.test("complete an unfinished HTML tag at the caret in Raw Text", async () => {
    await page.goto("/qa/" + source.id);
    await page.locator("#sourceMode").click();
    await code.waitFor();
    await caret(code, "<title", 6);
    const { input, trigger } = await complete({ insert: ">测试</title>" });
    assert.equal(trigger, "manual");
    assert.equal(input.codeLanguage, "html");
    assert.ok(input.before.endsWith("<title"));
    assert.ok(input.after.startsWith("\n<style>"));
    await accept(code);
    html = html.replace("<title", "<title>测试</title>");
    assert.equal(await saved(source.id), html);
  });

  await t.test("insert at the start of the first source line and at the end of the file", async () => {
    await caret(code, "<!doctype", 0);
    const opening = "<!-- 示例 -->\n";
    const start = await complete({ insert: opening });
    assert.equal(start.input.cursorAt, "start");
    assert.equal(start.input.before, "");
    await accept(code);
    html = opening + html;
    assert.equal(await saved(source.id), html);

    await caret(code, "</style>", "</style>".length);
    const closing = "\n<main></main>";
    const end = await complete({ insert: closing });
    assert.equal(end.input.cursorAt, "end");
    assert.equal(end.input.atFileEnd, true);
    assert.equal(end.input.after, "");
    await accept(code);
    html += closing;
    assert.equal(await saved(source.id), html);
  });

  await t.test("reject a duplicate source anchor, then apply a unique correction after typing", async () => {
    await caret(code, ".item", 0);
    const bad = await complete({ list: [{ old_text: ".item", new_text: ".card" }] });
    assert.match(bad.result.reason, /匹配 2 处/);
    assert.equal(await saved(source.id), html);
    await toggle.click();
    await caret(code, "greeen", 0);
    const fix = await complete({ list: [{ old_text: "greeen", new_text: "green" }] }, () => page.keyboard.insertText(" "));
    assert.equal(fix.trigger, "auto");
    await accept(code);
    html = html.replace("greeen", " green");
    assert.equal(await saved(source.id), html);
  });

  await t.test("cancel an outstanding suggestion when the caret moves", async () => {
    await caret(code, "color", 2);
    const release = Promise.withResolvers();
    const arrived = expect({ insert: "STALE" }, release.promise);
    const cancelled = page.waitForEvent("requestfailed", req => req.url().endsWith("/api/agent"));
    try {
      await doubleTab();
      await arrived;
      await page.keyboard.press("ArrowRight");
      await cancelled;
    } finally {
      release.resolve();
    }
    assert.equal(await code.locator(".completionAddition").count(), 0);
    assert.equal(await saved(source.id), html);
  });
  assert.equal(calls.length, 12, "One provider call per trigger");
  assert.ok(calls.every(call => call.tools === undefined));
});
