/**
 * PR #118 — harden malformed OpenAI response handling in multi-turn booking flow.
 *
 * Production smoke found that when openaiRuntimeAgentCaller.normalizeOpenAIResponse
 * cannot parse a model response, it synthesizes a "final_response" tagged with
 * safety_notes: ["malformed_openai_response"] instead of throwing. Because it's not
 * thrown, runtimeAgentLoop previously treated it as a normal final answer and leaked
 * the hardcoded English SAFE_FALLBACK_REPLY to RU/CZ patients, bypassing the
 * booking-specific emergency fallback from PR #116.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  createRuntimeAgentLoop,
  isMalformedFinalResponse,
  buildMalformedResponseFallback,
  type RuntimeAgentCaller,
  type RuntimeAgentCallerOutput,
} from "../src/runtime/runtimeAgentLoop.ts";
import type { ToolExecutorRegistry } from "../src/runtime/toolExecutor.ts";
import type { ConversationMemoryRepository } from "../src/runtime/runtimeRepositories.ts";

const MALFORMED_MARKER = ["malformed_openai_response"];

function malformedOutput(): RuntimeAgentCallerOutput {
  return {
    type: "final_response",
    final_response: {
      final_patient_reply: "Sorry, I’m having trouble processing that right now. Please try again in a moment.",
      safety_notes: MALFORMED_MARKER,
    },
  };
}

function makeInput(locale: string | null) {
  return {
    clinic_id: "clinic_1",
    contact_id: "contact_1",
    case_id: "case_1",
    user_message: "test",
    locale,
    truth_snapshot: { scheduling_intent_present: true, date_or_time_present: true },
    // Trusted phone required so the round-1 global phone preflight (PR #133) does not
    // intercept before the executor runs.  These tests exercise post-execution paths
    // (malformed responses, emergency fallbacks) that need booking.apply to execute.
    channel_contact: { phone_number: "+420600111222", phone_source: "telegram_contact_button" } as const,
  };
}

// ── isMalformedFinalResponse helper ─────────────────────────────────────────

test("isMalformedFinalResponse is true only for tagged final_response", () => {
  assert.equal(isMalformedFinalResponse(malformedOutput()), true);
  assert.equal(
    isMalformedFinalResponse({ type: "final_response", final_response: { final_patient_reply: "hi" } }),
    false,
  );
  assert.equal(isMalformedFinalResponse({ type: "tool_requests", tool_requests: [] }), false);
});

test("buildMalformedResponseFallback is locale-aware", () => {
  assert.match(buildMalformedResponseFallback("ru"), /клиник/i);
  assert.match(buildMalformedResponseFallback("cs"), /kontaktujte kliniku/i);
  assert.match(buildMalformedResponseFallback("en"), /having trouble/i);
  assert.match(buildMalformedResponseFallback(null), /клиник/i); // default RU
});

// ── A/B: first-call malformed ───────────────────────────────────────────────

test("A: first call malformed in RU locale returns RU fallback, not English", async () => {
  const caller: RuntimeAgentCaller = async () => malformedOutput();
  const agent = createRuntimeAgentLoop({ model: "gpt-test", caller, executors: {} });
  const result = await agent.runTurn(makeInput("ru"));

  assert.doesNotMatch(result.final_patient_reply, /having trouble/i);
  assert.match(result.final_patient_reply, /клиник/i);
  assert.equal((result.debug as any).reason, "malformed_first_model_response");
  assert.deepEqual(result.tool_requests, []);
  assert.deepEqual(result.tool_results, []);
});

test("B: first call malformed in CS locale returns CS fallback", async () => {
  const caller: RuntimeAgentCaller = async () => malformedOutput();
  const agent = createRuntimeAgentLoop({ model: "gpt-test", caller, executors: {} });
  const result = await agent.runTurn(makeInput("cs"));

  assert.doesNotMatch(result.final_patient_reply, /having trouble/i);
  assert.match(result.final_patient_reply, /kontaktujte kliniku/i);
});

// ── Codex P2: conversation memory must be saved on malformed early returns ──

function makeMemorySpy(): { repo: ConversationMemoryRepository; saveCalls: unknown[] } {
  const saveCalls: unknown[] = [];
  const repo: ConversationMemoryRepository = {
    async getConversationMemory() {
      return { ok: true, data: { conversation_id: null } };
    },
    async saveConversationMemory(input) {
      saveCalls.push(input);
      return { ok: true, data: { conversation_id: input.conversation_id } };
    },
  };
  return { repo, saveCalls };
}

test("Codex-P2-A: first-call malformed with conversation_id from caller persists memory once", async () => {
  const caller: RuntimeAgentCaller = async () => ({
    type: "final_response",
    conversation_id: "conv_from_caller",
    final_response: { final_patient_reply: "irrelevant", safety_notes: MALFORMED_MARKER },
  });
  const { repo, saveCalls } = makeMemorySpy();
  const agent = createRuntimeAgentLoop({ model: "gpt-test", caller, executors: {}, conversationMemoryRepository: repo });
  const result = await agent.runTurn(makeInput("ru"));

  assert.equal(saveCalls.length, 1);
  assert.equal((saveCalls[0] as any).conversation_id, "conv_from_caller");
  assert.equal(result.conversation_id, "conv_from_caller");
  assert.equal((result.debug as any).reason, "malformed_first_model_response");
});

test("Codex-P2-B: second-call malformed with conversation_id from caller persists memory once", async () => {
  let round = 0;
  const caller: RuntimeAgentCaller = async () => {
    round += 1;
    if (round === 1) {
      return {
        type: "tool_requests",
        tool_requests: [{ tool: "booking.apply", call_id: "c1", arguments: { first_name: "Ivan", last_name: "Petrov", service: "чистка", requested_date: "2026-07-20", requested_time: "10:00" } }],
      };
    }
    return { ...malformedOutput(), conversation_id: "conv_from_second_call" };
  };
  const { repo, saveCalls } = makeMemorySpy();
  const agent = createRuntimeAgentLoop({
    model: "gpt-test",
    caller,
    executors: bookingApplyExecutors("booking_write_disabled"),
    conversationMemoryRepository: repo,
  });
  const result = await agent.runTurn(makeInput("ru"));

  assert.equal(saveCalls.length, 1);
  assert.equal((saveCalls[0] as any).conversation_id, "conv_from_second_call");
  assert.equal(result.conversation_id, "conv_from_second_call");
  assert.equal((result.debug as any).reason, "malformed_second_model_response_booking_fallback");
});

test("Codex-P2-C: no conversation_id at all -> save is not called, behavior stays safe", async () => {
  const caller: RuntimeAgentCaller = async () => malformedOutput();
  const { repo, saveCalls } = makeMemorySpy();
  const agent = createRuntimeAgentLoop({ model: "gpt-test", caller, executors: {}, conversationMemoryRepository: repo });
  const result = await agent.runTurn(makeInput("ru"));

  assert.equal(saveCalls.length, 0);
  assert.equal(result.conversation_id, null);
  assert.doesNotMatch(result.final_patient_reply, /having trouble/i);
});

test("Codex-P2-D: debug reasons unaffected by the memory-save fix", async () => {
  const firstCaller: RuntimeAgentCaller = async () => malformedOutput();
  const firstResult = await createRuntimeAgentLoop({ model: "m", caller: firstCaller, executors: {} }).runTurn(makeInput("ru"));
  assert.equal((firstResult.debug as any).reason, "malformed_first_model_response");

  let round = 0;
  const bookingCaller: RuntimeAgentCaller = async () => {
    round += 1;
    if (round === 1) {
      return { type: "tool_requests", tool_requests: [{ tool: "booking.apply", call_id: "c1", arguments: { first_name: "A", last_name: "B", service: "чистка", requested_date: "2026-07-20", requested_time: "10:00" } }] };
    }
    return malformedOutput();
  };
  const bookingResult = await createRuntimeAgentLoop({ model: "m", caller: bookingCaller, executors: bookingApplyExecutors("booking_write_disabled") }).runTurn(makeInput("ru"));
  assert.equal((bookingResult.debug as any).reason, "malformed_second_model_response_booking_fallback");

  let round2 = 0;
  const availabilityCaller: RuntimeAgentCaller = async () => {
    round2 += 1;
    if (round2 === 1) {
      return { type: "tool_requests", tool_requests: [{ tool: "availability.check", call_id: "a1", arguments: { requested_date: "2026-07-04", requested_time: "12:00" } }] };
    }
    return malformedOutput();
  };
  const availabilityExecutors: ToolExecutorRegistry = {
    "availability.check": async () => ({ tool: "availability.check", status: "success", data: { slots: [{ slot_id: "s1", starts_at: "a", ends_at: "b" }] } }),
  };
  const genericResult = await createRuntimeAgentLoop({ model: "m", caller: availabilityCaller, executors: availabilityExecutors }).runTurn(makeInput("ru"));
  assert.equal((genericResult.debug as any).reason, "malformed_second_model_response_generic_fallback");
});

// ── C/D: second-call malformed after booking.apply ──────────────────────────

function bookingApplyExecutors(bookingStatus: string): ToolExecutorRegistry {
  return {
    "booking.apply": async () => ({
      tool: "booking.apply",
      status: "success",
      data: {
        booking_action: "booking_apply",
        booking_status: bookingStatus,
        created_visit: bookingStatus === "visit_created",
        may_claim_booked: bookingStatus === "visit_created",
        cliniccard_visit_id: bookingStatus === "visit_created" ? "visit_1" : null,
        reason: bookingStatus,
        proof: null,
      },
    }),
  };
}

test("C: second call malformed after booking_write_disabled returns booking emergency fallback, not English", async () => {
  let round = 0;
  const caller: RuntimeAgentCaller = async () => {
    round += 1;
    if (round === 1) {
      return {
        type: "tool_requests",
        tool_requests: [{ tool: "booking.apply", call_id: "c1", arguments: { first_name: "Ivan", last_name: "Petrov", service: "чистка", requested_date: "2026-07-20", requested_time: "10:00" } }],
      };
    }
    return malformedOutput();
  };
  const agent = createRuntimeAgentLoop({ model: "gpt-test", caller, executors: bookingApplyExecutors("booking_write_disabled") });
  const result = await agent.runTurn(makeInput("ru"));

  assert.doesNotMatch(result.final_patient_reply, /having trouble/i);
  assert.match(result.final_patient_reply, /клиник/i);
  assert.equal((result.debug as any).reason, "malformed_second_model_response_booking_fallback");
  assert.equal(result.tool_results[0].status, "success");
});

test("D: second call malformed after booking.apply never claims booked/confirmed", async () => {
  let round = 0;
  const caller: RuntimeAgentCaller = async () => {
    round += 1;
    if (round === 1) {
      return {
        type: "tool_requests",
        tool_requests: [{ tool: "booking.apply", call_id: "c1", arguments: { first_name: "Ivan", last_name: "Petrov", service: "чистка", requested_date: "2026-07-20", requested_time: "10:00" } }],
      };
    }
    return malformedOutput();
  };
  const agent = createRuntimeAgentLoop({ model: "gpt-test", caller, executors: bookingApplyExecutors("cliniccard_write_failed") });
  const result = await agent.runTurn(makeInput("ru"));

  assert.doesNotMatch(result.final_patient_reply, /запись (создана|подтверждена)/i);
  // tool_results are preserved so downstream admin-notify side_effect derivation (PR #117) still works.
  assert.equal(result.tool_results[0].status, "success");
  assert.equal((result.tool_results[0].data as any).booking_status, "cliniccard_write_failed");
  assert.equal((result.tool_results[0].data as any).may_claim_booked, false);
});

// ── E: forced finalization malformed ────────────────────────────────────────

test("E: forced finalization malformed does not leak English fallback", async () => {
  let round = 0;
  const caller: RuntimeAgentCaller = async () => {
    round += 1;
    if (round === 1) {
      return {
        type: "tool_requests",
        tool_requests: [{ tool: "kb.search", call_id: "c1", arguments: { query: "insurance" } }],
      };
    }
    if (round === 2) {
      // Round 2 requests more tools than we can execute -> triggers forced finalization (round 3).
      return { type: "tool_requests", tool_requests: [{ tool: "kb.search", call_id: "c2", arguments: { query: "more" } }] };
    }
    return malformedOutput();
  };
  const executors: ToolExecutorRegistry = {
    "kb.search": async () => ({ tool: "kb.search", status: "success", data: { chunks: [{ chunk_id: "1", text: "PPO accepted" }] } }),
  };
  const agent = createRuntimeAgentLoop({ model: "gpt-test", caller, executors });
  const result = await agent.runTurn(makeInput("ru"));

  assert.doesNotMatch(result.final_patient_reply, /having trouble/i);
  assert.equal((result.debug as any).reason, "malformed_forced_finalization_fallback");
});

// ── F/G: existing paths unchanged ───────────────────────────────────────────

test("F: normal (non-malformed) final response path is unchanged", async () => {
  const caller: RuntimeAgentCaller = async () => ({
    type: "final_response",
    final_response: { final_patient_reply: "Здравствуйте!" },
  });
  const agent = createRuntimeAgentLoop({ model: "gpt-test", caller, executors: {} });
  const result = await agent.runTurn(makeInput("ru"));
  assert.equal(result.final_patient_reply, "Здравствуйте!");
  assert.equal((result.debug as any).reason, undefined);
});

test("G: normal tool_request path is unchanged", async () => {
  let round = 0;
  const caller: RuntimeAgentCaller = async () => {
    round += 1;
    if (round === 1) {
      return { type: "tool_requests", tool_requests: [{ tool: "kb.search", call_id: "c1", arguments: { query: "prices" } }] };
    }
    return { type: "final_response", final_response: { final_patient_reply: "Consultation is 1500 Kč." } };
  };
  const executors: ToolExecutorRegistry = {
    "kb.search": async () => ({ tool: "kb.search", status: "success", data: { chunks: [] } }),
  };
  const agent = createRuntimeAgentLoop({ model: "gpt-test", caller, executors });
  const result = await agent.runTurn(makeInput("en"));
  assert.equal(result.final_patient_reply, "Consultation is 1500 Kč.");
  assert.equal(result.tool_results[0].status, "success");
});

// ── H: admin_notification side_effect derivation still works from preserved tool_results ──

test("H: malformed second-call path preserves tool_results so admin_notification derivation is unaffected", async () => {
  let round = 0;
  const caller: RuntimeAgentCaller = async () => {
    round += 1;
    if (round === 1) {
      return {
        type: "tool_requests",
        tool_requests: [{ tool: "booking.apply", call_id: "c1", arguments: { first_name: "Ivan", last_name: "Petrov", service: "чистка", requested_date: "2026-07-20", requested_time: "10:00" } }],
      };
    }
    return malformedOutput();
  };
  const agent = createRuntimeAgentLoop({ model: "gpt-test", caller, executors: bookingApplyExecutors("booking_write_disabled") });
  const result = await agent.runTurn(makeInput("ru"));

  const { buildBookingApplyActionTruth } = await import("../src/runtime/bookingApplyGuard.ts");
  const { resolveAdminNotifyReason } = await import("../src/integrations/adminNotify/adminNotifyTrigger.ts");
  const actionTruth = buildBookingApplyActionTruth(result.tool_results);
  assert.equal(resolveAdminNotifyReason(actionTruth), "booking_write_disabled");
});

// ── 6: production smoke regression — availability check, then malformed confirmation ──

test("regression: availability check then malformed confirmation turn returns localized fallback, no booking claim", async () => {
  let round = 0;
  const caller: RuntimeAgentCaller = async () => {
    round += 1;
    if (round === 1) {
      return {
        type: "tool_requests",
        tool_requests: [{ tool: "availability.check", call_id: "a1", arguments: { requested_date: "2026-07-04", requested_time: "12:00" } }],
      };
    }
    return malformedOutput();
  };
  const executors: ToolExecutorRegistry = {
    "availability.check": async () => ({
      tool: "availability.check",
      status: "success",
      data: { slots: [{ slot_id: "s1", starts_at: "2026-07-04T12:00:00Z", ends_at: "2026-07-04T12:30:00Z" }] },
    }),
  };
  const agent = createRuntimeAgentLoop({ model: "gpt-test", caller, executors });
  const result = await agent.runTurn(makeInput("ru"));

  assert.doesNotMatch(result.final_patient_reply, /having trouble/i);
  assert.match(result.final_patient_reply, /клиник/i);
  assert.equal((result.debug as any).reason, "malformed_second_model_response_generic_fallback");
  assert.doesNotMatch(result.final_patient_reply, /запись (создана|подтверждена)/i);
  // No booking.apply was ever requested -> no ClinicCard write path touched.
  assert.equal(result.tool_results.some((r) => r.tool === "booking.apply"), false);
});
