from pathlib import Path


def replace_once(path: str, old: str, new: str, label: str) -> None:
    p = Path(path)
    source = p.read_text()
    count = source.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match in {path}, found {count}")
    p.write_text(source.replace(old, new, 1))


def replace_count(path: str, old: str, new: str, expected: int, label: str) -> None:
    p = Path(path)
    source = p.read_text()
    count = source.count(old)
    if count != expected:
        raise SystemExit(f"{label}: expected {expected} matches in {path}, found {count}")
    p.write_text(source.replace(old, new))


# Transport correctness: current Responses API returns conversation as { id }.
replace_once(
    "src/runtime/openaiRuntimeAgentCaller.ts",
    '  const conversationId = readString(response?.conversation_id) ?? readString(response?.conversation) ?? fallbackConversationId;\n',
    '  const conversationObject = asObject(response?.conversation);\n'
    '  const conversationId =\n'
    '    readString(response?.conversation_id) ??\n'
    '    readString(conversationObject?.id) ??\n'
    '    readString(response?.conversation) ??\n'
    '    fallbackConversationId;\n',
    "Responses conversation object id",
)

# Structural ownership counts now include the bounded third same-conversation model step.
replace_once(
    "tests/r3mRuntimeModelCall.test.ts",
    '    6,\n    "main, second, two forced finalizers, and two guarded finalizers must share one transport boundary",\n',
    '    7,\n    "main, second, bounded continuation, two compatibility finalizers, and two guarded finalizers must share one transport boundary",\n',
    "R3m model-call ownership count",
)
replace_once(
    "tests/r3nModelContext.test.ts",
    '    6,\n    "all six model-call paths must compose context through one owner",\n',
    '    7,\n    "all seven model-call paths must compose context through one owner",\n',
    "R3n context ownership count",
)
replace_once(
    "tests/r3qBoundedToolBatchLoop.test.ts",
    '    loopSource.match(/bounded_tool_batch_final_response/g)?.length,\n    1,\n    "bounded continuation must have one successful terminal marker",\n',
    '    loopSource.match(/debug\\.reason = "bounded_tool_batch_final_response"/g)?.length,\n    1,\n    "bounded continuation must have one successful terminal marker",\n',
    "R3q exact terminal marker lock",
)

# booking_apply_action_truth remains available as structured truth; protocol outputs replace resolved_context.
replace_once(
    "tests/bookingApplyActivation.test.ts",
    'test("F: forced finalization path receives booking_apply_action_truth in resolved_context", async () => {\n  let forcedCallContext: Record<string, unknown> | undefined;\n',
    'test("F: bounded continuation preserves booking_apply_action_truth while resolving the second batch by protocol", async () => {\n  let boundedCallContext: Record<string, unknown> | undefined;\n  let boundedCallToolResults: unknown[] | undefined;\n',
    "booking activation test title/state",
)
replace_once(
    "tests/bookingApplyActivation.test.ts",
    '  // Forced finalization (round 3): capture context\n  pushCaller(async (input) => {\n    forcedCallContext = input.input.context as Record<string, unknown>;\n    return { type: "final_response", final_response: { final_patient_reply: "Онлайн-запись недоступна. Обратитесь к администратору." } };\n  });\n',
    '  // Bounded third model step: capture structured truth and the exact second-batch outputs.\n  pushCaller(async (input) => {\n    boundedCallContext = input.input.context as Record<string, unknown>;\n    boundedCallToolResults = input.input.tool_results as unknown[] | undefined;\n    return { type: "final_response", final_response: { final_patient_reply: "Онлайн-запись недоступна. Обратитесь к администратору." } };\n  });\n',
    "booking activation third call capture",
)
replace_once(
    "tests/bookingApplyActivation.test.ts",
    '  // Forced finalization context must contain resolved_context (tool results)\n  assert.ok(forcedCallContext, "forced finalization must be called");\n  assert.ok(Array.isArray(forcedCallContext?.resolved_context), "resolved_context must be an array of tool results");\n\n  // booking_apply_action_truth must be present in forced finalization context\n  const actionTruth = forcedCallContext?.booking_apply_action_truth as BookingApplyActionTruth | undefined;\n  assert.ok(actionTruth, "forced finalization context must contain booking_apply_action_truth");\n',
    '  assert.ok(boundedCallContext, "bounded continuation must be called");\n  assert.ok(!("resolved_context" in boundedCallContext!), "protocol-resolved second batch must not be duplicated as resolved_context");\n  assert.deepEqual(\n    (boundedCallToolResults ?? []).map((item) => (item as { call_id?: string }).call_id),\n    ["call_f2"],\n    "third model step receives exactly the pending second-batch output",\n  );\n\n  // booking_apply_action_truth remains structured business truth from the cumulative results.\n  const actionTruth = boundedCallContext?.booking_apply_action_truth as BookingApplyActionTruth | undefined;\n  assert.ok(actionTruth, "bounded continuation context must contain booking_apply_action_truth");\n',
    "booking activation protocol assertions",
)

