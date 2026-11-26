import fs from "node:fs";
import { chromium } from "playwright-core";
import { fault } from "./storage.mjs";
const policy =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
export function isolate(html) {
  const meta =
    '<meta http-equiv="Content-Security-Policy" content="' + policy + '">';
  return "<!doctype html>" + meta + html.replace(/<!doctype[^>]*>/gi, "");
}
export async function renderDelivery(raw, trace) {
  const executablePath =
    process.env.XUYE_CHROME ||
    [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/usr/bin/chromium",
      "/usr/bin/google-chrome",
      "/usr/bin/chromium-browser",
    ].find((f) => fs.existsSync(f));
  if (!executablePath)
    fault("未找到 Chromium，请在服务器配置 XUYE_CHROME", 503);
  const browser = await chromium.launch({
    executablePath,
    chromiumSandbox: process.platform === "linux",
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      LANG: "zh_CN.UTF-8",
    },
  });
  try {
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 850 },
      deviceScaleFactor: 2,
      offline: true,
      serviceWorkers: "block",
    });
    await ctx.route("**/*", (r) => r.abort());
    const prd = await ctx.newPage(),
      proto = await ctx.newPage();
    ctx.on("page", (p) => {
      if (p !== prd && p !== proto) p.close();
    });
    if (!raw.prd) {
      const html = isolate(raw.html);
      await proto.setContent(html, { timeout: 15000 });
      if (
        !(await proto
          .locator("body")
          .evaluate(
            (el) =>
              !!el.innerText.trim() ||
              !!el.querySelector("img,svg,canvas,input,button,iframe,video"),
          ))
      )
        fault("HTML 原型未渲染出可见内容", 422);
      return { html };
    }
    await prd.setContent(
      isolate(raw.prd.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")),
    );
    const slots = await prd
      .locator("img[data-prd-shot]")
      .evaluateAll((els) => els.map((el) => el.dataset.prdShot));
    if (!raw.html) {
      if (slots.length)
        fault(
          "独立 PRD 使用了尚无配套原型的截图标记，请改为已有图片或文字说明",
          422,
        );
      if (!(await prd.locator("body").innerText()).trim())
        fault("PRD 正文为空", 422);
      return { prd: await prd.content() };
    }
    if (
      !slots.length ||
      slots.length > 30 ||
      slots.some((s) => !/^[-\w]{1,80}$/.test(s))
    )
      fault("PRD 缺少有效截图标记，请重新生成", 422);
    const html = isolate(raw.html);
    const views = new Set(slots);
    let captured = 0;
    trace?.recordEvent({ screenshots: { captured, total: views.size } });
    for (const name of views) {
      await proto.goto("about:blank");
      await proto.setContent(html, { timeout: 15000 });
      try {
        await proto.evaluate(
          (n) =>
            Promise.race([
              Promise.resolve(window.showPrdView?.(n)),
              new Promise((_, reject) =>
                setTimeout(() => reject(Error("视图未就绪")), 5000),
              ),
            ]),
          name,
        );
      } catch (error) {
        const detail = error.message.split("\n")[0].slice(0, 180);
        fault("原型打开截图视图 " + name + " 失败：" + detail, 422);
      }
      const block = proto.locator('[data-prd-view="' + name + '"]').first();
      if (!(await block.count())) fault("原型找不到 PRD 对应区块 " + name, 422);
      const png = await block.screenshot({
        timeout: 6500,
        animations: "disabled",
      });
      await prd
        .locator('img[data-prd-shot="' + name + '"]')
        .evaluateAll(
          (els, src) => els.forEach((e) => (e.src = src)),
          "data:image/png;base64," + png.toString("base64"),
        );
      trace?.recordEvent({
        screenshots: { captured: ++captured, total: views.size },
      });
    }
    return { html, prd: await prd.content() };
  } finally {
    await browser.close();
  }
}
