import { defineTask } from "@earendil-works/pi-durable";
export const loopPolicy = {
  maxTurns: null,
  maxCorrections: 2,
  maxProseContinuations: 3,
  maxStalledContinuations: 2,
  settings: {
    toolExecution: "sequential",
    stream: { timeoutMs: 120000 },
    compaction: { enabled: true },
    retry: { enabled: true },
  },
};
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
