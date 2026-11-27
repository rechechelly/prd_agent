import { randomUUID } from "node:crypto";
import { db, fault, seal, set, setting, transaction, unseal } from "../storage.mjs";

export function normalizeBase(value) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    fault("请输入有效的 Base URL");
  }
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !(url.protocol === "https:" || (url.protocol === "http:" && local))
  )
    fault("请使用 HTTPS 接口或本机 HTTP 接口，地址中不能包含密钥");
  return url.href
    .replace(/\/+$/, "")
    .replace(/\/(chat\/completions|models)$/, "")
    .replace(/\/+$/, "");
}

transaction(() => {
  db.exec(`CREATE TABLE IF NOT EXISTS providers(id TEXT PRIMARY KEY, name TEXT NOT NULL, base TEXT NOT NULL, secret TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS provider_models(id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, model TEXT NOT NULL, UNIQUE(provider_id, model));`);
  if (
    !db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='profiles'",
      )
      .get()
  )
    return;
  const groups = new Map();
  for (const row of db.prepare("SELECT * FROM profiles ORDER BY rowid").all()) {
    if (!row.secret) continue;
    const base = normalizeBase(row.base);
    const key = JSON.stringify([base, unseal(row.secret)]);
    let id = groups.get(key);
    if (!id) {
      id = randomUUID();
      db.prepare("INSERT INTO providers VALUES(?,?,?,?)").run(
        id,
        row.name,
        base,
        row.secret,
      );
      groups.set(key, id);
    }
    db.prepare("INSERT OR IGNORE INTO provider_models VALUES(?,?,?)").run(
      row.id,
      id,
      row.model,
    );
    if (setting("active") === row.id) {
      const selected = db
        .prepare(
          "SELECT id FROM provider_models WHERE provider_id=? AND model=?",
        )
        .get(id, row.model).id;
      set("agentModel", selected);
      set("completionModel", selected);
    }
  }
  db.exec("DROP TABLE profiles");
});

const modelRows = () =>
  db
    .prepare(
      "SELECT m.id,p.id AS providerId,p.name,p.base,m.model FROM provider_models m JOIN providers p ON p.id=m.provider_id ORDER BY p.name,p.base,m.rowid",
    )
    .all();
