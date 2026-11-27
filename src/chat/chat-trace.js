import { api } from "../service";

function endpoint(file, session) {
  return (
    "agent/history?" + new URLSearchParams({ doc: file.id, chatId: session.id })
  );
}
export const readTurns = async (file, session) =>
  (await api(endpoint(file, session))).turns;
export function findTurn(turns, msg) {
  return turns.findLast(
    (t) =>
      (msg.userEntry && msg.userEntry === t.entry) ||
      (msg.requestId && msg.requestId === t.requestId) ||
      (msg.answerEntry &&
        (t.answerEntry === msg.answerEntry ||
          t.lastAssistant === msg.answerEntry)),
  );
}

function outputBlock(row, label, value) {
  const heading = document.createElement("strong"),
    block = document.createElement("pre");
  heading.textContent = label;
  block.textContent =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  row.append(heading, block);
}
export function tracePanel(file, session, turn, legacy, live) {
  const panel = document.createElement("details"),
    summary = document.createElement("summary");
  panel.className = "chatToolCalls";
  panel.append(summary);
  const rows = new Map();
  const attempts = document.createElement("small");
  panel.append(attempts);
  let calls = turn?.toolCalls || legacy || [];
  function render(next) {
    if (next) {
      turn = next;
      calls = next.toolCalls;
    }
    summary.textContent = "执行记录 · " + calls.length + " 次工具调用";
    attempts.textContent = (turn?.submissions || [])
      .map(
        (s) =>
          "提交 #" +
          s.id +
          " · " +
          (s.reason ||
            {
              done: "完成",
              running: "运行中",
              placed: "已接收",
              unanswered: "未完成",
            }[s.status] ||
            s.status),
      )
      .join("　");
    for (const [i, call] of calls.entries()) {
      const key = call.key || i;
      let row = rows.get(key);
      if (!row) {
        row = document.createElement("details");
        row.className = "toolTraceRow";
        row.append(document.createElement("summary"));
        rows.set(key, row);
        panel.append(row);
        row.ontoggle = async () => {
          if (!row.open || row.dataset.loaded || row.dataset.loading) return;
          row.dataset.loading = "1";
          try {
            const record = call.key
              ? await api(
                  endpoint(file, session) +
                    "&tool=" +
                    encodeURIComponent(call.key),
                )
              : null;
            row.querySelectorAll("strong,pre,img").forEach((el) => el.remove());
            outputBlock(
              row,
              "输入",
              record
                ? record.input
                : call.command || call.path || "旧记录未保存参数",
            );
            if (record?.result) {
              outputBlock(
                row,
                "返回",
                record.result
                  .map((v) =>
                    typeof v === "string" ? v : v.mimeType || v.type,
                  )
                  .join("\n"),
              );
              for (const part of record.result.filter(
                (v) => v?.type === "image" && v.data,
              )) {
                const img = document.createElement("img");
                img.alt = "工具返回的图片";
                img.loading = "lazy";
                img.src = "data:" + part.mimeType + ";base64," + part.data;
                row.append(img);
              }
            } else
              outputBlock(
                row,
                "返回",
                call.error ||
                  call.output ||
                  (row.dataset.status === "interrupted"
                    ? "工具已中断，未写入返回结果"
                    : record
                      ? "等待工具返回"
                      : "旧记录未保存返回内容"),
              );
            if (!record || record.status !== "pending")
              row.dataset.loaded = "1";
          } catch (e) {
            outputBlock(row, "读取记录失败", e.message);
          } finally {
            delete row.dataset.loading;
          }
        };
      }
      row.firstChild.textContent =
        call.name +
        " · " +
        {
          done: "成功",
          failed: "失败",
          running: "执行中",
          interrupted: "已中断",
        }[call.status] +
        (call.duration != null
          ? " · " + (call.duration / 1000).toFixed(1) + " 秒"
          : "");
      if (
        row.open &&
        row.dataset.status !== call.status &&
        call.status !== "running"
      )
        row.ontoggle();
      row.dataset.status = call.status;
    }
  }
  render(turn);
  if (live) {
    let timer;
    async function refresh() {
      if (!panel.open || !panel.isConnected) return;
      try {
        render(findTurn(await readTurns(file, session), live));
      } catch {}
      if (panel.isConnected && panel.open) timer = setTimeout(refresh, 1500);
    }
    panel.ontoggle = () => {
      clearTimeout(timer);
      if (panel.open) refresh();
    };
  }
  return panel;
}
