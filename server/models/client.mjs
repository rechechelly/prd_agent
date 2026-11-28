import { fault } from "../storage.mjs";

export async function complete(p, messages, max_tokens = 100, signal, { json = false } = {}) {
  let r;
  const host = new URL(p.base).hostname;
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
        ...(json && ["api.deepseek.com", "api.openai.com"].includes(host)
          ? { response_format: { type: "json_object" } } : {}),
        ...(host === "api.deepseek.com"
          ? { thinking: { type: "disabled" } }
          : {}),
      }),
    });
  } catch {
    signal?.throwIfAborted();
    fault("未能连接模型接口，请检查地址、网络及超时设置", 502);
  }
  if (!r.ok)
    fault("模型接口返回 HTTP " + r.status + "，请核对密钥、模型和余额", 502);
  const choice = (await r.json()).choices?.[0];
  const message = choice?.message;
  if (
    !message ||
    typeof message.content !== "string" ||
    !message.content.trim()
  )
    fault(choice?.finish_reason === "length" && json
      ? "补全模型已用尽单次输出预算，请切换模型后重试" : "模型没有返回可用文本", 502);
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
