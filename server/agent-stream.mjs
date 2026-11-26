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
