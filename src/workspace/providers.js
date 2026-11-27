import { $, confirmDelete, toast } from "../shared";
import { api, online } from "../service";

let catalog = { providers: [], selections: { agent: null, completion: null } };
const controls = { agent: "agentModel", completion: "completionModel" };
export function selectedModel(scope) {
  return catalog.selections[scope];
}
export function setModels(data) {
  catalog = { providers: data.providers, selections: data.selections };
  for (const [scope, control] of Object.entries(controls)) {
    const provider = catalog.providers.find((p) =>
      p.models.some((m) => m.id === selectedModel(scope)),
    );
    const model = provider?.models.find((m) => m.id === selectedModel(scope));
    $(control).textContent = (model?.model || "选择模型") + " ▾";
    $(control).title = provider
      ? provider.name + " · " + model.model
      : "配置模型供应商";
  }
}
function openManager() {
  if (!$("settingsDialog").open) $("workspaceSettings").click();
  $("models").click();
}
function installPicker(onCompletionChange) {
  const picker = document.createElement("div");
  picker.popover = "auto";
  picker.className = "modelPicker";
  picker.setAttribute("role", "dialog");
  picker.setAttribute("aria-label", "选择模型");
  picker.innerHTML =
    '<input type="search" aria-label="搜索模型" placeholder="搜索模型或供应商"><div class="modelOptions"></div><button type="button" class="manageProviders">管理供应商</button>';
  document.body.append(picker);
  const search = picker.querySelector("input"),
    options = picker.querySelector(".modelOptions");
  let scope, trigger;
  function place() {
    const anchor = trigger.getBoundingClientRect();
    const above =
      innerHeight - anchor.bottom < picker.offsetHeight &&
      anchor.top > innerHeight - anchor.bottom;
    picker.style.left =
      Math.max(
        6,
        Math.min(
          innerWidth - picker.offsetWidth - 6,
          anchor.right - picker.offsetWidth,
        ),
      ) + "px";
    picker.style.top =
      Math.max(
        6,
        Math.min(
          innerHeight - picker.offsetHeight - 6,
          above ? anchor.top - picker.offsetHeight - 4 : anchor.bottom + 4,
        ),
      ) + "px";
  }
  function filter() {
    options.replaceChildren();
    const groups = new Map();
    for (const p of catalog.providers) {
      const hits = p.models.filter((m) =>
        (p.name + " " + p.base + " " + m.model)
          .toLowerCase()
          .includes(search.value.trim().toLowerCase()),
      );
      if (!hits.length) continue;
      if (!groups.has(p.base)) groups.set(p.base, []);
      groups.get(p.base).push({ provider: p, models: hits });
    }
    for (const [base, group] of groups) {
      const head = document.createElement("strong");
      head.textContent = group.map((x) => x.provider.name).join(" / ");
      head.title = base;
      const url = document.createElement("small");
      url.textContent = base;
      head.append(url);
      options.append(head);
      for (const { provider, models } of group)
        for (const m of models) {
          const row = document.createElement("button");
          row.type = "button";
          row.textContent =
            (group.length > 1 ? provider.name + " · " : "") + m.model;
          row.setAttribute(
            "aria-pressed",
            String(m.id === selectedModel(scope)),
          );
          row.onclick = async () => {
            const purpose = scope;
            picker.hidePopover();
            try {
              const result = await api("models/switch", {
                scope: purpose,
                id: m.id,
              });
              setModels(result);
              if (purpose === "completion") onCompletionChange();
            } catch (e) {
              toast(e.message);
            }
          };
          options.append(row);
        }
    }
    if (!groups.size)
      options.textContent = catalog.providers.length
        ? "没有匹配的模型"
        : "尚未配置供应商";
  }
  search.oninput = () => {
    filter();
    place();
  };
  picker.querySelector(".manageProviders").onclick = () => {
    picker.hidePopover();
    openManager();
  };
  picker.onkeydown = (e) => {
    if (!["ArrowDown", "ArrowUp"].includes(e.key)) return;
    const items = [
      search,
      ...options.querySelectorAll("button"),
      picker.lastElementChild,
    ];
    e.preventDefault();
    items[
      (items.indexOf(document.activeElement) +
        (e.key === "ArrowDown" ? 1 : -1) +
        items.length) %
        items.length
    ].focus();
  };
  for (const [purpose, id] of Object.entries(controls)) {
    $(id).disabled = !online;
    $(id).onclick = () => {
      scope = purpose;
      trigger = $(id);
      search.value = "";
      filter();
      picker.showPopover();
      place();
      search.focus();
    };
  }
  window.addEventListener("resize", () => {
    if (picker.matches(":popover-open")) place();
  });
}

