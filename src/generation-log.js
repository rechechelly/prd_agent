import { $, dialog, esc } from "./shared";
import { api } from "./service";

const stages = {
  model_config: "读取模型配置",
  agent: "Agent 生成文件",
  screenshots: "Chromium 截图",
  delivery: "服务端交付完成",
};
const states = {
  running: "进行中",
  done: "完成",
  failed: "失败",
  interrupted: "已中断",
};
const duration = (ms) => (ms / 1000).toFixed(1) + " 秒";

export function openGenerationLog(doc, restore) {
  dialog(
    "生成记录 · " + doc.title,
    '<button type="button" id="refreshRuns" class="outline">刷新记录</button><div id="generationLog" aria-live="polite"></div>',
    () => {},
    "关闭",
  );
  const list = $("generationLog");
  const refreshButton = $("refreshRuns");
  async function refresh() {
    refreshButton.disabled = true;
    try {
      const { runs } = await api(
        "generation-runs?doc=" + encodeURIComponent(doc.id),
      );
      if (!runs.length) {
        list.textContent = "这篇文档还没有新的生成记录。";
        return;
      }
      list.innerHTML = runs.map(renderRun).join("");
      runs.forEach((run, i) => {
        if (!run.recoverable) return;
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = "恢复生成文件到目录";
        list.children[i].append(button);
        button.onclick = async () => {
          button.disabled = true;
          try {
            await restore(
              await api(
                "pending-delivery?doc=" +
                  encodeURIComponent(doc.id) +
                  "&run=" +
                  encodeURIComponent(run.id),
              ),
            );
            await refresh();
          } catch (e) {
            button.textContent = e.message;
            button.disabled = false;
          }
        };
      });
    } catch (error) {
      list.textContent = error.message;
    } finally {
      refreshButton.disabled = false;
    }
  }
  refreshButton.onclick = refresh;
  refresh();
}

function renderRun(run, index) {
  const summary =
    new Date(run.started).toLocaleString("zh-CN") +
    " · " +
    states[run.status] +
    " · " +
    stages[run.stage];
  const details = [];
  if (run.model) details.push(run.model);
  if (run.compactions) details.push("上下文压缩 " + run.compactions + " 次");
  if (run.finished) details.push(duration(run.finished - run.started));
  if (run.roundLimit)
    details.push("工具轮次 " + (run.rounds ?? 0) + " / " + run.roundLimit);
  if (run.continuations)
    details.push(
      run.continueReason + "，已自动续写 " + run.continuations + " 次",
    );
  for (const part of run.parts || [])
    if (part.complete) details.push(part.file + " 已写入");
    else if (part.bytes)
      details.push(part.file + " 已写 " + part.bytes + " 字节");
  if (run.agentResult) details.push("Pi 状态 " + run.agentResult);
  if (run.submission != null) details.push("Pi 提交 " + run.submission);
  if (run.error) details.push(run.error);
  if (run.httpStatus) details.push("HTTP " + run.httpStatus);
  if (run.screenshots)
    details.push(
      "截图 " + run.screenshots.captured + " / " + run.screenshots.total,
    );
  if (!run.parts && run.prototypeWritten != null)
    details.push(
      "原型" +
        (run.prototypeWritten ? "已写入" : "待写入") +
        "，PRD" +
        (run.prdWritten ? "已写入" : "待写入"),
    );
  const tools = run.tools.map((tool) => {
    const info = [tool.name, states[tool.status]];
    if (tool.exitCode != null) info.push("退出码 " + tool.exitCode);
    if (tool.unavailable) info.push(tool.unavailable + " 不可用");
    if (tool.duration != null) info.push(duration(tool.duration));
    return "<li>" + info.map(esc).join(" · ") + "</li>";
  });
  return (
    "<details" +
    (index === 0 ? " open" : "") +
    "><summary>" +
    esc(summary) +
    "</summary><p>" +
    details.map(esc).join(" · ") +
    "</p>" +
    (tools.length ? "<ol>" + tools.join("") + "</ol>" : "") +
    "</details>"
  );
}
