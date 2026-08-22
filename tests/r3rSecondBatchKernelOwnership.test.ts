import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

test("R3r structure: legacy loop delegates the second model tool batch to one deterministic kernel", async () => {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const source = await readFile(resolve(thisDir, "../src/runtime/runtimeAgentLoopLegacy.ts"), "utf8");

  assert.equal(
    source.match(/executeRuntimeToolBatchKernel\(\{/g)?.length,
    1,
    "the second model tool batch must have one deterministic batch-kernel entry point",
  );
  assert.doesNotMatch(
    source,
    /executeRuntimeNonWriteToolBatch/,
    "legacy loop must not keep a parallel non-write second-batch executor",
  );
  assert.match(
    source,
    /tool_results: resolvedRound2Results/,
    "terminal model step must receive the complete outputs for the current second batch",
  );
  assert.match(
    source,
    /prior_booking_process_state: bookingProcessState/,
    "booking preflight must observe state reduced by the deterministic batch kernel",
  );
});
