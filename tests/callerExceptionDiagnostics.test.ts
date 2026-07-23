/**
 * PR #120 — diagnose intermittent OpenAI caller exception on booking confirm step.
 *
 * Diagnostics only: no behavior change, no fallback text change, no ClinicCard
 * writes, no env/secrets. Goal is just to make caught caller exceptions
 * observable in debug via a safe, bounded, structured snapshot.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { buildCallerExceptionDiagnostics, sanitizeErrorMessage } from "../src/runtime/callerExceptionDiagnostics.ts";
import {
  createRuntimeAgentLoop,
  buildMalformedResponseFallback,
  buildMultiRoundFallbackReply,
  type RuntimeAgentCaller,
} from "../src/runtime/runtimeAgentLoop.ts";
import { buildBookingApplyActionTruth } from "../src/runtime/bookingApplyGuard.ts";
import type { ToolExecutorRegistry } from "../src/runtime/toolExecutor.ts";

function makeSlotStateRepo(starts_at: string) {
  const date = starts_at.slice(0, 10);
  const hhmm = starts_at.slice(11, 16);
  const slotKey = `${date}T${hhmm}`;
  const callId = "legacy_test_call";
  return {
    async loadState() {
      return {
        selected_slot: { starts_at },
        last_available_slots: [{ starts_at }],
        active_availability_evidence: { availability_call_id: callId, requested_date: date, requested_time: null, allowed_slot_keys: [slotKey] },
        selected_slot_proof: { subject_id: "subject_1" as const, availability_call_id: callId, slot_key: slotKey },
      };
    },
    async saveState() {},
  };
}

function makeInput(locale: string | null, conversation_id?: string | null) {
  return {
    clinic_id: "clinic_1",
    contact_id: "contact_1",
    case_id: "case_1",
    user_message: "Меня зовут Иван Петров, телефон +420600111222",
    locale,
    conversation_id,
    truth_snapshot: { scheduling_intent_present: true, date_or_time_present: true },
    // Trusted phone required so the round-1 global phone preflight (PR #133) does not
    // intercept before the executor runs.  These tests exercise post-execution paths
    // (second-call exceptions, malformed responses) that need booking.apply to execute.
    channel_contact: { phone_number: "+420600111222", phone_source: "telegram_contact_button" } as const,
  };
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

// ── unit: buildCallerExceptionDiagnostics ───────────────────────────────────

test("buildCallerExceptionDiagnostics extracts safe fields and truncates/redacts the message", () => {
  const longSecretLike = "a".repeat(50);
  const error = Object.assign(new Error(`upstream failed sk-abcdefghijklmnop token=${longSecretLike} end`), {
    status: 500,
    request_id: "req_abc123",
  });
  const diag = buildCallerExceptionDiagnostics(error, {
    stage: "second_call",
    locale: "ru",
    conversationId: "conv_1",
    toolResults: [{ tool: "booking.apply", status: "success", data: { first_name: "Ivan", phone_number: "+420600111222" } as any }],
    bookingApplyActionTruth: { tool: "booking.apply" },
  });

  assert.equal(diag.stage, "second_call");
  assert.equal(diag.error_name, "Error");
  assert.equal(diag.error_code, 500);
  assert.equal(diag.request_id, "req_abc123");
  assert.equal(diag.locale, "ru");
  assert.equal(diag.has_conversation_id, true);
  assert.equal(diag.had_tool_results, true);
  assert.equal(diag.had_booking_apply_action_truth, true);
  assert.deepEqual(diag.tool_names, ["booking.apply"]);

  assert.doesNotMatch(diag.message, /sk-abcdefghijklmnop/);
  assert.doesNotMatch(diag.message, new RegExp(longSecretLike));
  assert.match(diag.message, /\[redacted\]/);
});

test("Codex-P2: request_id also reads requestID (OpenAI SDK APIError casing)", () => {
  const error = Object.assign(new Error("upstream failed"), { requestID: "req_sdk_casing" });
  const diag = buildCallerExceptionDiagnostics(error, { stage: "first_call", conversationId: null });
  assert.equal(diag.request_id, "req_sdk_casing");
});

test("Codex-P2: phone numbers without a leading plus (plain or separated) are redacted too", () => {
  assert.doesNotMatch(sanitizeErrorMessage("phone=420600111222 failed"), /420600111222/);
  assert.doesNotMatch(sanitizeErrorMessage("phone=420 600 111 222 failed"), /420 600 111 222/);
  assert.doesNotMatch(sanitizeErrorMessage("phone=420-600-111-222 failed"), /420-600-111-222/);
});

test("buildCallerExceptionDiagnostics truncates very long messages", () => {
  const error = new Error("x".repeat(1000));
  const diag = buildCallerExceptionDiagnostics(error, { stage: "first_call", conversationId: null });
  assert.ok(diag.message.length <= 301); // 300 chars + ellipsis
});

test("buildCallerExceptionDiagnostics handles non-Error thrown values safely", () => {
  const diag = buildCallerExceptionDiagnostics("plain string failure", { stage: "first_call", conversationId: null });
  assert.equal(diag.error_name, null);
  assert.equal(diag.message, "plain string failure");
  assert.equal(diag.has_conversation_id, false);
  assert.equal(diag.had_tool_results, false);
  assert.deepEqual(diag.tool_names, []);
});

// ── integration: fallback behavior unchanged, diagnostics attached ──────────

test("first-call exception: fallback behavior unchanged, caller_exception diagnostics attached", async () => {
  const caller: RuntimeAgentCaller = async () => {
    throw Object.assign(new Error("timeout after 30s"), { status: 504 });
  };
  const agent = createRuntimeAgentLoop({ model: "gpt-test", caller, executors: {} });
  const result = await agent.runTurn(makeInput("ru"));

  assert.equal(result.final_patient_reply, buildMalformedResponseFallback("ru"));
  assert.equal((result.debug as any).reason, "agent_first_call_exception");
  const diag = (result.debug as any).caller_exception;
  assert.equal(diag.stage, "first_call");
  assert.equal(diag.error_code, 504);
  assert.equal(diag.had_tool_results, false);
  assert.equal(diag.had_booking_apply_action_truth, false);
});

test("second-call exception with booking_apply_action_truth: booking fallback still wins, diagnostics attached", async () => {
  let round = 0;
  const caller: RuntimeAgentCaller = async () => {
    round += 1;
    if (round === 1) {
      return {
        type: "tool_requests",
        tool_requests: [{ tool: "booking.apply", call_id: "c1", arguments: { subject_id: "subject_1", first_name: "Ivan", last_name: "Petrov", service: "чистка", requested_date: "2027-08-15", requested_time: "10:00" } }],
      };
    }
    throw Object.assign(new Error("openai_internal_error"), { code: "internal_error", request_id: "req_xyz" });
  };
  const agent = createRuntimeAgentLoop({ model: "gpt-test", caller, executors: bookingApplyExecutors("booking_write_disabled"), bookingProcessStateRepository: makeSlotStateRepo("2027-08-15T10:00:00"), now: new Date("2027-08-15T07:00:00Z") });
  const result = await agent.runTurn(makeInput("ru"));

  assert.equal((result.debug as any).reason, "agent_second_call_exception_booking_fallback");
  assert.doesNotMatch(result.final_patient_reply, /having trouble/i);
  assert.match(result.final_patient_reply, /клиник/i);

  const diag = (result.debug as any).caller_exception;
  assert.equal(diag.stage, "second_call");
  assert.equal(diag.error_code, "internal_error");
  assert.equal(diag.request_id, "req_xyz");
  assert.equal(diag.had_booking_apply_action_truth, true);
  assert.deepEqual(diag.tool_names, ["booking.apply"]);

  const actionTruth = buildBookingApplyActionTruth(result.tool_results);
  assert.ok(actionTruth);
});

test("caller_exception.tool_names never includes tool arguments — structured patient data (name/phone/service) is excluded by construction", async () => {
  let round = 0;
  const caller: RuntimeAgentCaller = async () => {
    round += 1;
    if (round === 1) {
      return {
        type: "tool_requests",
        tool_requests: [{
          tool: "booking.apply",
          call_id: "c1",
          arguments: { first_name: "Иван", last_name: "Петров", service: "чистка", requested_date: "2026-07-20", requested_time: "10:00" },
        }],
      };
    }
    throw new Error("second call boom, no PII in this message");
  };
  const agent = createRuntimeAgentLoop({ model: "gpt-test", caller, executors: bookingApplyExecutors("booking_write_disabled") });
  const result = await agent.runTurn(makeInput("ru"));

  const diag = (result.debug as any).caller_exception;
  // tool_names is a list of tool identifiers only — buildCallerExceptionDiagnostics
  // never reads request.arguments, so first_name/last_name/service/dates cannot
  // reach it regardless of what the thrown error's message contains.
  assert.deepEqual(diag.tool_names, ["booking.apply"]);
  assert.doesNotMatch(JSON.stringify(diag), /Иван|Петров|чистка/);
  assert.doesNotMatch(result.final_patient_reply, /Иван|Петров/);
});

test("sanitizeErrorMessage redacts phone numbers and multiple secret shapes (API key, bearer token) from the thrown message", async () => {
  const patientPhone = "+420600111222";
  let round = 0;
  const caller: RuntimeAgentCaller = async () => {
    round += 1;
    if (round === 1) {
      return { type: "tool_requests", tool_requests: [{ tool: "booking.apply", call_id: "c1", arguments: { subject_id: "subject_1", first_name: "A", last_name: "B", service: "чистка", requested_date: "2026-07-20", requested_time: "10:00" } }] };
    }
    throw new Error(
      `upstream 500: phone=${patientPhone} apikey=sk-verysecretkey1234567890 auth=Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFPM`,
    );
  };
  const agent = createRuntimeAgentLoop({ model: "gpt-test", caller, executors: bookingApplyExecutors("booking_write_disabled") });
  const result = await agent.runTurn(makeInput("ru"));

  const serialized = JSON.stringify(result);
  // Known, explicit limitation (not asserted false-positively as fixed): sanitizeErrorMessage
  // matches secret-shaped and phone-shaped substrings via regex — it does not and cannot
  // reliably strip arbitrary free-text PII (e.g. a name) that an upstream error might echo.
  // Structured patient data is protected separately, by tool_names never including arguments
  // (see the test above) — that guarantee does not depend on pattern matching.
  assert.doesNotMatch(serialized, /sk-verysecretkey1234567890/);
  assert.doesNotMatch(serialized, /Bearer eyJ/);
  assert.doesNotMatch(serialized, new RegExp(patientPhone.replace("+", "\\+")));
  assert.doesNotMatch(result.final_patient_reply, /Иван|Петров/);
});

test("forced finalization exception attaches caller_exception diagnostics without changing fallback behavior", async () => {
  let round = 0;
  const caller: RuntimeAgentCaller = async () => {
    round += 1;
    if (round === 1) {
      return { type: "tool_requests", tool_requests: [{ tool: "kb.search", call_id: "c1", arguments: { query: "insurance" } }] };
    }
    if (round === 2) {
      return { type: "tool_requests", tool_requests: [{ tool: "kb.search", call_id: "c2", arguments: { query: "more" } }] };
    }
    throw new Error("forced finalization boom");
  };
  const executors: ToolExecutorRegistry = {
    "kb.search": async () => ({ tool: "kb.search", status: "success", data: { chunks: [{ chunk_id: "1", text: "PPO accepted" }] } }),
  };
  const agent = createRuntimeAgentLoop({ model: "gpt-test", caller, executors });
  const result = await agent.runTurn(makeInput("ru"));

  const diag = (result.debug as any).caller_exception;
  assert.equal(diag.stage, "forced_finalization");
  assert.equal(diag.had_booking_apply_action_truth, false);
  // Fallback behavior is byte-for-byte the pre-existing multi-round fallback (PR #116/#118) —
  // this PR only attaches diagnostics, it does not touch the reply.
  assert.equal(result.final_patient_reply, buildMultiRoundFallbackReply("ru"));
});
