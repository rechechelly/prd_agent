import { relatedFiles, sessionName } from "../../shared/chat-sessions.mjs";
import { changed } from "../service";
export { sessionName };
export const chats = [];
const selected = new WeakMap();
export function newSession(file) {
  const session = { id: crypto.randomUUID(), sourceId: file.id, messages: [], updatedAt: 0 };
  chats.push(session);
  changed();
  chooseSession(file, session);
  return session;
}
export function sessions(file) {
  return file ? chats.filter(s => relatedFiles(s).includes(file.id)).sort((a,b) => (b.lastAskedAt ?? b.updatedAt) - (a.lastAskedAt ?? a.updatedAt)) : [];
}
export function chooseSession(file, session) {
  selected.set(file, session);
  session.closed = false;
}
export function latestSession(file) {
  const latest = sessions(file)[0] || newSession(file);
  chooseSession(file, latest);
}
export function selectedSession(file) {
  if (!file) return;
  const current = selected.get(file);
  if (current && chats.includes(current) && relatedFiles(current).includes(file.id)) return current;
  latestSession(file);
  return selected.get(file);
}
