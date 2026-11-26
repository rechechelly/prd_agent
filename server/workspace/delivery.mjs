import { startGeneration, retainDelivery } from "./generation-log.mjs";

export function recordWorkspaceFiles(owner, files, changes, question) {
  const trace = startGeneration(owner);
  const output = { files, changes, question };
  retainDelivery(trace.record.id, owner, output);
  trace.recordEvent({
    stage: "delivery",
    status: "done",
    finished: Date.now(),
  });
  return { ...output, runId: trace.record.id };
}
