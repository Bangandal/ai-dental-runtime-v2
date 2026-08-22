import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

test("R3w structure: legacy shell contains no alternate direct model finalization path", async () => {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const loopSource = await readFile(resolve(thisDir, "../src/runtime/runtimeAgentLoopLegacy.ts"), "utf8");
  const iteratorSource = await readFile(resolve(thisDir, "../src/runtime/runtimeBoundedModelToolLoop.ts"), "utf8");

  assert.doesNotMatch(loopSource, /finalizeBlockedMultipleBookingApplies/);
  assert.doesNotMatch(loopSource, /finalizeBlockedBookingApplyWithToolOutput/);
  assert.equal(
    loopSource.match(/invokeRuntimeModelCall\(\{/g)?.length ?? 0,
    0,
    "legacy shell must not retain a second model transport path outside the bounded iterator",
  );
  assert.equal(
    loopSource.match(/composeRuntimeModelContext\(/g)?.length ?? 0,
    0,
    "legacy shell must not retain compatibility-only model context composition",
  );
  assert.equal(
    iteratorSource.match(/invokeRuntimeModelIteration\(\{/g)?.length,
    1,
    "bounded iterator remains the sole main model iteration owner",
  );
});
