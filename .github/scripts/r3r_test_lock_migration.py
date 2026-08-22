from pathlib import Path


def replace_once(path: str, old: str, new: str, label: str) -> None:
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one match in {path}, found {count}")
    p.write_text(text.replace(old, new, 1))

replace_once(
    "tests/bookingContactGuard.test.ts",
    '''  // Conversation still dirty (round-2 had pending tool call)\n  assert.equal(result.conversation_id, null);\n  assert.equal(result.conversation_id_resumable, false);''',
    '''  // R3r closes the round-2 booking call with function_call_output before the final\n  // model step. This caller returns no conversation id, but the protocol is no longer dirty.\n  assert.equal(result.conversation_id, null);\n  assert.notEqual(result.conversation_id_resumable, false);''',
    "trusted-booking clean conversation",
)

replace_once(
    "tests/r3mRuntimeModelCall.test.ts",
    '''    7,\n    "main, second, bounded continuation, two compatibility finalizers, and two guarded finalizers must share one transport boundary",''',
    '''    5,\n    "main, second, unified bounded continuation, and two guarded compatibility finalizers must share one transport boundary",''',
    "R3m model-call count",
)

replace_once(
    "tests/r3nModelContext.test.ts",
    '''    7,\n    "all seven model-call paths must compose context through one owner",''',
    '''    5,\n    "all five remaining model-call paths must compose context through one owner",''',
    "R3n context count",
)

old_r3k = '''test("R3k structure: legacy loop delegates normal selection and same-batch conflicts to shared helpers", async () => {\n  const thisDir = dirname(fileURLToPath(import.meta.url));\n  const loopSource = await readFile(resolve(thisDir, "../src/runtime/runtimeAgentLoopLegacy.ts"), "utf8");\n\n  assert.match(loopSource, /import \\{ executeBookingSelectSlotBatch \\} from ["']\\.\\/bookingSelectSlot\\.ts["']/);\n  assert.match(loopSource, /import \\{ resolveBookingSelectApplyBatchConflict \\} from ["']\\.\\/bookingSelectApplyBatchConflict\\.ts["']/);\n  assert.equal(\n    loopSource.match(/executeBookingSelectSlotBatch\\(\\{/g)?.length,\n    2,\n    "first and later normal selection paths must share one selector",\n  );\n  assert.equal(\n    loopSource.match(/resolveBookingSelectApplyBatchConflict\\(\\{/g)?.length,\n    2,\n    "first and later select+apply conflict paths must share one batch-content guard",\n  );\n  assert.doesNotMatch(loopSource, /executeBookingSelectSlot\\(/);\n  assert.doesNotMatch(loopSource, /BookingSelectSlotSuccessData/);\n  assert.doesNotMatch(loopSource, /selectSlotAmbiguous/);\n  assert.doesNotMatch(loopSource, /selectSlotRequestCount/);\n});'''
new_r3k = '''test("R3k structure: first batch and shared batch kernel delegate selection/conflicts to canonical helpers", async () => {\n  const thisDir = dirname(fileURLToPath(import.meta.url));\n  const loopSource = await readFile(resolve(thisDir, "../src/runtime/runtimeAgentLoopLegacy.ts"), "utf8");\n  const kernelSource = await readFile(resolve(thisDir, "../src/runtime/runtimeToolBatchKernel.ts"), "utf8");\n\n  assert.equal(loopSource.match(/executeBookingSelectSlotBatch\\(\\{/g)?.length, 1);\n  assert.equal(kernelSource.match(/executeBookingSelectSlotBatch\\(\\{/g)?.length, 1);\n  assert.equal(loopSource.match(/resolveBookingSelectApplyBatchConflict\\(\\{/g)?.length, 1);\n  assert.equal(kernelSource.match(/resolveBookingSelectApplyBatchConflict\\(\\{/g)?.length, 1);\n  assert.doesNotMatch(loopSource, /executeBookingSelectSlot\\(/);\n  assert.doesNotMatch(loopSource, /BookingSelectSlotSuccessData/);\n  assert.doesNotMatch(loopSource, /selectSlotAmbiguous/);\n  assert.doesNotMatch(loopSource, /selectSlotRequestCount/);\n});'''
replace_once("tests/r3kSelectSlotBatchOwnership.test.ts", old_r3k, new_r3k, "R3k ownership")

