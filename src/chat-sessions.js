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
