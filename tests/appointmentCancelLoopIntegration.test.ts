import assert from "node:assert/strict";
import test from "node:test";

import { createRuntimeAgentLoop } from "../src/runtime/runtimeAgentLoop.ts";
import { createAppointmentCancelExecutor } from "../src/integrations/cliniccard/appointmentCancelExecutor.ts";
import type { RuntimeAgentCallerOutput } from "../src/runtime/runtimeAgentLoop.ts";
import type { ToolExecutor } from "../src/runtime/toolExecutor.ts";
import type { RuntimeAgentTurnInput } from "../src/runtime/openaiRuntimeAgent.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

type CallerRound = RuntimeAgentCallerOutput | { __throw: string };

function makeCallSequence(rounds: CallerRound[]) {
  let i = 0;
  return async () => {
    const r = rounds[i++];
    if (r && "__throw" in r) throw new Error((r as { __throw: string }).__throw);
    return r as RuntimeAgentCallerOutput;
  };
}

function makeInput(
  explicitCancellation: boolean,
  overrides: Partial<RuntimeAgentTurnInput> = {},
): RuntimeAgentTurnInput {
  return {
    clinic_id: "clinic_1",
    contact_id: "contact_1",
    case_id: "case_1",
    user_message: explicitCancellation ? "Please cancel my appointment" : "Show me my appointment",
    locale: "en",
    truth_snapshot: {
      scheduling_intent_present: false,
      date_or_time_present: false,
      active_hold_exists: false,
      hold_not_expired: false,
      contact_case_match: true,
      contradiction_in_turn: false,
      availability_result_exists: false,
      proposed_slot_exists: false,
      service_known: false,
      explicit_slot_rejection: false,
      explicit_cancellation_request: explicitCancellation,
    },
    channel_contact: { phone_number: "+420123456789", phone_source: "telegram_contact_button" },
    ...overrides,
  };
}

/** Real cancel executor with mocked ClinicCard adapter. Counts deleteVisit calls. */
function makeCancelExecutor(clinicId = "clinic_1") {
  let count = 0;
  const executor = createAppointmentCancelExecutor({
    env: {
      CLINICCARD_BOOKING_MODE: "live",
      CLINICCARD_LIVE_CLINIC_ALLOWLIST: clinicId,
      CLINICCARD_API_BASE_URL: "https://test.example",
      CLINICCARD_API_TOKEN: "test",
      CLINICCARD_DEFAULT_DOCTOR_ID: "1",
      CLINICCARD_DEFAULT_CABINET_ID: "1",
      CLINICCARD_TIMEZONE: "Europe/Prague",
    },
    adapterFactory: () => ({
      createVisit: async () => ({ ok: false as const, error: { code: "x", message: "x", retryable: false as const } }),
      listVisits: async () => ({ ok: true as const, data: [] }),
      deleteVisit: async () => { count++; return { ok: true as const, data: undefined }; },
    }),
  });
  return { executor, mutationCount: () => count };
}

