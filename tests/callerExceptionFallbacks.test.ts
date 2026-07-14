/**
 * PR #119 — localize and harden real caller exception fallbacks.
 *
 * PR #118 fixed the synthesized malformed final_response case
 * (safety_notes=["malformed_openai_response"]). Production smoke after that
 * deploy still reproduced the raw English "Sorry, I'm having trouble
 * processing that right now." fallback — a different path: deps.caller(...)
 * actually throws, and the runtimeAgentLoop catch blocks returned hardcoded
 * English regardless of locale.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  createRuntimeAgentLoop,
  buildMalformedResponseFallback,
  type RuntimeAgentCaller,
} from "../src/runtime/runtimeAgentLoop.ts";
import { buildBookingApplyActionTruth } from "../src/runtime/bookingApplyGuard.ts";
import { resolveAdminNotifyReason } from "../src/integrations/adminNotify/adminNotifyTrigger.ts";
import type { ToolExecutorRegistry } from "../src/runtime/toolExecutor.ts";
import type { ConversationMemoryRepository } from "../src/runtime/runtimeRepositories.ts";

function makeSlotStateRepo(starts_at: string) {
  return {
    async loadState() { return { selected_slot: { starts_at } }; },
    async saveState() {},
  };
}

function makeInput(locale: string | null, conversation_id?: string | null) {
  return {
    clinic_id: "clinic_1",
    contact_id: "contact_1",
    case_id: "case_1",
    user_message: "test",
    locale,
    conversation_id,
    truth_snapshot: { scheduling_intent_present: true, date_or_time_present: true },
    // Trusted phone required so the round-1 global phone preflight (PR #133) does not
    // intercept before the executor runs.  These tests exercise post-execution paths.
    channel_contact: { phone_number: "+420600111222", phone_source: "telegram_contact_button" } as const,
  };
}

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

// ── A/B: first-call exception ───────────────────────────────────────────────

test("A: first caller exception in RU returns RU fallback, not English", async () => {
  const caller: RuntimeAgentCaller = async () => {
    throw new Error("network timeout");
  };
  const agent = createRuntimeAgentLoop({ model: "gpt-test", caller, executors: {} });
  const result = await agent.runTurn(makeInput("ru"));

  assert.doesNotMatch(result.final_patient_reply, /having trouble/i);
  assert.match(result.final_patient_reply, /клиник/i);
  assert.equal((result.debug as any).reason, "agent_first_call_exception");
  assert.equal((result.debug as any).runtime_error.code, "agent_caller_failed");
});

test("B: first caller exception in CS returns CS fallback, not English", async () => {
  const caller: RuntimeAgentCaller = async () => {
    throw new Error("network timeout");
  };
  const agent = createRuntimeAgentLoop({ model: "gpt-test", caller, executors: {} });
  const result = await agent.runTurn(makeInput("cs"));

  assert.doesNotMatch(result.final_patient_reply, /having trouble/i);
  assert.match(result.final_patient_reply, /kontaktujte kliniku/i);
});

test("C: first caller exception saves memory when conversation_id exists", async () => {
  const caller: RuntimeAgentCaller = async () => {
    throw new Error("boom");
  };
  const { repo, saveCalls } = makeMemorySpy();
  const agent = createRuntimeAgentLoop({ model: "gpt-test", caller, executors: {}, conversationMemoryRepository: repo });
  const result = await agent.runTurn(makeInput("ru", "conv_existing"));

  assert.equal(saveCalls.length, 1);
  assert.equal((saveCalls[0] as any).conversation_id, "conv_existing");
  assert.equal(result.conversation_id, "conv_existing");
});

test("no save when conversation_id is null on first-call exception", async () => {
  const caller: RuntimeAgentCaller = async () => {
    throw new Error("boom");
  };
  const { repo, saveCalls } = makeMemorySpy();
  const agent = createRuntimeAgentLoop({ model: "gpt-test", caller, executors: {}, conversationMemoryRepository: repo });
  await agent.runTurn(makeInput("ru", null));

  assert.equal(saveCalls.length, 0);
});

// ── D/E/F: second-call exception ────────────────────────────────────────────

test("D: second caller exception after booking.apply returns booking emergency fallback", async () => {
  let round = 0;
  const caller: RuntimeAgentCaller = async () => {
    round += 1;
    if (round === 1) {
      return {
        type: "tool_requests",
        tool_requests: [{ tool: "booking.apply", call_id: "c1", arguments: { subject_id: "subject_1", first_name: "Ivan", last_name: "Petrov", service: "чистка", requested_date: "2026-07-20", requested_time: "10:00" } }],
      };
    }
    throw new Error("second call boom");
  };
  const agent = createRuntimeAgentLoop({ model: "gpt-test", caller, executors: bookingApplyExecutors("booking_write_disabled"), bookingProcessStateRepository: makeSlotStateRepo("2026-07-20T10:00:00") });
  const result = await agent.runTurn(makeInput("ru"));

  assert.doesNotMatch(result.final_patient_reply, /having trouble/i);
  assert.match(result.final_patient_reply, /клиник/i);
  assert.equal((result.debug as any).reason, "agent_second_call_exception_booking_fallback");
});

test("E: second caller exception after booking.apply preserves tool_results for admin_notify derivation", async () => {
  let round = 0;
  const caller: RuntimeAgentCaller = async () => {
    round += 1;
    if (round === 1) {
      return {
        type: "tool_requests",
        tool_requests: [{ tool: "booking.apply", call_id: "c1", arguments: { subject_id: "subject_1", first_name: "Ivan", last_name: "Petrov", service: "чистка", requested_date: "2026-07-20", requested_time: "10:00" } }],
      };
    }
    throw new Error("second call boom");
  };
  const agent = createRuntimeAgentLoop({ model: "gpt-test", caller, executors: bookingApplyExecutors("booking_write_disabled"), bookingProcessStateRepository: makeSlotStateRepo("2026-07-20T10:00:00") });
  const result = await agent.runTurn(makeInput("ru"));

  assert.equal(result.tool_requests.length, 1);
  assert.equal(result.tool_results[0]?.status, "success");
  const actionTruth = buildBookingApplyActionTruth(result.tool_results);
  assert.equal(resolveAdminNotifyReason(actionTruth), "booking_write_disabled");
});

test("F: second caller exception without bookingActionTruth returns localized generic fallback, not English", async () => {
  let round = 0;
  const caller: RuntimeAgentCaller = async () => {
    round += 1;
    if (round === 1) {
      return { type: "tool_requests", tool_requests: [{ tool: "kb.search", call_id: "c1", arguments: { query: "prices" } }] };
    }
    throw new Error("second call boom");
  };
  const executors: ToolExecutorRegistry = {
    "kb.search": async () => ({ tool: "kb.search", status: "success", data: { chunks: [] } }),
  };
  const agent = createRuntimeAgentLoop({ model: "gpt-test", caller, executors });
  const result = await agent.runTurn(makeInput("ru"));

  assert.doesNotMatch(result.final_patient_reply, /having trouble wording|having trouble/i);
  assert.match(result.final_patient_reply, /клиник/i);
  assert.equal((result.debug as any).reason, "agent_second_call_exception_generic_fallback");
});

// ── G: no booking-created/confirmed claim in any exception fallback ─────────

test("G: no booking-created/confirmed claim in any exception fallback", async () => {
  const claimRegex = /запись (создана|подтверждена)/i;

  const firstCallCaller: RuntimeAgentCaller = async () => {
    throw new Error("boom");
  };
  const firstResult = await createRuntimeAgentLoop({ model: "m", caller: firstCallCaller, executors: {} }).runTurn(makeInput("ru"));
  assert.doesNotMatch(firstResult.final_patient_reply, claimRegex);

  let round = 0;
  const secondCallCaller: RuntimeAgentCaller = async () => {
    round += 1;
    if (round === 1) {
      return {
        type: "tool_requests",
        tool_requests: [{ tool: "booking.apply", call_id: "c1", arguments: { subject_id: "subject_1", first_name: "A", last_name: "B", service: "чистка", requested_date: "2026-07-20", requested_time: "10:00" } }],
      };
    }
    throw new Error("boom");
  };
  const secondResult = await createRuntimeAgentLoop({ model: "m", caller: secondCallCaller, executors: bookingApplyExecutors("booking_write_disabled") }).runTurn(makeInput("ru"));
  assert.doesNotMatch(secondResult.final_patient_reply, claimRegex);
});

// ── H: existing PR #118 malformed final_response behavior remains unchanged ──

test("H: PR #118 malformed (non-thrown) final_response behavior is unaffected by exception-fallback changes", async () => {
  const caller: RuntimeAgentCaller = async () => ({
    type: "final_response",
    final_response: { final_patient_reply: "placeholder", safety_notes: ["malformed_openai_response"] },
  });
  const agent = createRuntimeAgentLoop({ model: "gpt-test", caller, executors: {} });
  const result = await agent.runTurn(makeInput("ru"));

  assert.doesNotMatch(result.final_patient_reply, /having trouble/i);
  assert.equal(result.final_patient_reply, buildMalformedResponseFallback("ru"));
  assert.equal((result.debug as any).reason, "malformed_first_model_response");
});
