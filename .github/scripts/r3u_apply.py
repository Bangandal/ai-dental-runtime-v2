from pathlib import Path

p = Path("src/runtime/runtimeAgentLoopLegacy.ts")
s = p.read_text()

obsolete_imports = [
    'import { prepareBookingApplyExecution } from "./bookingApplyExecutionPreparation.ts";\n',
    'import { shouldInterceptNoSlotsBeforeBookingApply } from "./bookingApplyPreflight.ts";\n',
    'import { evaluateBookingApplyPreflight } from "./bookingApplyPreflightDecision.ts";\n',
    'import { executeRuntimeToolRequest, hasSubjectOrContactPhone } from "./runtimeToolRequestExecution.ts";\n',
    'import { executeRuntimeToolBatchKernel, completeRuntimeToolBatchWithBookingResult } from "./runtimeToolBatchKernel.ts";\n',
]

for old in obsolete_imports:
    count = s.count(old)
    if count != 1:
        raise SystemExit(f"obsolete import expected once: {old.strip()} count={count}")
    s = s.replace(old, "", 1)

for forbidden in [
    "prepareBookingApplyExecution({",
    "executeRuntimeToolBatchKernel({",
    "completeRuntimeToolBatchWithBookingResult({",
    "evaluateBookingApplyPreflight({",
    "executeRuntimeToolRequest({",
]:
    if forbidden in s:
        raise SystemExit(f"lower-level owner still present in legacy loop: {forbidden}")

if s.count("executeRuntimeTurnToolBatch({") != 2:
    raise SystemExit(f"expected two complete-batch handler calls, found {s.count('executeRuntimeTurnToolBatch({')}")

p.write_text(s)
