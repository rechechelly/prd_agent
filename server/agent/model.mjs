import { createModels, createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { fault } from "../storage.mjs";
import { DEFAULT_CONTEXT_WINDOW } from "../../shared/chat-sessions.mjs";
export function runtimeModels(p, contextWindow = DEFAULT_CONTEXT_WINDOW) {
  const deepseek = new URL(p.base).hostname === "api.deepseek.com";
  const maxTokens = Number(process.env.XUYE_MAX_OUTPUT_TOKENS ?? 32768);
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens >= 128000)
    fault("XUYE_MAX_OUTPUT_TOKENS 必须是 1 至 127999 的整数", 500);
  const models = createModels(),
    model = {
      id: p.model,
      name: p.model,
      provider: "workspace",
      baseUrl: p.base,
      api: "openai-completions",
      reasoning: deepseek,
      ...(deepseek && { compat: { thinkingFormat: "deepseek" } }),
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow,
      maxTokens,
    };
  models.setProvider(
    createProvider({
      id: "workspace",
      name: p.name,
      baseUrl: p.base,
      models: [model],
      api: openAICompletionsApi(),
      auth: {
        apiKey: {
          name: p.name,
          resolve: async () => ({ auth: { apiKey: p.secret } }),
        },
      },
    }),
  );
  return { models, deepseek };
}
