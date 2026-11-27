import { DEFAULT_COMPACTION_POLICY, defineTask } from "@earendil-works/pi-durable";
import { DEFAULT_CONTEXT_WINDOW } from "../../shared/chat-sessions.mjs";
export const loopPolicy = {
  maxTurns: null,
  maxCorrections: 2,
  maxProseContinuations: 3,
  maxStalledContinuations: 2,
  settings: {
    toolExecution: "sequential",
    stream: { timeoutMs: 120000 },
    retry: { enabled: true },
  },
};

// Keep Pi's default budgets at 200k and above. At 32k its fixed background
// margin alone would exceed the entire window and its recent tail would be 20k.
export function compactionSettings(contextWindow = DEFAULT_CONTEXT_WINDOW) {
  const scale = Math.min(1, contextWindow / DEFAULT_CONTEXT_WINDOW);
  const { reserveTokens, keepRecentTokens, backgroundTokens } = DEFAULT_COMPACTION_POLICY;
  return {
    enabled: true,
    reserveTokens: Math.max(4096, Math.floor(reserveTokens * scale)),
    keepRecentTokens: Math.floor(keepRecentTokens * scale),
    backgroundTokens: Math.floor(backgroundTokens * scale),
  };
}
export const CompactionBoundary = defineTask({
  name: "xuye.compaction-boundary",
  version: 1,
  initial: () => ({ phase: "finish" }),
  phases: {
    finish: (_task, runtime, context) =>
      runtime.commit(
        () => ({
          status: "terminal",
          outcome: { status: "completed", result: { terminate: true } },
        }),
        context,
      ),
  },
  abort: (_task, runtime, context) =>
    runtime.commit(
      () => ({ status: "terminal", outcome: { status: "aborted" } }),
      context,
    ),
});
