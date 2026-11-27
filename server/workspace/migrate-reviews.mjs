// Earlier cross-file deliveries inserted a synthetic first turn to host a review.
export function migrateExternalReviews(file) {
  if (!file.workspaceChangeRun || !file.chatSessions) return;
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
  }
  if (!file.chatSessions.length) delete file.chatSessions;
}
