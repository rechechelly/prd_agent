import { defineTool } from "@earendil-works/pi-durable";

export const toolReply = (text, isError = false) => ({
  output: [{ type: "text", text }],
  isError,
});

// Keep text and JSON results in Pi's text output format, including recoverable errors.
export function defineTextTool({ execute, ...definition }) {
  return defineTool({
    ...definition,
    async execute(...args) {
      try {
        const value = await execute(...args);
        return toolReply(typeof value === "string" ? value : JSON.stringify(value));
      } catch (error) {
        return toolReply(error.message, true);
      }
    },
  });
}