# PR121 dirty-conversation workaround is obsolete when the second batch is actually closed.
replace_once(
    "tests/bookingContactGuard.test.ts",
    '    // forced_finalization round\n    {\n      type: "final_response",\n      conversation_id: null,\n      final_response: { final_patient_reply: FALLBACK_REPLY, safety_notes: [] },\n    },\n',
    '    // bounded third step after the second kb.search call has been resolved\n    {\n      type: "final_response",\n      conversation_id: "conv_pr121",\n      final_response: { final_patient_reply: FALLBACK_REPLY, safety_notes: [] },\n    },\n',
    "booking contact bounded final response",
)
replace_once(
    "tests/bookingContactGuard.test.ts",
    '  // forced_finalization should produce the model reply\n  assert.equal(result.final_patient_reply, FALLBACK_REPLY);\n  assert.equal(result.conversation_id, null); // dirty as expected by PR #121\n  assert.equal(result.conversation_id_resumable, false);\n',
    '  // The second batch is resolved, so the model reply can keep the conversation resumable.\n  assert.equal(result.final_patient_reply, FALLBACK_REPLY);\n  assert.equal(result.conversation_id, "conv_pr121");\n  assert.notEqual(result.conversation_id_resumable, false);\n',
    "booking contact resumability",
)

# Dirty-conversation tests now distinguish true budget exhaustion from successful bounded continuation.
replace_once(
    "tests/dirtyConversationReset.test.ts",
    '  assert.equal(result.debug?.reason, "multi_round_tool_loop_not_implemented");\n',
    '  assert.equal(result.debug?.reason, "bounded_tool_batch_budget_exhausted");\n',
    "dirty budget reason",
)
replace_once(
    "tests/dirtyConversationReset.test.ts",
    'test("forced finalization success path also marks conversation non-resumable", async () => {\n',
    'test("bounded continuation success keeps the fully resolved conversation resumable", async () => {\n',
    "dirty success title",
)
replace_once(
    "tests/dirtyConversationReset.test.ts",
    '    return { type: "final_response", final_response: { final_patient_reply: "Fresh answer." }, conversation_id: "conv_fresh_throwaway" };\n',
    '    return { type: "final_response", final_response: { final_patient_reply: "Fresh answer." }, conversation_id: "conv_r2" };\n',
    "dirty success conversation",
)
replace_once(
    "tests/dirtyConversationReset.test.ts",
    '  assert.equal(result.debug?.reason, "forced_finalization_after_tool_results");\n  assert.equal(result.final_patient_reply, "Fresh answer.");\n  assert.equal(result.conversation_id, null);\n  assert.equal(result.conversation_id_resumable, false);\n',
    '  assert.equal(result.debug?.reason, "bounded_tool_batch_final_response");\n  assert.equal(result.final_patient_reply, "Fresh answer.");\n  assert.equal(result.conversation_id, "conv_r2");\n  assert.notEqual(result.conversation_id_resumable, false);\n',
    "dirty bounded success assertions",
)

