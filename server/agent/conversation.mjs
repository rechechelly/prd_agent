import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { CompactionEntry } from "@earendil-works/pi-durable";
import { fault } from "../storage.mjs";
export async function conversationFor(h, session, rewind) {
  const ownership = { ownership: { kind: "ownerless" } };
  const root = session?.conversationId
    ? await h.conversation(session.conversationId, ctx)
    : await h.root(ctx);
  if (!root) fault("找不到会话记录，请重新打开工作区", 409);
  if (!session) return root;
  const prefix = session.messages.slice(0, rewind ?? session.messages.length);
  const previous = prefix.at(-1);
  if (!previous) return h.createConversation(ownership, ctx);
  let checkpoint = previous.userOnly ? previous.userEntry : previous.answerEntry;
  if (!checkpoint) {
    // Older saved turns have no entry IDs. Match their successful question/answer pairs in order.
    const { entries } = await root.context(ctx);
    let matched = 0,
      lastQuestion;
    for (const entry of entries) {
      const model = entry.model?.[0];
      if (model?.role === "user")
        lastQuestion =
          typeof model.content === "string"
            ? model.content
            : model.content.find((x) => x.type === "text")?.text;
      if (
        model?.role !== "assistant" ||
        !lastQuestion?.endsWith("\n用户：" + prefix[matched].q)
      )
        continue;
      const answer = model.content
        .filter((x) => x.type === "text")
        .map((x) => x.text)
        .join("");
      if (answer !== prefix[matched].answer) continue;
      if (++matched === prefix.length) {
        checkpoint = entry.id;
        break;
      }
      lastQuestion = undefined;
    }
    if (!checkpoint) {
      // Imported/offline conversations may have no corresponding durable transcript.
      const recovered = await h.createConversation(ownership, ctx);
      await recovered.reset(
        "此前保留的对话记录：" +
          JSON.stringify(prefix.map(({ q, answer }) => ({ q, answer }))),
        ctx,
      );
      return recovered;
    }
  }
  if (rewind === undefined) {
    // A background summary can land after the visible answer. Continue from
    // that head unless a different turn has since been written.
    let cursor;
    do {
      const page = await root.entries({ minEntryId: checkpoint }, 8, cursor, ctx);
      const latest = page.items.find(entry => !CompactionEntry.is(entry));
      if (latest?.id === checkpoint) return root;
      if (latest) break;
      cursor = page.next;
    } while (cursor !== undefined);
  }
  return root.fork(checkpoint, ownership, ctx);
}