export function initModels(onCompletionChange) {
  installPicker(onCompletionChange);
  const directory = $("providerDirectory"),
    list = $("providerList");
  const form = $("modelForm"),
    fields = form.elements,
    status = $("modelStatus");
  const fieldset = $("providerFields"),
    back = $("backToProviders");
  let epoch = 0;

  function renderList() {
    list.replaceChildren();
    for (const provider of catalog.providers) {
      const item = document.createElement("li");
      const row = document.createElement("button");
      row.type = "button";
      row.dataset.id = provider.id;
      const name = document.createElement("strong");
      const base = document.createElement("small");
      const count = document.createElement("span");
      name.textContent = provider.name;
      base.textContent = provider.base;
      count.textContent = provider.models.length + " 个模型";
      row.append(name, base, count);
      row.onclick = () => editProvider(provider);
      item.append(row);
      list.append(item);
    }
    $("providerListStatus").textContent = catalog.providers.length
      ? ""
      : "尚未配置供应商";
  }
  function showList(focusId) {
    epoch++;
    form.reset();
    form.hidden = true;
    directory.hidden = false;
    renderList();
    if (focusId !== undefined) {
      const previous = Array.from(list.querySelectorAll("button")).find(
        (row) => row.dataset.id === focusId,
      );
      (previous || $("newProvider")).focus();
    }
  }
  function editProvider(provider) {
    epoch++;
    directory.hidden = true;
    form.hidden = false;
    fieldset.disabled = back.disabled = false;
    form.dataset.providerId = provider?.id || crypto.randomUUID();
    $("providerFormTitle").textContent = provider ? "编辑供应商" : "新增供应商";
    fields.name.value = provider?.name || "";
    fields.base.value = provider?.base || "";
    fields.apiKey.value = "";
    fields.apiKey.required = !provider;
    fields.apiKey.placeholder = provider
      ? "留空沿用当前地址的密钥"
      : "输入 API Key";
    fields.models.value = provider?.models.map((m) => m.model).join("\n") || "";
    $("removeProvider").hidden = !provider;
    status.textContent = "";
    fields.name.focus();
  }
  $("newProvider").onclick = () => editProvider();
  back.onclick = () => showList(form.dataset.providerId);
  $("models").onclick = async () => {
    showList();
    $("newProvider").disabled = !online;
    if (!online) {
      $("providerListStatus").textContent = "请登录服务版工作台配置供应商";
      return;
    }
    const pass = epoch;
    try {
      const latest = await api("models");
      if (pass === epoch) {
        setModels(latest);
        renderList();
      }
    } catch (error) {
      if (pass === epoch) $("providerListStatus").textContent = error.message;
    }
  };
  $("settingsDialog").addEventListener("close", () => {
    epoch++;
    fields.apiKey.value = "";
  });
  async function submit(action) {
    const models = fields.models.value
      .split(/\r?\n/)
      .map((v) => v.trim())
      .filter(Boolean);
    const data = {
      id: form.dataset.providerId,
      name: fields.name.value.trim(),
      base: fields.base.value.trim(),
      apiKey: fields.apiKey.value,
      models,
    };
    if (action === "save" && !form.reportValidity()) return;
    const pass = ++epoch;
    fieldset.disabled = true;
    back.disabled = action === "save" || action === "delete";
    status.textContent = "处理中…";
    try {
      const result = await api(
        "providers/" + action,
        action === "delete" ? { id: data.id } : { ...data, model: models[0] },
      );
      if (action === "save" || action === "delete") {
        setModels(result);
        onCompletionChange();
        if (pass === epoch) {
          showList(result.savedProviderId || "");
          if (catalog.providers.length)
            $("providerListStatus").textContent =
              action === "delete" ? "已删除供应商" : "供应商已保存";
        } else if (!directory.hidden) {
          renderList();
        }
      } else if (pass === epoch) {
        if (action === "discover") {
          fields.models.value = [
            ...new Set([...models, ...result.models]),
          ].join("\n");
          status.textContent =
            "已获取 " + result.models.length + " 个模型，可调整后保存";
        } else status.textContent = result.message;
      }
    } catch (e) {
      if (pass === epoch) status.textContent = e.message;
    } finally {
      if (pass === epoch) fieldset.disabled = back.disabled = false;
    }
  }
  form.onsubmit = (e) => {
    e.preventDefault();
    submit("save");
  };
  $("discoverModels").onclick = () => submit("discover");
  $("testModel").onclick = () => submit("test");
  $("removeProvider").onclick = () => {
    const provider = catalog.providers.find(
      (p) => p.id === form.dataset.providerId,
    );
    if (provider)
      confirmDelete("删除供应商「" + provider.name + "」及其模型配置？", () =>
        submit("delete"),
      );
  };
}
