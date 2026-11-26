import { complete, discoverModels } from "./client.mjs";
import {
  deleteProvider,
  legacyConnection,
  profiles,
  providerConnection,
  saveLegacy,
  saveProvider,
  selectModel,
} from "./providers.mjs";
import { fault } from "../storage.mjs";

export async function modelRoute(path, method, body) {
  if (path === "/api/models" && method === "GET") return profiles();
  if (method !== "POST") fault("无此接口", 404);
  const data = await body();
  switch (path) {
    case "/api/providers/save":
      return saveProvider(data);
    case "/api/providers/delete":
      return deleteProvider(data.id);
    case "/api/providers/discover":
      return { models: await discoverModels(providerConnection(data)) };
    case "/api/providers/test":
    case "/api/models/test": {
      const config =
        path === "/api/models/test"
          ? legacyConnection(data)
          : { ...providerConnection(data), model: data.model };
      if (typeof config.model !== "string" || !config.model.trim())
        fault("请选择要测试的模型");
      await complete(config, [{ role: "user", content: "Reply OK" }], 96);
      return { message: "测试成功 · " + config.model };
    }
    case "/api/models/save":
      return saveLegacy(data);
    case "/api/models/switch":
      return selectModel(data.id, data.scope);
    default:
      fault("无此接口", 404);
  }
}
