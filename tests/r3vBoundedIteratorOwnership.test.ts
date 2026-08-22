import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

test("R3v structure target: bounded iterator owns model/tool transport sequencing", async () => {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const iteratorSource = await readFile(resolve(thisDir, "../src/runtime/runtimeBoundedModelToolLoop.ts"), "utf8");
  const projectionSource = await readFile(resolve(thisDir, "../src/runtime/runtimeTurnModelContext.ts"), "utf8");

  assert.equal(iteratorSource.match(/invokeRuntimeModelIteration\(\{/g)?.length, 1);
  assert.match(iteratorSource, /while \(true\)/);
  // Transport owns tool availability. Legacy still respects frame.allow_tools; the opt-in
  // agent-first pilot may continue after a recoverable guard while the hard budget remains.
  assert.match(iteratorSource, /toolsEnabledForCall = \(agentFirst \|\| frame\.allow_tools\) && hasFutureModelCall/);
  assert.match(iteratorSource, /if \(!frame\.allow_tools && !agentFirst\)/);
  assert.match(iteratorSource, /execute_batch/);
  assert.doesNotMatch(iteratorSource, /booking\.apply|availability\.check|booking\.select_slot/);
  assert.match(projectionSource, /buildRuntimeTurnModelProjection/);
  assert.doesNotMatch(projectionSource, /firstCall|secondCall|round1|round2/);
});