/** Lookup executor returning a single-match for a given visitId. */
function makeLookupExecutor(visitId: string, date = "2026-08-20"): ToolExecutor {
  return async () => ({
    tool: "appointment.lookup",
    status: "success",
    data: {
      appointment_action: "appointment_lookup",
      lookup_status: "single_match",
      may_claim_found: true,
      required_next_action: "none",
      appointments: [{
        cliniccard_visit_id: visitId,
        date,
        time_start: "10:00",
        time_end: "11:00",
        status: "PLANNED" as const,
      }],
      searched_range: { date_from: date, date_to: date },
    },
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

// 1. Explicit cancel + same-subject lookup proof → exactly 1 mutation
test("CANCEL-LOOP-1: explicit cancellation + same-subject lookup proof → exactly 1 mutation", async () => {
  const { executor: cancelExecutor, mutationCount } = makeCancelExecutor();

  const agent = createRuntimeAgentLoop({
    model: "gpt-test",
    caller: makeCallSequence([
      { type: "tool_requests", tool_requests: [{ tool: "appointment.lookup", call_id: "c1", arguments: { subject_id: "subject_1" } }] },
      { type: "tool_requests", tool_requests: [{ tool: "appointment.cancel", call_id: "c2", arguments: { subject_id: "subject_1", visit_id: "visit_99" } }] },
      { type: "final_response", final_response: { final_patient_reply: "Your appointment was cancelled." } },
    ]),
    executors: {
      "appointment.lookup": makeLookupExecutor("visit_99"),
      "appointment.cancel": cancelExecutor,
    },
  });

  await agent.runTurn(makeInput(true));
  assert.equal(mutationCount(), 1, "exactly one deleteVisit must be called");
});

// 2. View-only request + erroneous model cancel → 0 mutations
test("CANCEL-LOOP-2: view-only request (explicit_cancellation_request=false) + erroneous model cancel → 0 mutations", async () => {
  const { executor: cancelExecutor, mutationCount } = makeCancelExecutor();

  const agent = createRuntimeAgentLoop({
    model: "gpt-test",
    caller: makeCallSequence([
      { type: "tool_requests", tool_requests: [{ tool: "appointment.lookup", call_id: "c1", arguments: { subject_id: "subject_1" } }] },
      { type: "tool_requests", tool_requests: [{ tool: "appointment.cancel", call_id: "c2", arguments: { subject_id: "subject_1", visit_id: "visit_99" } }] },
      { type: "final_response", final_response: { final_patient_reply: "Here is your appointment." } },
    ]),
    executors: {
      "appointment.lookup": makeLookupExecutor("visit_99"),
      "appointment.cancel": cancelExecutor,
    },
  });

  await agent.runTurn(makeInput(false));
  assert.equal(mutationCount(), 0, "cancel executor must not be called when explicit_cancellation_request=false");
});

// 3. Reschedule request + erroneous model cancel → 0 mutations
test("CANCEL-LOOP-3: reschedule-intent request (explicit_cancellation_request=false) + erroneous model cancel → 0 mutations", async () => {
  const { executor: cancelExecutor, mutationCount } = makeCancelExecutor();

  const agent = createRuntimeAgentLoop({
    model: "gpt-test",
    caller: makeCallSequence([
      { type: "tool_requests", tool_requests: [{ tool: "appointment.lookup", call_id: "c1", arguments: { subject_id: "subject_1" } }] },
      { type: "tool_requests", tool_requests: [{ tool: "appointment.cancel", call_id: "c2", arguments: { subject_id: "subject_1", visit_id: "visit_99" } }] },
      { type: "final_response", final_response: { final_patient_reply: "I can help reschedule." } },
    ]),
    executors: {
      "appointment.lookup": makeLookupExecutor("visit_99"),
      "appointment.cancel": cancelExecutor,
    },
  });

  const input = makeInput(false, { user_message: "I want to reschedule" });
  await agent.runTurn(input);
  assert.equal(mutationCount(), 0, "reschedule intent must not authorize cancellation");
});

// 4. Lookup subject_1 + cancel subject_2 → 0 mutations (cross-subject proof rejected)
test("CANCEL-LOOP-4: lookup(subject_1) + cancel(subject_2) → no proof match → 0 mutations", async () => {
  const { executor: cancelExecutor, mutationCount } = makeCancelExecutor();

  const agent = createRuntimeAgentLoop({
    model: "gpt-test",
    caller: makeCallSequence([
      { type: "tool_requests", tool_requests: [{ tool: "appointment.lookup", call_id: "c1", arguments: { subject_id: "subject_1" } }] },
      { type: "tool_requests", tool_requests: [{ tool: "appointment.cancel", call_id: "c2", arguments: { subject_id: "subject_2", visit_id: "visit_99" } }] },
      { type: "final_response", final_response: { final_patient_reply: "Unable to verify." } },
    ]),
    executors: {
      "appointment.lookup": makeLookupExecutor("visit_99"),
      "appointment.cancel": cancelExecutor,
    },
  });

  await agent.runTurn(makeInput(true));
  assert.equal(mutationCount(), 0, "subject_1 lookup proof must not authorize subject_2 cancel");
});

// 5. Lookup subject_2 + cancel subject_1 → 0 mutations (cross-subject proof rejected)
test("CANCEL-LOOP-5: lookup(subject_2) + cancel(subject_1) → no proof match → 0 mutations", async () => {
  const { executor: cancelExecutor, mutationCount } = makeCancelExecutor();

  const agent = createRuntimeAgentLoop({
    model: "gpt-test",
    caller: makeCallSequence([
      { type: "tool_requests", tool_requests: [{ tool: "appointment.lookup", call_id: "c1", arguments: { subject_id: "subject_2" } }] },
      { type: "tool_requests", tool_requests: [{ tool: "appointment.cancel", call_id: "c2", arguments: { subject_id: "subject_1", visit_id: "visit_99" } }] },
      { type: "final_response", final_response: { final_patient_reply: "Unable to verify." } },
    ]),
    executors: {
      "appointment.lookup": makeLookupExecutor("visit_99"),
      "appointment.cancel": cancelExecutor,
    },
  });

  await agent.runTurn(makeInput(true));
  assert.equal(mutationCount(), 0, "subject_2 lookup proof must not authorize subject_1 cancel");
});

// 6. Multiple lookup calls → only same-subject proof authorizes; cross-subject is rejected
test("CANCEL-LOOP-6: multiple lookup calls → only same-subject proof may authorize cancellation", async () => {
  const { executor: cancelExecutor, mutationCount } = makeCancelExecutor();

  // subject_1 lookup returns visit_1; subject_2 lookup returns visit_2
  const subjectAwareLookup: ToolExecutor = async (ctx) => {
    const subjectId = ctx.lookup_subject_id;
    const visitId = subjectId === "subject_1" ? "visit_1" : "visit_2";
    return {
      tool: "appointment.lookup",
      status: "success",
      data: {
        appointment_action: "appointment_lookup",
        lookup_status: "single_match",
        may_claim_found: true,
        required_next_action: "none",
        appointments: [{ cliniccard_visit_id: visitId, date: "2026-08-20", time_start: "10:00", time_end: "11:00", status: "PLANNED" as const }],
        searched_range: { date_from: "2026-08-20", date_to: "2026-08-20" },
      },
    };
  };

  // Cancel subject_1 with visit_2 — subject_1's proof has visit_1, not visit_2.
  // Even though subject_2 has visit_2, subject_2's proof must not be used.
  const agent = createRuntimeAgentLoop({
    model: "gpt-test",
    caller: makeCallSequence([
      {
        type: "tool_requests",
        tool_requests: [
          { tool: "appointment.lookup", call_id: "c1", arguments: { subject_id: "subject_1" } },
          { tool: "appointment.lookup", call_id: "c2", arguments: { subject_id: "subject_2" } },
        ],
      },
      { type: "tool_requests", tool_requests: [{ tool: "appointment.cancel", call_id: "c3", arguments: { subject_id: "subject_1", visit_id: "visit_2" } }] },
      { type: "final_response", final_response: { final_patient_reply: "Cannot verify." } },
    ]),
    executors: {
      "appointment.lookup": subjectAwareLookup,
      "appointment.cancel": cancelExecutor,
    },
  });

  await agent.runTurn(makeInput(true));
  // subject_1 proof has visit_1 but cancel requests visit_2 → mismatch → 0 mutations
  assert.equal(mutationCount(), 0, "cross-visit-id mismatch via subject binding must produce 0 mutations");
});

// 7. Two appointment.cancel calls in one round → 0 mutations
test("CANCEL-LOOP-7: two appointment.cancel calls in round-2 → multiple-cancel guard fires → 0 mutations", async () => {
  const { executor: cancelExecutor, mutationCount } = makeCancelExecutor();

  const agent = createRuntimeAgentLoop({
    model: "gpt-test",
    caller: makeCallSequence([
      { type: "tool_requests", tool_requests: [{ tool: "appointment.lookup", call_id: "c1", arguments: { subject_id: "subject_1" } }] },
      {
        type: "tool_requests",
        tool_requests: [
          { tool: "appointment.cancel", call_id: "c2", arguments: { subject_id: "subject_1", visit_id: "visit_99" } },
          { tool: "appointment.cancel", call_id: "c3", arguments: { subject_id: "subject_1", visit_id: "visit_99" } },
        ],
      },
      { type: "final_response", final_response: { final_patient_reply: "Cannot process." } },
    ]),
    executors: {
      "appointment.lookup": makeLookupExecutor("visit_99"),
      "appointment.cancel": cancelExecutor,
    },
  });

  await agent.runTurn(makeInput(true));
  assert.equal(mutationCount(), 0, "multiple cancel requests in one round must produce zero mutations");
});

// 8. booking.apply + appointment.cancel in same round-2 → cancel never reached
test("CANCEL-LOOP-8: booking.apply in round-2 takes precedence → appointment.cancel never executed", async () => {
  const { executor: cancelExecutor, mutationCount } = makeCancelExecutor();

  const agent = createRuntimeAgentLoop({
    model: "gpt-test",
    caller: makeCallSequence([
      { type: "tool_requests", tool_requests: [{ tool: "appointment.lookup", call_id: "c1", arguments: { subject_id: "subject_1" } }] },
      {
        type: "tool_requests",
        tool_requests: [
          // booking.apply has no slot proof → guard G blocks it → function returns before cancel
          { tool: "booking.apply", call_id: "c2", arguments: { subject_id: "subject_1", first_name: "Anna", last_name: "Smith", service: "cleaning", requested_date: "2026-09-01", requested_time: "10:00" } },
          { tool: "appointment.cancel", call_id: "c3", arguments: { subject_id: "subject_1", visit_id: "visit_99" } },
        ],
      },
      // Round-3: guarded booking.apply finalization
      { type: "final_response", final_response: { final_patient_reply: "No slot confirmed." } },
    ]),
    executors: {
      "appointment.lookup": makeLookupExecutor("visit_99"),
      "appointment.cancel": cancelExecutor,
    },
  });

  const result = await agent.runTurn(makeInput(true));
  assert.equal(mutationCount(), 0, "cancel executor must not be called when booking.apply path fires first");
  assert.ok(result.final_patient_reply.length > 0);
});

// 9. Successful cancel + final model call failure → cancel-aware success fallback
test("CANCEL-LOOP-9: successful cancel + third model call throws → cancel-aware success fallback", async () => {
  const { executor: cancelExecutor, mutationCount } = makeCancelExecutor();

  const agent = createRuntimeAgentLoop({
    model: "gpt-test",
    caller: makeCallSequence([
      { type: "tool_requests", tool_requests: [{ tool: "appointment.lookup", call_id: "c1", arguments: { subject_id: "subject_1" } }] },
      { type: "tool_requests", tool_requests: [{ tool: "appointment.cancel", call_id: "c2", arguments: { subject_id: "subject_1", visit_id: "visit_99" } }] },
      { __throw: "OpenAI 500 error" },
    ]),
    executors: {
      "appointment.lookup": makeLookupExecutor("visit_99"),
      "appointment.cancel": cancelExecutor,
    },
  });

  const result = await agent.runTurn(makeInput(true));
  assert.equal(mutationCount(), 1, "delete must have executed before the model call failed");
  assert.match(result.final_patient_reply, /cancelled/i, "fallback must claim cancellation when may_claim_cancelled=true");
});

// 10. Failed cancel (policy denied) + final model failure → no cancellation claim
test("CANCEL-LOOP-10: policy-denied cancel + third model call throws → generic fallback (no cancellation claim)", async () => {
  const { executor: cancelExecutor, mutationCount } = makeCancelExecutor();

  const agent = createRuntimeAgentLoop({
    model: "gpt-test",
    caller: makeCallSequence([
      { type: "tool_requests", tool_requests: [{ tool: "appointment.lookup", call_id: "c1", arguments: { subject_id: "subject_1" } }] },
      { type: "tool_requests", tool_requests: [{ tool: "appointment.cancel", call_id: "c2", arguments: { subject_id: "subject_1", visit_id: "visit_99" } }] },
      { __throw: "OpenAI 500 error" },
    ]),
    executors: {
      "appointment.lookup": makeLookupExecutor("visit_99"),
      "appointment.cancel": cancelExecutor,
    },
  });

  // explicit_cancellation_request=false → policy denies → may_claim_cancelled=false
  const result = await agent.runTurn(makeInput(false));
  assert.equal(mutationCount(), 0);
  assert.doesNotMatch(result.final_patient_reply, /cancelled/i, "must NOT claim cancellation when may_claim_cancelled=false");
});

// 11. Every round-2 tool call ID receives exactly one result
test("CANCEL-LOOP-11: round-2 emits cancel + kb.search → both call IDs have results in tool_results", async () => {
  const { executor: cancelExecutor } = makeCancelExecutor();

  const agent = createRuntimeAgentLoop({
    model: "gpt-test",
    caller: makeCallSequence([
      { type: "tool_requests", tool_requests: [{ tool: "appointment.lookup", call_id: "c1", arguments: { subject_id: "subject_1" } }] },
      {
        type: "tool_requests",
        tool_requests: [
          { tool: "appointment.cancel", call_id: "c2", arguments: { subject_id: "subject_1", visit_id: "visit_99" } },
          { tool: "kb.search", call_id: "c3", arguments: { query: "opening hours" } },
        ],
      },
      { type: "final_response", final_response: { final_patient_reply: "Done." } },
    ]),
    executors: {
      "appointment.lookup": makeLookupExecutor("visit_99"),
      "appointment.cancel": cancelExecutor,
    },
  });

  const result = await agent.runTurn(makeInput(true));

  const callIds = result.tool_results.map((r) => r.call_id);
  assert.ok(callIds.includes("c1"), "lookup call_id must appear in tool_results");
  assert.ok(callIds.includes("c2"), "cancel call_id must appear in tool_results");
  assert.ok(callIds.includes("c3"), "kb.search call_id must appear in tool_results");

  const kbResult = result.tool_results.find((r) => r.call_id === "c3");
  assert.equal(kbResult?.status, "denied", "kb.search must be denied — cancel takes precedence");
});
