import { $, dialog, toast } from "../shared";
import { api, flush, online } from "../service";
import { createPrdDiscussion } from "./prd-discussion.mjs";
import { mountBoard, unmountBoard } from "../workspace/board";

export async function shareFile(doc) {
  if (!online) return toast("请在登录版工作台分享文件");
  const ref = doc.origin || { doc: doc.id, file: "document" };
  const title = doc.title;
  const button = $("share");
  button.disabled = true;
  try {
    await flush();
    let state = await api("share", { ...ref, lookup: true });
    dialog("分享「" + title + "」",
      '<label class="shareSetting"><span>开启链接分享</span><input type="checkbox" role="switch" id="shareEnabled"></label><input aria-label="分享链接" id="fileShareUrl" readonly>',
      () => {
        navigator.clipboard.writeText(state.url).then(() => toast("链接已复制"))
          .catch(() => { $("fileShareUrl").select(); toast("请复制选中的链接"); });
        return false;
      }, "复制链接");
    const toggle = $("shareEnabled"), link = $("fileShareUrl");
    const refresh = () => {
      toggle.checked = state.enabled;
      link.hidden = $("submit").hidden = !state.enabled;
      link.value = state.url || "";
    };
    refresh();
    $("cancel").textContent = "关闭";
    toggle.onchange = async () => {
      toggle.disabled = true;
      try { state = await api("share", { ...ref, enabled: toggle.checked }); }
      catch (error) { toast(error.message); }
      finally {
        toggle.disabled = false;
        if (toggle.isConnected) refresh();
      }
    };
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
}

export async function publicBoard() {
  const endpoint = "./api/public/" + document.querySelector("meta[name=public-token]").content;
  const title = document.createElement("h1"),
    mount = document.createElement("div");
  mount.style.cssText = "height:calc(100dvh - 50px);width:100%";
  title.style.cssText = "font-size:18px;padding:10px 20px;margin:0";
  const layout = document.createElement("main"), panel = document.createElement("aside");
  layout.style.cssText = "display:grid;grid-template-columns:minmax(0,1fr) min(30%,300px)";
  panel.className = "prd-discussion";
  layout.append(mount, panel);
  document.body.replaceChildren(title, layout);
  const discussion = createPrdDiscussion(panel, { guest: true, async post(comment) {
    const response = await fetch(endpoint + "/comments", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify(comment) });
    if (!response.ok) throw Error((await response.json()).error);
    await refresh();
  } });
  let revision,
    seq = 0;
  const stream = new EventSource(endpoint + "/events");
  async function refresh() {
    const id = ++seq;
    try {
      const response = await fetch(endpoint);
      if (id !== seq) return;
      if (!response.ok) {
        if (response.status === 404) {
          stream.close();
          unmountBoard();
          discussion.disable(); panel.hidden = true;
          title.textContent = document.title = "分享链接不可用";
        }
        return;
      }
      const file = await response.json();
      if (id !== seq) return;
      discussion.draw(file.comments || []);
      if (revision === file.revision) return;
      revision = file.revision;
      title.textContent = document.title = file.title;
      mountBoard(file, mount, null, file.scene);
    } catch {
      title.textContent = "暂时无法读取画布";
    }
  }
  stream.onopen = stream.onmessage = stream.onerror = refresh;
  await refresh();
}
