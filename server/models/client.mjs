import { fault } from "../storage.mjs";

export async function complete(p, messages, max_tokens = 100, signal) {
  let r;
  try {
    r = await fetch(p.base + "/chat/completions", {
      method: "POST",
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + p.secret,
      },
      body: JSON.stringify({
        model: p.model,
        messages,
        max_tokens,
        ...(new URL(p.base).hostname === "api.deepseek.com"
          ? { thinking: { type: "disabled" } }
          : {}),
      }),
    });
  } catch {
    fault("未能连接模型接口，请检查地址、网络及超时设置", 502);
  }
  if (!r.ok)
    fault("模型接口返回 HTTP " + r.status + "，请核对密钥、模型和余额", 502);
  const message = (await r.json()).choices?.[0]?.message;
  if (
    !message ||
    typeof message.content !== "string" ||
    !message.content.trim()
  )
    fault("模型没有返回可用文本", 502);
  return message.content;
}

export async function discoverModels({ base, secret }) {
  let response;
  try {
    response = await fetch(base + "/models", {
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: { authorization: "Bearer " + secret },
    });
  } catch {
    fault("无法获取模型列表，可以手动填写模型名称", 502);
  }
  if (!response.ok)
    fault(
      "模型列表接口返回 HTTP " + response.status + "，可以手动填写模型名称",
      502,
    );
  const payload = await response.json().catch(() => null);
  const names = Array.isArray(payload?.data)
    ? payload.data
        .map((m) => m?.id)
        .filter((m) => typeof m === "string" && m.length && m.length <= 200)
    : [];
  if (!names.length) fault("接口没有返回模型名称，可以手动填写", 502);
  return [...new Set(names)].sort();
}
