import { $, toast } from "./shared";
export const online =
  location.protocol === "http:" || location.protocol === "https:";
export async function api(path, body, signal) {
  const res = await fetch(
    "./api/" + path,
    body === undefined
      ? {}
      : {
          signal,
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const data = await res.json();
  if (!res.ok) {
    if (res.status === 401 && path !== "login") location.reload();
    throw Object.assign(new Error(data.error || "请求失败"), {
      status: res.status,
    });
  }
  return data;
}
export async function streamChat(body, controller, onProgress) {
  const { signal } = controller;
  let timer;
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(
      () => controller.abort(Error("与工作台的进度连接已中断，请重新发送。")),
      45000,
    );
  };
  touch();
  try {
    const response = await fetch("./api/agent", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/x-ndjson",
      },
      body: JSON.stringify(body),
      signal,
    });
    if (
      !response.ok ||
      !response.headers.get("content-type")?.includes("application/x-ndjson")
    ) {
      const data = await response.json();
      if (!response.ok) throw Error(data.error || "请求失败");
      return data;
    }
    const reader = response.body.getReader(),
      decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) throw Error("进度连接已关闭，未收到最终结果。");
      touch();
      buffer += decoder.decode(value, { stream: true });
      let end;
      while ((end = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line) continue;
        const packet = JSON.parse(line);
        if (packet.type === "result") return packet.data;
        if (packet.type === "error") throw Error(packet.data.error);
        if (packet.type === "progress") onProgress(packet.data);
      }
    }
  } finally {
    clearTimeout(timer);
  }
}
let revision = 0,
  timer,
  pending,
  dirty = false,
  readState,
  conflict = false;
export async function boot(read, setModels) {
  if (!online) return;
  const data = await api("workspace");
  readState = read;
  revision = data.revision;
  setModels(data);
  $("saved").textContent = "已保存";
  $("logout").hidden = false;
  $("logout").onclick = async () => {
    try {
      await flush();
      await api("logout", {});
      location.reload();
    } catch (e) {
      toast(e.message);
    }
  };
  window.addEventListener("beforeunload", (e) => {
    if (dirty || pending) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
  return data.data;
}
export function changed() {
  if (!online || !readState) return;
  dirty = true;
  $("saved").textContent = "待保存";
  clearTimeout(timer);
  timer = setTimeout(() => flush().catch((e) => toast(e.message)), 600);
}
export async function flush() {
  if (!online || !readState) return;
  if (conflict) throw Error("另一个窗口已保存修改，请保留修改并刷新");
  clearTimeout(timer);
  if (pending) await pending;
  if (!dirty) return;
  dirty = false;
  const data = readState();
  pending = api("workspace", { revision, data })
    .then((r) => {
      revision = r.revision;
      $("saved").textContent = dirty ? "待保存" : "已保存";
    })
    .catch((e) => {
      dirty = true;
      conflict = e.status === 409;
      $("saved").textContent = "保存失败 · " + e.message;
      throw e;
    })
    .finally(() => (pending = null));
  await pending;
  if (dirty) await flush();
}
