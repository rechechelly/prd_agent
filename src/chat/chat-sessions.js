// A legacy document's single conversation keeps its original Pi SQLite identity.
export function sessions(file) {
  if (!file) return [];
  if (!file.chatSessions) {
    const messages = file.messages || [];
    file.chatSessions = [
      { id: "legacy", messages, updatedAt: messages.at(-1)?.createdAt || 0 },
    ];
    delete file.messages;
  }
  return file.chatSessions;
}
export function selectedSession(file) {
  const list = sessions(file);
  return list.find((s) => s.id === file?.selectedChat) || list[0];
}
export function sessionName(s) {
  return (
    s.messages[0]?.q || s.pausedQuestion || s.failedAttempts?.[0]?.q || "新会话"
  );
}

// Earlier cross-file deliveries inserted a synthetic first turn to host a review.
export function migrateExternalReviews(file) {
  if (!file.workspaceChangeRun || !file.chatSessions) return false;
  let changed = false;
  for (const session of [...file.chatSessions]) {
    const first = session.messages?.[0];
    if (first?.answer !== "文件修改已准备好，请预览并采用。" || first.requestId ||
        !(first.resolved || typeof first.proposed === "string" || first.canvasPatch)) continue;
    session.messages.shift();
    if (!first.resolved) {
      const { q, answer, ...review } = first;
      (file.externalReviews ||= []).push(review);
    }
    if (!session.messages.length && !session.failedAttempts?.length && !session.pausedQuestion && !session.conversationId) {
      file.chatSessions = file.chatSessions.filter(s => s !== session);
      if (file.selectedChat === session.id) delete file.selectedChat;
    }
    changed = true;
  }
  if (!file.chatSessions.length) delete file.chatSessions;
  return changed;
}