old_r3p = '''test("R3p structure: legacy loop delegates same-batch select/apply conflict in both tool phases", async () => {\n  const thisDir = dirname(fileURLToPath(import.meta.url));\n  const loopSource = await readFile(resolve(thisDir, "../src/runtime/runtimeAgentLoopLegacy.ts"), "utf8");\n\n  assert.equal(\n    loopSource.match(/resolveBookingSelectApplyBatchConflict\\(\\{/g)?.length,\n    2,\n    "both current tool-batch paths must use the same content-based protocol guard",\n  );\n  assert.doesNotMatch(loopSource, /guard_s_same_round_protocol/);\n  assert.doesNotMatch(loopSource, /Tool was not executed because booking\\.select_slot and booking\\.apply/);\n});'''
new_r3p = '''test("R3p structure: first batch and shared batch kernel use the same select/apply conflict owner", async () => {\n  const thisDir = dirname(fileURLToPath(import.meta.url));\n  const loopSource = await readFile(resolve(thisDir, "../src/runtime/runtimeAgentLoopLegacy.ts"), "utf8");\n  const kernelSource = await readFile(resolve(thisDir, "../src/runtime/runtimeToolBatchKernel.ts"), "utf8");\n\n  assert.equal(loopSource.match(/resolveBookingSelectApplyBatchConflict\\(\\{/g)?.length, 1);\n  assert.equal(kernelSource.match(/resolveBookingSelectApplyBatchConflict\\(\\{/g)?.length, 1);\n  assert.doesNotMatch(loopSource, /guard_s_same_round_protocol/);\n  assert.doesNotMatch(loopSource, /Tool was not executed because booking\\.select_slot and booking\\.apply/);\n});'''
replace_once("tests/r3pBookingSelectApplyBatchConflict.test.ts", old_r3p, new_r3p, "R3p ownership")

old_r3q = '''test("R3q structure: second non-write batch has one executor and one bounded continuation path", async () => {\n  const thisDir = dirname(fileURLToPath(import.meta.url));\n  const loopSource = await readFile(resolve(thisDir, "../src/runtime/runtimeAgentLoopLegacy.ts"), "utf8");\n\n  assert.match(loopSource, /import \\{ executeRuntimeNonWriteToolBatch \\} from ["']\\.\\/runtimeNonWriteToolBatch\\.ts["']/);\n  assert.equal(\n    loopSource.match(/executeRuntimeNonWriteToolBatch\\(\\{/g)?.length,\n    1,\n    "later non-write batches must have one execution owner",\n  );\n  assert.equal(\n    loopSource.match(/debug\\.reason = "bounded_tool_batch_final_response"/g)?.length,\n    1,\n    "bounded continuation must have one successful terminal marker",\n  );\n  assert.match(loopSource, /tool_results: round2ToolResults/);\n  assert.match(loopSource, /conversation_id: conversationId/);\n});'''
new_r3q = '''test("R3q structure: bounded continuation is now fed by the shared second-batch kernel", async () => {\n  const thisDir = dirname(fileURLToPath(import.meta.url));\n  const loopSource = await readFile(resolve(thisDir, "../src/runtime/runtimeAgentLoopLegacy.ts"), "utf8");\n  const kernelSource = await readFile(resolve(thisDir, "../src/runtime/runtimeToolBatchKernel.ts"), "utf8");\n\n  assert.match(loopSource, /import \\{ executeRuntimeToolBatchKernel \\} from ["']\\.\\/runtimeToolBatchKernel\\.ts["']/);\n  assert.doesNotMatch(loopSource, /executeRuntimeNonWriteToolBatch/);\n  assert.match(kernelSource, /import \\{ executeRuntimeNonWriteToolBatch \\} from ["']\\.\\/runtimeNonWriteToolBatch\\.ts["']/);\n  assert.equal(kernelSource.match(/executeRuntimeNonWriteToolBatch\\(\\{/g)?.length, 1);\n  assert.match(loopSource, /let terminalReason = "bounded_tool_batch_final_response"/);\n  assert.match(loopSource, /tool_results: resolvedRound2Results/);\n  assert.match(loopSource, /conversation_id: conversationId/);\n});'''
replace_once("tests/r3qBoundedToolBatchLoop.test.ts", old_r3q, new_r3q, "R3q ownership")

print("R3r test/structural locks migrated")