# Malformed final step remains fail-closed/localized, but it is no longer a fresh forced call.
replace_once(
    "tests/malformedResponseHandling.test.ts",
    'test("E: forced finalization malformed does not leak English fallback", async () => {\n',
    'test("E: malformed bounded final response does not leak English fallback", async () => {\n',
    "malformed bounded title",
)
replace_once(
    "tests/malformedResponseHandling.test.ts",
    '      // Round 2 requests more tools than we can execute -> triggers forced finalization (round 3).\n',
    '      // Round 2 requests another non-write tool; Runtime executes it before the bounded third model step.\n',
    "malformed bounded comment",
)
replace_once(
    "tests/malformedResponseHandling.test.ts",
    '  assert.equal((result.debug as any).reason, "malformed_forced_finalization_fallback");\n',
    '  assert.equal((result.debug as any).reason, "malformed_bounded_tool_batch_final_response");\n',
    "malformed bounded reason",
)

# Real OpenAI caller test: function_call_output in the same conversation is now the required protocol.
replace_once(
    "tests/openaiRuntimeAgentCaller.test.ts",
    'import { createOpenAIRuntimeAgentCaller, buildOpenAIToolDefinitions, buildOpenAIInput } from "../src/runtime/openaiRuntimeAgentCaller.ts";\n',
    'import { createOpenAIRuntimeAgentCaller, buildOpenAIToolDefinitions, buildOpenAIInput, normalizeOpenAIResponse } from "../src/runtime/openaiRuntimeAgentCaller.ts";\n',
    "caller normalize import",
)
replace_once(
    "tests/openaiRuntimeAgentCaller.test.ts",
    'test("forced finalization path: real caller is protocol-safe — no function_call_output, null conversation, resolved_context present", async () => {\n',
    'test("bounded continuation path: real caller closes the pending function call in the same conversation", async () => {\n',
    "real caller bounded title",
)
replace_once(
    "tests/openaiRuntimeAgentCaller.test.ts",
    '          // call 3: forced finalization — verify full OpenAI protocol safety\n          assert.equal(tools.length, 0, "forced finalization must send no tools");\n\n          // No function_call_output: would violate protocol — round-2 call_ids differ from round-1\n          const inputMessages = payload.input as Array<Record<string, unknown>>;\n          const functionOutputs = inputMessages.filter((m) => m.type === "function_call_output");\n          assert.equal(functionOutputs.length, 0, "forced finalization must not send function_call_output (protocol violation)");\n\n          // Fresh conversation: null conversation_id → buildOpenAIInput sends conversation: undefined\n          assert.equal(payload.conversation, undefined, "forced finalization must not continue conversation with pending round-2 calls");\n\n          // Tool results must be in plain JSON context, not as protocol messages\n          const userMsg = inputMessages[0];\n          const contentText = ((userMsg?.content as Array<Record<string, unknown>>)?.[0] as Record<string, unknown>)?.text as string;\n          const parsedPayload = JSON.parse(contentText ?? "{}");\n          assert.ok(\n            "resolved_context" in (parsedPayload.context ?? {}),\n            "forced finalization must embed tool results as resolved_context in plain JSON context",\n          );\n\n          return { output_text: "Hours are 9–17.", conversation_id: "conv_finalization_new" };\n',
    '          // call 3: resolve the pending round-2 function call in the same conversation.\n          assert.equal(tools.length, 0, "bounded final model step must send no tools");\n\n          const inputMessages = payload.input as Array<Record<string, unknown>>;\n          const functionOutputs = inputMessages.filter((m) => m.type === "function_call_output");\n          assert.equal(functionOutputs.length, 1, "pending round-2 function call must receive exactly one output");\n          assert.equal(functionOutputs[0]?.call_id, "c2");\n          assert.equal(payload.conversation, "conv_x", "bounded continuation must stay in the active conversation");\n\n          const userMsg = inputMessages[0];\n          const contentText = ((userMsg?.content as Array<Record<string, unknown>>)?.[0] as Record<string, unknown>)?.text as string;\n          const parsedPayload = JSON.parse(contentText ?? "{}");\n          assert.ok(\n            !("resolved_context" in (parsedPayload.context ?? {})),\n            "protocol outputs must not be duplicated into resolved_context",\n          );\n\n          return { output_text: "Hours are 9–17.", conversation: { id: "conv_x" } };\n',
    "real caller third-step protocol",
)
replace_once(
    "tests/openaiRuntimeAgentCaller.test.ts",
    '  assert.equal(callCount, 3, "must be exactly 3 LLM calls");\n  assert.equal(result.final_patient_reply, "Hours are 9–17.");\n  assert.equal(result.debug?.reason, "forced_finalization_after_tool_results");\n  // PR #121: the rounds-1-2 conversation has a pending, never-resolved round-2 function_call\n  // (that\'s *why* forced finalization ran) — resuming it later 400s upstream. It must not be\n  // returned as resumable, regardless of whether it came from rounds 1-2 or the fresh call.\n  assert.equal(result.conversation_id, null, "dirty rounds-1-2 conversation must not be returned as resumable");\n  assert.equal(result.conversation_id_resumable, false);\n});\n',
    '  assert.equal(callCount, 3, "must be exactly 3 LLM calls");\n  assert.equal(result.final_patient_reply, "Hours are 9–17.");\n  assert.equal(result.debug?.reason, "bounded_tool_batch_final_response");\n  assert.equal(result.conversation_id, "conv_x", "all pending function calls were resolved in the active conversation");\n  assert.notEqual(result.conversation_id_resumable, false);\n});\n\n' 
    'test("normalizeOpenAIResponse reads current Responses API conversation object id", () => {\n'
    '  const result = normalizeOpenAIResponse({ output_text: "ok", conversation: { id: "conv_object" } }, null);\n'
    '  assert.equal(result.conversation_id, "conv_object");\n'
    '});\n',
    "real caller final assertions and conversation object regression",
)

