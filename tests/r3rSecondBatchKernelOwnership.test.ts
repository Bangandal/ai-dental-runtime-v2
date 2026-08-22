import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

test("R3v structure: all executable model tool batches share one roundless complete-batch path", async () => {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const loopSource = await readFile(resolve(thisDir, "../src/runtime/runtimeAgentLoopLegacy.ts"), "utf8");
  const orchestratorSource = await readFile(resolve(thisDir, "../src/runtime/runtimeTurnModelToolOrchestrator.ts"), "utf8");
  const handlerSource = await readFile(resolve(thisDir, "../src/runtime/runtimeTurnToolBatch.ts"), "utf8");

  assert.equal(
    loopSource.match(/runRuntimeTurnModelToolOrchestration\(\{/g)?.length,
    1,
    "legacy shell must expose one roundless model/tool orchestration entry",
  );
  assert.doesNotMatch(loopSource, /executeRuntimeTurnToolBatch\(/);
  assert.doesNotMatch(loopSource, /executeRuntimeToolBatchKernel\(/);
  assert.doesNotMatch(loopSource, /executeRuntimeNonWriteToolBatch/);
  assert.equal(
    orchestratorSource.match(/executeRuntimeTurnToolBatch\(\{/g)?.length,
    1,
    "every executable iterator batch must enter the same complete batch callback",
  );
  assert.equal(
    handlerSource.match(/executeRuntimeToolBatchKernel\(\{/g)?.length,
    1,
    "complete handler must retain one deterministic state-kernel owner",
  );
});
