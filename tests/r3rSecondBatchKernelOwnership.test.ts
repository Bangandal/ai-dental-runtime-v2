import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

test("R3u structure: both model tool phases delegate to one complete turn-batch handler", async () => {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const loopSource = await readFile(resolve(thisDir, "../src/runtime/runtimeAgentLoopLegacy.ts"), "utf8");
  const handlerSource = await readFile(resolve(thisDir, "../src/runtime/runtimeTurnToolBatch.ts"), "utf8");

  assert.equal(
    loopSource.match(/executeRuntimeTurnToolBatch\(\{/g)?.length,
    2,
    "first and second model tool batches must each enter the same complete batch handler once",
  );
  assert.doesNotMatch(
    loopSource,
    /executeRuntimeToolBatchKernel\(/,
    "legacy loop must not bypass the complete handler into the lower state kernel",
  );
  assert.doesNotMatch(
    loopSource,
    /executeRuntimeNonWriteToolBatch/,
    "legacy loop must not keep a parallel non-write batch executor",
  );
  assert.equal(
    handlerSource.match(/executeRuntimeToolBatchKernel\(\{/g)?.length,
    1,
    "the complete handler must have one deterministic state-kernel owner",
  );
  assert.match(
    loopSource,
    /tool_results: resolvedRound2Results/,
    "terminal third model step must receive the complete outputs for the second batch",
  );
  assert.equal(
    loopSource.match(/booking_process_state: bookingProcessState/g)?.length,
    2,
    "both batch phases must pass the runtime-owned booking state into the complete handler",
  );
});