# runtimeAgentLoop legacy-characterization tests become bounded-loop contract tests.
replace_count(
    "tests/runtimeAgentLoop.test.ts",
    '"multi_round_tool_loop_not_implemented"',
    '"bounded_tool_batch_budget_exhausted"',
    6,
    "runtime loop budget reason migrations",
)
replace_count(
    "tests/runtimeAgentLoop.test.ts",
    '"forced_finalization_after_tool_results"',
    '"bounded_tool_batch_final_response"',
    2,
    "runtime loop bounded success reason migrations",
)
replace_once(
    "tests/runtimeAgentLoop.test.ts",
    'test("multi-round tool loop is not implemented", async () => {\n',
    'test("bounded tool loop fails closed when the third model step still requests tools", async () => {\n',
    "runtime loop budget title",
)
replace_once(
    "tests/runtimeAgentLoop.test.ts",
    'test("M1: kb.search with non-empty chunks triggers forced finalization, not generic fallback", async () => {\n',
    'test("M1: second kb.search batch executes before bounded final response", async () => {\n',
    "M1 bounded success title",
)
replace_once(
    "tests/runtimeAgentLoop.test.ts",
    'test("M1: forced finalization does not trigger a fourth tool call", async () => {\n',
    'test("M1: bounded loop executes two tool batches and never creates a fourth model call", async () => {\n',
    "M1 tool budget title",
)
replace_once(
    "tests/runtimeAgentLoop.test.ts",
    '  assert.equal(toolCallCount, 1, "tool executor runs only once — forced finalization skips tool execution");\n',
    '  assert.equal(toolCallCount, 2, "both model-requested tool batches must execute before the bounded final step");\n',
    "M1 tool execution count",
)
replace_once(
    "tests/runtimeAgentLoop.test.ts",
    '  assert.equal(c, 2, "only 2 caller invocations — no forced finalization when tool failed");\n',
    '  assert.equal(c, 3, "failed second-batch output is still returned to one bounded final model step");\n',
    "failed tool bounded call count",
)
replace_once(
    "tests/runtimeAgentLoop.test.ts",
    'test("M1: forced finalization call is protocol-safe — no tool_results, null conversation_id, resolved_context in context", async () => {\n',
    'test("M1: bounded third call is protocol-safe — second-batch tool_results in the active conversation", async () => {\n',
    "M1 protocol title",
)
replace_once(
    "tests/runtimeAgentLoop.test.ts",
    '  // No function_call_output: tool_results must be absent\n  assert.equal(round3Input!.input.tool_results, undefined, "round 3 must not pass tool_results (no function_call_output)");\n  // Fresh context: no conversation with pending round-2 tool calls\n  assert.equal(round3Input!.conversation_id, null, "round 3 must use null conversation_id (fresh context)");\n  // No tool definitions: model cannot request tools\n  assert.equal(round3Input!.input.tool_definitions, undefined, "round 3 must have no tool_definitions");\n  // Tool results embedded as plain JSON, not as protocol messages\n  assert.ok(\n    round3Input!.input.context != null && "resolved_context" in round3Input!.input.context,\n    "round 3 must embed tool results as resolved_context in plain JSON context",\n  );\n  const resolved = (round3Input!.input.context as Record<string, unknown>).resolved_context as unknown[];\n  assert.ok(Array.isArray(resolved) && resolved.length > 0, "resolved_context must contain round-1 tool results");\n',
    '  assert.deepEqual(\n    round3Input!.input.tool_results?.map((item) => item.call_id),\n    ["c2"],\n    "round 3 must resolve exactly the pending second-batch call",\n  );\n  assert.equal(round3Input!.conversation_id, "conv_main", "round 3 must continue the active conversation");\n  assert.equal(round3Input!.input.tool_definitions, undefined, "round 3 must have no tool_definitions");\n  assert.ok(\n    round3Input!.input.context != null && !("resolved_context" in round3Input!.input.context),\n    "protocol-resolved second-batch outputs must not be duplicated as resolved_context",\n  );\n',
    "M1 protocol assertions",
)
replace_once(
    "tests/runtimeAgentLoop.test.ts",
    'test("M1: forced finalization does not update conversationId with fresh-call conversation", async () => {\n',
    'test("M1: bounded final response keeps the resolved active conversation resumable", async () => {\n',
    "M1 conversation title",
)
replace_once(
    "tests/runtimeAgentLoop.test.ts",
    '    // Forced finalization opens a fresh conversation — must not leak this ID into result\n    return { type: "final_response", final_response: { final_patient_reply: "Answer" }, conversation_id: "conv_finalization_fresh" };\n',
    '    return { type: "final_response", final_response: { final_patient_reply: "Answer" }, conversation_id: "conv_r2" };\n',
    "M1 bounded conversation mock",
)
replace_once(
    "tests/runtimeAgentLoop.test.ts",
    '  // PR #121: conv_r2 has a pending, never-resolved round-2 function_call — resuming it later\n  // 400s upstream ("No tool output found for function call ..."). It must not be returned as\n  // resumable, and the fresh finalization conversation must not leak into the result either.\n  assert.equal(result.conversation_id, null, "dirty rounds-1-2 conversation must not be returned as resumable");\n  assert.equal(result.conversation_id_resumable, false);\n  assert.notEqual(result.conversation_id, "conv_finalization_fresh", "forced finalization conversation_id must not leak into result");\n',
    '  assert.equal(result.conversation_id, "conv_r2", "resolved second-batch conversation remains active");\n  assert.notEqual(result.conversation_id_resumable, false);\n',
    "M1 bounded conversation assertions",
)

print("R3q protocol/test migration applied")
