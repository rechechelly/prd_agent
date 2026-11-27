import { hook, ToolTask } from "@earendil-works/pi-durable";

// Preserve the JSON endpoint for existing callers. The chat UI negotiates NDJSON.
export function agentStream(res) {
  const controller = new AbortController();
  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-store, no-transform",
    "X-Accel-Buffering": "no",
  });
  function emit(type, data) {
    if (!res.destroyed && !res.writableEnded)
      res.write(JSON.stringify({ type, data }) + "\n");
  }
  const timer = setInterval(() => emit("heartbeat"), 5000);
  res.once("close", () => {
    clearInterval(timer);
    if (!res.writableEnded) controller.abort();
  });
  const progress = (data) => emit("progress", data);
  progress({ label: "正在准备文档和附件" });
  return {
    progress,
    signal: controller.signal,
    end(type, data) {
      clearInterval(timer);
      emit(type, data);
      res.end();
    },
  };
}

export function diagnostic(value) {
  return String(value || "")
    .replace(/Bearer\s+\S+|(?:sk-|sk_)[\w.-]{8,}/gi, "[已隐藏]")
    .replace(/https?:\/\/[^\s"']+/gi, "[接口地址]")
    .replace(
      /(api[_-]?key|token|password|authorization)(["'\s]*[:=]\s*["']?)[^"',\s}]+/gi,
      "$1$2[已隐藏]",
    )
    .replace(/[A-Za-z0-9+/=]{60,}/g, "…")
    .slice(0, 300);
}

// These summaries drive live UI. Call arguments, results and submission state
// remain in Pi's transcript, including failures before execute() was reached.
export function toolProgress(calls, progress) {
  const active = new Map(calls.filter(c => c.status === "running" && c.taskId != null).map(c => [c.taskId, c]));
  function eventFor(call, taskId) {
    let event = active.get(taskId);
    if (!event) {
      event = { taskId, name: call.name, at: Date.now(), status: "running" };
      if (typeof call.arguments?.path === "string") event.path = diagnostic(call.arguments.path);
      active.set(taskId, event);
      calls.push(event);
    }
    return event;
  }
  return hook(ToolTask, {
    beforeTool(call, api) {
      const event = eventFor(call, api.taskId);
      progress?.({ label: "正在执行 " + event.name + (event.path ? " · " + event.path : ""), tool: true });
    },
    afterTool(call, result, api) {
      const event = eventFor(call, api.taskId);
      event.duration = Date.now() - event.at;
      const interrupted = result.diagnostics?.some(d => ["aborted", "abandoned", "interrupted"].includes(d.code));
      event.status = interrupted ? "interrupted" : result.isError ? "failed" : "done";
      if (result.isError)
        event.error = diagnostic(result.diagnostics?.at(-1)?.message || result.output?.find(part => part.type === "text")?.text || "工具执行失败");
      const label = interrupted ? " 已中断" : event.error ? " 失败：" + event.error : " 完成";
      progress?.({ label: event.name + label, tool: true });
      active.delete(api.taskId);
    },
  });
}
