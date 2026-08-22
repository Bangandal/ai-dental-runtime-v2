from pathlib import Path

# 1) Remove dead direct finalization helpers and their now-unused imports.
p = Path("src/runtime/runtimeAgentLoopLegacy.ts")
s = p.read_text()

import_replacements = [
    ('  RUNTIME_AGENT_TOOL_DEFINITIONS,\n', '', 'tool definitions import member'),
    ('  type BookingApplyResolution,\n', '', 'booking resolution import member'),
    ('  type RuntimeAgentToolRequest,\n', '', 'tool request import member'),
    ('import type { SubjectId, BookingSubjectsState } from "./bookingSubjectsState.ts";\n', '', 'booking subject import'),
    ('import { buildModelVisibleCallerContext, composeRuntimeModelContext } from "./modelVisibleCallerContext.ts";\n',
     'import { buildModelVisibleCallerContext } from "./modelVisibleCallerContext.ts";\n',
     'model context import'),
    ('import { buildBookingApplyActionTruth, buildBookingApplyEmergencyFallback } from "./bookingApplyGuard.ts";\n',
     'import { buildBookingApplyEmergencyFallback } from "./bookingApplyGuard.ts";\n',
     'booking truth import'),
    ('import { invokeRuntimeModelCall, type RuntimeAgentCaller, type RuntimeAgentCallerInput, type RuntimeAgentCallerOutput } from "./runtimeModelCall.ts";\n',
     'import type { RuntimeAgentCaller, RuntimeAgentCallerInput, RuntimeAgentCallerOutput } from "./runtimeModelCall.ts";\n',
     'runtime model call import'),
]
for old, new, label in import_replacements:
    count = s.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, found {count}")
    s = s.replace(old, new, 1)

start_marker = '// ── Multiple-blocked booking.apply helper (Variant A) ────────────────────────\n'
end_marker = '// Returns true when at least one tool result has status=success with non-empty\n'
start = s.find(start_marker)
end = s.find(end_marker, start)
if start < 0 or end < 0:
    raise SystemExit(f"dead finalizer markers not found start={start} end={end}")
if s.find(start_marker, start + 1) >= 0:
    raise SystemExit("dead finalizer start marker is not unique")

# The tiny data shape remains useful to the deterministic UI adapter below. Keep the type,
# remove only the two dead model-call helpers and their compatibility transport plumbing.
kept_type = '''export interface GuardedBookingApplyData {\n  booking_status: string;\n  created_visit: false;\n  may_claim_booked: false;\n  required_next_action: string;\n  reason: string;\n  missing_fields?: string[];\n}\n\n'''
s = s[:start] + kept_type + s[end:]

for forbidden in [
    'finalizeBlockedMultipleBookingApplies',
    'finalizeBlockedBookingApplyWithToolOutput',
    'invokeRuntimeModelCall({',
    'composeRuntimeModelContext(',
    'guarded_multiple_booking_caller_failed',
    'guarded_booking_apply_caller_failed',
]:
    if forbidden in s:
        raise SystemExit(f"legacy direct finalization path still present: {forbidden}")

p.write_text(s)

# 2) Transport ownership lock: after R3w the legacy shell has zero direct model-call paths.
p = Path("tests/r3mRuntimeModelCall.test.ts")
s = p.read_text()
marker = 'test("R3v structure: bounded iterator owns main model transport while terminal helpers retain canonical boundary"'
if s.count(marker) != 1:
    raise SystemExit(f"R3m structural marker count={s.count(marker)}")
start = s.index(marker)
if not s[start:].rstrip().endswith('});'):
    raise SystemExit("R3m structural test must be final test")
replacement = r'''test("R3w structure: bounded iterator is the only runtime model transport owner", async () => {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const loopSource = await readFile(resolve(thisDir, "../src/runtime/runtimeAgentLoopLegacy.ts"), "utf8");
  const iteratorSource = await readFile(resolve(thisDir, "../src/runtime/runtimeBoundedModelToolLoop.ts"), "utf8");
  const orchestratorSource = await readFile(resolve(thisDir, "../src/runtime/runtimeTurnModelToolOrchestrator.ts"), "utf8");

  assert.equal(loopSource.match(/invokeRuntimeModelIteration\(\{/g)?.length ?? 0, 0);
  assert.equal(
    loopSource.match(/invokeRuntimeModelCall\(\{/g)?.length ?? 0,
    0,
    "legacy shell must contain no compatibility-only direct model calls",
  );
  assert.equal(
    loopSource.match(/runRuntimeTurnModelToolOrchestration\(\{/g)?.length,
    1,
    "legacy shell must delegate the whole model/tool sequence to one orchestrator",
  );
  assert.equal(
    iteratorSource.match(/invokeRuntimeModelIteration\(\{/g)?.length,
    1,
    "generic bounded iterator must be the single iteration transport owner",
  );
  assert.match(orchestratorSource, /runRuntimeBoundedModelToolLoop\(\{/);
  assert.doesNotMatch(loopSource, /finalizeBlockedMultipleBookingApplies/);
  assert.doesNotMatch(loopSource, /finalizeBlockedBookingApplyWithToolOutput/);
  assert.doesNotMatch(loopSource, /await deps\.caller\(/);
  assert.match(loopSource, /export type \{ RuntimeAgentCaller, RuntimeAgentCallerInput, RuntimeAgentCallerOutput \} from ["']\.\/runtimeModelCall\.ts["']/);
});'''
p.write_text(s[:start] + replacement + '\n')

# 3) Context ownership lock: after R3w legacy shell contains no direct model context composition.
p = Path("tests/r3nModelContext.test.ts")
s = p.read_text()
marker = 'test("R3v structure: roundless projection owns main model context composition"'
if s.count(marker) != 1:
    raise SystemExit(f"R3n structural marker count={s.count(marker)}")
start = s.index(marker)
if not s[start:].rstrip().endswith('});'):
    raise SystemExit("R3n structural test must be final test")
replacement = r'''test("R3w structure: roundless projection is the only runtime model-context owner", async () => {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const loopSource = await readFile(resolve(thisDir, "../src/runtime/runtimeAgentLoopLegacy.ts"), "utf8");
  const projectionSource = await readFile(resolve(thisDir, "../src/runtime/runtimeTurnModelContext.ts"), "utf8");

  assert.equal(
    loopSource.match(/composeRuntimeModelContext\(/g)?.length ?? 0,
    0,
    "legacy shell must contain no compatibility-only model context composition",
  );
  assert.equal(
    projectionSource.match(/composeRuntimeModelContext\(/g)?.length,
    1,
    "all main iteration context must be projected through one round-agnostic owner",
  );
  assert.doesNotMatch(loopSource, /finalizeBlockedMultipleBookingApplies/);
  assert.doesNotMatch(loopSource, /finalizeBlockedBookingApplyWithToolOutput/);
  assert.doesNotMatch(projectionSource, /firstCall|secondCall|round1|round2/);
});'''
p.write_text(s[:start] + replacement + '\n')