function selected(scope, rows) {
  const id = setting(scope + "Model");
  return rows.find((m) => m.id === id)?.id || rows[0]?.id || null;
}
export function profiles() {
  const rows = modelRows();
  const providers = db
    .prepare("SELECT id,name,base FROM providers ORDER BY name,base")
    .all()
    .map((p) => ({
      ...p,
      hasKey: true,
      models: rows
        .filter((m) => m.providerId === p.id)
        .map(({ id, model }) => ({ id, model })),
    }));
  const active = selected("agent", rows);
  return {
    providers,
    active,
    profiles: rows.map((m) => ({ ...m, hasKey: true })),
    selections: { agent: active, completion: selected("completion", rows) },
  };
}
function savedProvider(id) {
  return db.prepare("SELECT * FROM providers WHERE id=?").get(id || "");
}
function credential(input, prior) {
  const base = normalizeBase(input.base ?? prior?.base);
  const key =
    String(input.apiKey || "").trim() ||
    (prior?.base === base && unseal(prior.secret));
  if (!key || key.length > 8192 || /[\r\n]/.test(key))
    fault("请为此 Base URL 填写有效的 API Key");
  return { base, secret: key };
}
export function providerConnection(input) {
  return credential(input, savedProvider(input.id));
}
function modelNames(value) {
  if (!Array.isArray(value) || !value.length || value.length > 1000)
    fault("请填写 1 至 1000 个模型名称");
  const names = value.map((m) => (typeof m === "string" ? m.trim() : ""));
  if (names.some((m) => !m || m.length > 200 || /[\r\n]/.test(m)))
    fault("模型名称需为 1 至 200 个字符");
  return [...new Set(names)];
}
function store(input, preferredIds = new Map()) {
  const id = input.id || randomUUID(),
    prior = savedProvider(id);
  const name = String(input.name || "").trim();
  if (typeof id !== "string" || id.length > 200 || !name || name.length > 100)
    fault("供应商名称或编号无效");
  const names = modelNames(input.models);
  const { base, secret } = credential(input, prior);
  db.prepare(
    "INSERT INTO providers VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,base=excluded.base,secret=excluded.secret",
  ).run(id, name, base, seal(secret));
  for (const m of db
    .prepare("SELECT * FROM provider_models WHERE provider_id=?")
    .all(id))
    if (!names.includes(m.model))
      db.prepare("DELETE FROM provider_models WHERE id=?").run(m.id);
  for (const model of names)
    db.prepare(
      "INSERT INTO provider_models VALUES(?,?,?) ON CONFLICT(provider_id,model) DO NOTHING",
    ).run(preferredIds.get(model) || randomUUID(), id, model);
  for (const [scope, choice] of Object.entries(profiles().selections))
    set(scope + "Model", choice);
  return id;
}
export function saveProvider(input) {
  return transaction(() => {
    const savedProviderId = store(input);
    return { ...profiles(), savedProviderId };
  });
}
export function deleteProvider(id) {
  return transaction(() => {
    if (!savedProvider(id)) fault("供应商不存在", 404);
    db.prepare("DELETE FROM provider_models WHERE provider_id=?").run(id);
    db.prepare("DELETE FROM providers WHERE id=?").run(id);
    for (const [scope, choice] of Object.entries(profiles().selections))
      set(scope + "Model", choice || "");
    return profiles();
  });
}
export function selectModel(id, scope) {
  if (scope !== undefined && !["agent", "completion"].includes(scope))
    fault("未知的模型用途");
  if (!db.prepare("SELECT id FROM provider_models WHERE id=?").get(id || ""))
    fault("模型已移除，请重新选择", 409);
  for (const s of scope ? [scope] : ["agent", "completion"])
    set(s + "Model", id);
  return profiles();
}
export function modelConfig(scope, requested) {
  const id = requested ?? selected(scope, modelRows());
  if (!id) fault("请先在工作区设置的「供应商管理」添加模型", 409);
  if (typeof id !== "string") fault("模型编号无效");
  const row = db
    .prepare(
      "SELECT p.id,p.name,p.base,p.secret,m.id AS modelId,m.model FROM provider_models m JOIN providers p ON p.id=m.provider_id WHERE m.id=?",
    )
    .get(id);
  if (!row) fault("模型已移除，请重新选择", 409);
  return { ...row, secret: unseal(row.secret) };
}
// Pre-1.0 clients identify one configuration by model ID.
export function legacyConnection(input) {
  const row = modelRows().find((m) => m.id === input.id);
  return {
    ...credential(input, savedProvider(row?.providerId)),
    name: input.name ?? row?.name,
    model: modelNames([input.model ?? row?.model])[0],
  };
}
export function saveLegacy(input) {
  return transaction(() => {
    const config = legacyConnection(input);
    const row = modelRows().find((m) => m.id === input.id);
    const siblings =
      row &&
      db
        .prepare(
          "SELECT count(*) AS n FROM provider_models WHERE provider_id=?",
        )
        .get(row.providerId).n;
    if (row && siblings > 1)
      db.prepare("DELETE FROM provider_models WHERE id=?").run(row.id);
    const id = store(
      {
        id: siblings === 1 ? row.providerId : undefined,
        ...config,
        apiKey: config.secret,
        models: [config.model],
      },
      new Map([[config.model, input.id || randomUUID()]]),
    );
    return selectModel(
      db
        .prepare(
          "SELECT id FROM provider_models WHERE provider_id=? AND model=?",
        )
        .get(id, config.model).id,
    );
  });
}
