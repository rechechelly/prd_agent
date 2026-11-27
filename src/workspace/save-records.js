// Keep large, unchanged bodies out of autosave requests after they have been opened.
const baseline = new Map();
export function rememberFile(file) {
  baseline.set("file:" + file.id, JSON.stringify(file));
}
export function rememberChat(chat) {
  baseline.set("chat:" + chat.id, JSON.stringify(chat));
}
export function packWorkspace(data) {
  const sent = new Map();
  function pack(item, kind) {
    const key = kind + ":" + item.id;
    if (item.deferred) return item;
    const value = JSON.stringify(item);
    sent.set(key, value);
    if (baseline.get(key) !== value) return item;
    if (kind === "chat") return { id: item.id, deferred: true };
    const { id, title, parent, position } = item;
    return { id, title, parent, position, deferred: true };
  }
  const packed = { ...data, docs: data.docs.map(f => pack(f, "file")),
    folders: data.folders.map(f => pack(f, "file")), chats: data.chats.map(s => pack(s, "chat")) };
  return { packed, saved() {
    const ids = new Set([...data.docs, ...data.folders].map(f => "file:" + f.id).concat(data.chats.map(s => "chat:" + s.id)));
    for (const key of baseline.keys()) if (!ids.has(key)) baseline.delete(key);
    for (const [key, value] of sent) baseline.set(key, value);
  } };
}
