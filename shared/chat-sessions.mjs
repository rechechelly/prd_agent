export const DEFAULT_CONTEXT_WINDOW = 200_000;
export const MIN_CONTEXT_WINDOW = 32_000;
export const isContextWindow = value => Number.isSafeInteger(value) && value >= MIN_CONTEXT_WINDOW;

// A user turn establishes its file context. Only mutations in its answer link outputs.
export function relatedFiles(session) {
  if (session.deferred) return session.fileIds;
  const ids = new Set([session.sourceId]);
  for (const turn of session.messages || []) {
    if (turn.fileId) ids.add(turn.fileId);
    for (const id of turn.written || []) ids.add(id);
  }
  return [...ids];
}
export const sessionName = s => s.name || s.messages?.[0]?.q || s.pausedQuestion || s.failedAttempts?.[0]?.q || "新会话";
export const targetsFile = (message, session, file) => (message.fileId || session.sourceId) === file.id;
