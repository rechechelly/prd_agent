import { toolDescriptions, toolGroups } from "../../shared/agent-catalog.mjs";
import { $, confirmDelete, toast } from "../shared";
import { api, online } from "../service";

async function openAgentSettings() {
  try {
    const catalog = online
      ? await api("agent-catalog")
      : {
          tools: Object.entries(toolDescriptions).map(
            ([name, description]) => ({ name, description }),
          ),
          skills: [],
        };
    $("importSkill").hidden = !online;
    $("skillStatus").textContent = online
      ? (catalog.warnings || []).join("；")
      : "离线预览展示工作台内置工具。登录在线工作台可查看 Pi 系统工具和已安装的技能。";
    $("importSkill").onclick = () => $("skillFolder").click();
    $("skillFolder").onchange = async (event) => {
      const files = Array.from(event.target.files).filter(
        (f) => !f.webkitRelativePath.split("/").some((s) => s.startsWith(".")),
      );
      event.target.value = "";
      if (!files.length) return;
      const name = files[0].webkitRelativePath.split("/")[0];
      try {
        const payload = [];
        for (const file of files) {
          const data = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result.split(",")[1]);
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(file);
          });
          payload.push({
            path: file.webkitRelativePath.slice(name.length + 1),
            data,
          });
        }
        await api("skills/import", { name, files: payload });
        await openAgentSettings();
        toast("已安装技能 " + name);
      } catch (error) {
        $("skillStatus").textContent = error.message;
      }
    };
    for (const [id, items] of [
      ["agentToolList", catalog.tools],
      ["agentSkillList", catalog.skills],
    ]) {
      const list = $(id);
      list.replaceChildren();
      const rows = id === "agentToolList"
        ? Object.entries(toolGroups).flatMap(([group, names]) => names.map(name => ({ ...items.find(i => i.name === name), group })).filter(i => i.name))
        : items;
      let lastGroup;
      for (const item of rows) {
        if (item.group && item.group !== lastGroup) {
          const label = document.createElement("dt");
          label.className = "toolGroup";
          label.textContent = lastGroup = item.group;
          list.append(label);
        }
        const name = document.createElement("dt"),
          detail = document.createElement("dd");
        name.textContent = item.title
          ? item.title + " · " + item.name
          : item.name;
        detail.textContent = item.description;
        if (id === "agentSkillList" && online) {
          const actions = document.createElement("span");
          actions.className = "skillActions";
          const download = document.createElement("a");
          download.href =
            "./api/skills/export?name=" + encodeURIComponent(item.name);
          download.download = item.name + ".zip";
          download.textContent = "导出";
          const remove = document.createElement("button");
          remove.type = "button";
          remove.textContent = "删除";
          remove.setAttribute("aria-label", "删除技能 " + item.name);
          remove.onclick = () => confirmDelete("删除技能「" + item.name + "」？之后可以重新导入。", async () => {
            try {
              await api("skills/delete", { name: item.name });
              await openAgentSettings();
              toast("已删除技能 " + item.name);
            } catch (error) {
              $("skillStatus").textContent = error.message;
            }
          });
          actions.append(download, remove);
          name.append(actions);
        }
        list.append(name, detail);
      }
    }
  } catch (e) {
    toast(e.message);
  }
}

export function installWorkspaceSettings() {
  const settingsDialog = $("settingsDialog");
  function settingsPane(pane) {
    for (const b of settingsDialog.querySelectorAll("[data-pane]")) {
      $(b.dataset.pane).hidden = b.dataset.pane !== pane;
      b.setAttribute("aria-pressed", String(b.dataset.pane === pane));
    }
    if (pane === "agentPage") openAgentSettings();
  }
  settingsDialog
    .querySelector(".settingsTabs")
    .addEventListener("click", (e) => {
      if (e.target.dataset.pane) settingsPane(e.target.dataset.pane);
    });
  $("workspaceSettings").onclick = () => {
    settingsDialog.showModal();
    settingsPane("agentPage");
  };
  $("closeSettings").onclick = () => settingsDialog.close();
}
