import { readFileDetail, online } from "../service";
import { rememberFile, rememberChat } from "./save-records";
import { chats } from "../chat/chat-sessions";

let ownerPath;
const loading = new WeakMap();
export function configureNavigation(owner) {
  if (owner) ownerPath = new URL(encodeURIComponent(owner), document.baseURI).pathname;
}
export function addressKey() {
  const path = location.pathname;
  return ownerPath && path.startsWith(ownerPath + "/") ? path.slice(ownerPath.length + 1) : "";
}
export function visitFile(file, replace) {
  if (!ownerPath) return;
  const next = ownerPath + (file ? "/" + (file.key || file.id) : "");
  if (location.pathname !== next) history[replace === true ? "replaceState" : "pushState"](null, "", next);
}
export function loadFile(file) {
  if (!online || !file?.deferred) return;
  if (!loading.has(file)) {
    const request = readFileDetail(file.id)
      .then(data => {
        const { title, parent, position } = file;
        Object.assign(file, data.file, { title, parent, position });
        delete file.deferred;
        rememberFile(data.file);
        for (const stored of data.chats) {
          const local = chats.find(s => s.id === stored.id);
          if (local?.deferred) {
            Object.assign(local, stored);
            delete local.deferred;
            delete local.fileIds;
            rememberChat(local);
          }
        }
      }).finally(() => loading.delete(file));
    loading.set(file, request);
  }
  return loading.get(file);
}
