import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

test("R3r/R3s structure: both model tool phases delegate to the same deterministic kernel", async () => {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const source = await readFile(resolve(thisDir, "../src/runtime/runtimeAgentLoopLegacy.ts"), "utf8");

  assert.equal(
    source.match(/executeRuntimeToolBatchKernel\(\{/g)?.length,
    2,
    "first and second model tool batches must each enter the same deterministic batch kernel once",
  );
  assert.doesNotMatch(
    source,
    /executeRuntimeNonWriteToolBatch/,
    "legacy loop must not keep a parallel non-write batch executor",
  );
  assert.match(
    source,
    /tool_results: resolvedRound2Results/,
    "terminal third model step must receive the complete outputs for the second batch",
  );
  assert.equal(
    source.match(/prior_booking_process_state: bookingProcessState/g)?.length,
    2,
    "both batch phases must reduce from the runtime-owned booking state",
  );
});
