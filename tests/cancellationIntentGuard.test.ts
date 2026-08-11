import assert from "node:assert/strict";
import test from "node:test";

import { detectExplicitCancellationRequest } from "../src/runtime/cancellationIntentGuard.ts";
import { createRuntimeAgentLoop } from "../src/runtime/runtimeAgentLoop.ts";
import { createAppointmentCancelExecutor } from "../src/integrations/cliniccard/appointmentCancelExecutor.ts";
import type { RuntimeAgentCallerOutput } from "../src/runtime/runtimeAgentLoop.ts";
import type { ToolExecutor } from "../src/runtime/toolExecutor.ts";
import type { RuntimeAgentTurnInput } from "../src/runtime/openaiRuntimeAgent.ts";

// ── Unit tests: detectExplicitCancellationRequest ─────────────────────────────

test("CLASSIFIER-1: Russian imperative 'Отмените мою запись' → true", () => {
  assert.equal(detectExplicitCancellationRequest("Отмените мою запись"), true);
});

test("CLASSIFIER-2: Russian hypothetical 'Если отменить запись' → false", () => {
  assert.equal(detectExplicitCancellationRequest("Если отменить запись, что будет?"), false);
});

test("CLASSIFIER-3: Russian negation 'Не отменяйте мою запись' → false", () => {
  assert.equal(detectExplicitCancellationRequest("Не отменяйте мою запись"), false);
});

test("CLASSIFIER-4: Russian question 'можно ли отменить' → false", () => {
  assert.equal(detectExplicitCancellationRequest("можно ли отменить запись?"), false);
});

test("CLASSIFIER-5: English direct 'Please cancel my appointment' → true", () => {
  assert.equal(detectExplicitCancellationRequest("Please cancel my appointment"), true);
});

test("CLASSIFIER-6: English negation 'don't cancel' → false", () => {
  assert.equal(detectExplicitCancellationRequest("Please don't cancel my appointment"), false);
});

test("CLASSIFIER-7: Czech imperative 'Zrušte mou schůzku' → true", () => {
  assert.equal(detectExplicitCancellationRequest("Zrušte mou schůzku"), true);
});

test("CLASSIFIER-8: Unrelated message 'What time does the clinic open?' → false", () => {
  assert.equal(detectExplicitCancellationRequest("What time does the clinic open?"), false);
});

// ── Production-path tests: classifier drives truth snapshot ───────────────────
// No truth_snapshot injected — user_message feeds buildTruthSnapshot via classifier.

type CallerRound = RuntimeAgentCallerOutput | { __throw: string };

function makeCallSequence(rounds: CallerRound[]) {
  let i = 0;
  return async () => {
    const r = rounds[i++];
    if (r && "__throw" in r) throw new Error((r as { __throw: string }).__throw);
    return r as RuntimeAgentCallerOutput;
  };
}

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

/** Input with NO truth_snapshot — classifier must derive explicit_cancellation_request from user_message. */
function makeProductionInput(userMessage: string): RuntimeAgentTurnInput {
  return {
    clinic_id: "clinic_1",
    contact_id: "contact_1",
    case_id: "case_1",
    user_message: userMessage,
    locale: "ru",
    channel_contact: { phone_number: "+420123456789", phone_source: "telegram_contact_button" },
    // NO truth_snapshot — production path must derive it from user_message
  };
}

// PROD-1: Real cancellation message → classifier yields true → mutation allowed
test("PROD-1: 'Отмените мою запись' without truth_snapshot → classifier allows cancel → 1 mutation", async () => {
  const { executor: cancelExecutor, mutationCount } = makeCancelExecutor();

  const agent = createRuntimeAgentLoop({
    model: "gpt-test",
    caller: makeCallSequence([
      { type: "tool_requests", tool_requests: [{ tool: "appointment.lookup", call_id: "c1", arguments: { subject_id: "subject_1" } }] },
      { type: "tool_requests", tool_requests: [{ tool: "appointment.cancel", call_id: "c2", arguments: { subject_id: "subject_1", visit_id: "visit_1" } }] },
      { type: "final_response", final_response: { final_patient_reply: "Ваша запись отменена." } },
    ]),
    executors: {
      "appointment.lookup": makeLookupExecutor("visit_1"),
      "appointment.cancel": cancelExecutor,
    },
  });

  await agent.runTurn(makeProductionInput("Отмените мою запись"));
  assert.equal(mutationCount(), 1, "cancellation message must allow 1 mutation");
});

// PROD-2: View-only message → classifier yields false → 0 mutations
test("PROD-2: 'Покажи мою запись' without truth_snapshot → classifier blocks cancel → 0 mutations", async () => {
  const { executor: cancelExecutor, mutationCount } = makeCancelExecutor();

  const agent = createRuntimeAgentLoop({
    model: "gpt-test",
    caller: makeCallSequence([
      { type: "tool_requests", tool_requests: [{ tool: "appointment.cancel", call_id: "c1", arguments: { subject_id: "subject_1", visit_id: "visit_1" } }] },
      { type: "final_response", final_response: { final_patient_reply: "Вот ваша запись." } },
    ]),
    executors: {
      "appointment.cancel": cancelExecutor,
    },
  });

  await agent.runTurn(makeProductionInput("Покажи мою запись"));
  assert.equal(mutationCount(), 0, "non-cancel message must block all mutations");
});

// PROD-3: Negated cancel → classifier yields false → 0 mutations
test("PROD-3: 'Не отменяйте запись' without truth_snapshot → classifier blocks cancel → 0 mutations", async () => {
  const { executor: cancelExecutor, mutationCount } = makeCancelExecutor();

  const agent = createRuntimeAgentLoop({
    model: "gpt-test",
    caller: makeCallSequence([
      { type: "tool_requests", tool_requests: [{ tool: "appointment.cancel", call_id: "c1", arguments: { subject_id: "subject_1", visit_id: "visit_1" } }] },
      { type: "final_response", final_response: { final_patient_reply: "Хорошо." } },
    ]),
    executors: {
      "appointment.cancel": cancelExecutor,
    },
  });

  await agent.runTurn(makeProductionInput("Не отменяйте мою запись"));
  assert.equal(mutationCount(), 0, "negated cancel message must block all mutations");
});

// PROD-4: English direct cancel → classifier yields true → 1 mutation
test("PROD-4: 'Please cancel my appointment' without truth_snapshot → classifier allows cancel → 1 mutation", async () => {
  const { executor: cancelExecutor, mutationCount } = makeCancelExecutor();

  const agent = createRuntimeAgentLoop({
    model: "gpt-test",
    caller: makeCallSequence([
      { type: "tool_requests", tool_requests: [{ tool: "appointment.lookup", call_id: "c1", arguments: { subject_id: "subject_1" } }] },
      { type: "tool_requests", tool_requests: [{ tool: "appointment.cancel", call_id: "c2", arguments: { subject_id: "subject_1", visit_id: "visit_2" } }] },
      { type: "final_response", final_response: { final_patient_reply: "Your appointment has been cancelled." } },
    ]),
    executors: {
      "appointment.lookup": makeLookupExecutor("visit_2"),
      "appointment.cancel": cancelExecutor,
    },
  });

  await agent.runTurn(makeProductionInput("Please cancel my appointment"));
  assert.equal(mutationCount(), 1, "English cancel message must allow 1 mutation");
});

// ── False-positive regression tests (hypothetical / deliberative / informational) ─

test("CLASSIFIER-9: English question 'Should I cancel my appointment?' → false", () => {
  assert.equal(detectExplicitCancellationRequest("Should I cancel my appointment?"), false);
});

test("CLASSIFIER-10: English question 'Can I cancel my appointment?' → false", () => {
  assert.equal(detectExplicitCancellationRequest("Can I cancel my appointment?"), false);
});

test("CLASSIFIER-11: English deliberative 'I might cancel my appointment.' → false", () => {
  assert.equal(detectExplicitCancellationRequest("I might cancel my appointment."), false);
});

test("CLASSIFIER-12: English deliberative 'I\\'m thinking about cancelling my appointment.' → false", () => {
  assert.equal(detectExplicitCancellationRequest("I'm thinking about cancelling my appointment."), false);
});

test("CLASSIFIER-13: English hypothetical 'Would it be better to cancel my appointment?' → false", () => {
  assert.equal(detectExplicitCancellationRequest("Would it be better to cancel my appointment?"), false);
});

test("CLASSIFIER-14: Russian deliberative 'Стоит ли отменить запись?' → false", () => {
  assert.equal(detectExplicitCancellationRequest("Стоит ли отменить запись?"), false);
});

test("CLASSIFIER-15: Russian question 'Нужно ли отменить запись?' → false", () => {
  assert.equal(detectExplicitCancellationRequest("Нужно ли отменить запись?"), false);
});

test("CLASSIFIER-16: Russian deliberative 'Я думаю отменить запись.' → false", () => {
  assert.equal(detectExplicitCancellationRequest("Я думаю отменить запись."), false);
});

test("CLASSIFIER-17: Russian deliberative 'Может отменить запись?' → false", () => {
  assert.equal(detectExplicitCancellationRequest("Может отменить запись?"), false);
});

test("CLASSIFIER-18: Russian hypothetical 'Что будет, если я отменю запись?' → false", () => {
  assert.equal(detectExplicitCancellationRequest("Что будет, если я отменю запись?"), false);
});

test("CLASSIFIER-19: Czech question 'Mám zrušit návštěvu?' → false", () => {
  assert.equal(detectExplicitCancellationRequest("Mám zrušit návštěvu?"), false);
});

test("CLASSIFIER-20: Czech question 'Mohu zrušit návštěvu?' → false", () => {
  assert.equal(detectExplicitCancellationRequest("Mohu zrušit návštěvu?"), false);
});

test("CLASSIFIER-21: Czech deliberative 'Přemýšlím o zrušení návštěvy.' → false", () => {
  assert.equal(detectExplicitCancellationRequest("Přemýšlím o zrušení návštěvy."), false);
});

// ── New production-path tests for false-positive scenarios ────────────────────

// PROD-5: English hypothetical → classifier blocks erroneous model cancel → 0 mutations
test("PROD-5: 'Should I cancel my appointment?' + erroneous model cancel → 0 mutations", async () => {
  const { executor: cancelExecutor, mutationCount } = makeCancelExecutor();

  const agent = createRuntimeAgentLoop({
    model: "gpt-test",
    caller: makeCallSequence([
      { type: "tool_requests", tool_requests: [{ tool: "appointment.cancel", call_id: "c1", arguments: { subject_id: "subject_1", visit_id: "visit_1" } }] },
      { type: "final_response", final_response: { final_patient_reply: "Let me explain your options." } },
    ]),
    executors: {
      "appointment.cancel": cancelExecutor,
    },
  });

  await agent.runTurn(makeProductionInput("Should I cancel my appointment?"));
  assert.equal(mutationCount(), 0, "hypothetical English cancel must block all mutations");
});

// PROD-6: Russian deliberative → classifier blocks erroneous model cancel → 0 mutations
test("PROD-6: 'Стоит ли отменить запись?' + erroneous model cancel → 0 mutations", async () => {
  const { executor: cancelExecutor, mutationCount } = makeCancelExecutor();

  const agent = createRuntimeAgentLoop({
    model: "gpt-test",
    caller: makeCallSequence([
      { type: "tool_requests", tool_requests: [{ tool: "appointment.cancel", call_id: "c1", arguments: { subject_id: "subject_1", visit_id: "visit_1" } }] },
      { type: "final_response", final_response: { final_patient_reply: "Позвольте объяснить." } },
    ]),
    executors: {
      "appointment.cancel": cancelExecutor,
    },
  });

  await agent.runTurn(makeProductionInput("Стоит ли отменить запись?"));
  assert.equal(mutationCount(), 0, "deliberative Russian cancel must block all mutations");
});

// PROD-7: Unambiguous Russian imperative + same-subject lookup proof → exactly 1 mutation
// subject_1 is used because gate D in the cancel executor requires a registry for subject_2+
test("PROD-7: 'Отмените мою запись' + valid same-subject lookup → exactly 1 mutation", async () => {
  const { executor: cancelExecutor, mutationCount } = makeCancelExecutor();

  const agent = createRuntimeAgentLoop({
    model: "gpt-test",
    caller: makeCallSequence([
      { type: "tool_requests", tool_requests: [{ tool: "appointment.lookup", call_id: "c1", arguments: { subject_id: "subject_1" } }] },
      { type: "tool_requests", tool_requests: [{ tool: "appointment.cancel", call_id: "c2", arguments: { subject_id: "subject_1", visit_id: "visit_7" } }] },
      { type: "final_response", final_response: { final_patient_reply: "Ваша запись отменена." } },
    ]),
    executors: {
      "appointment.lookup": makeLookupExecutor("visit_7"),
      "appointment.cancel": cancelExecutor,
    },
  });

  await agent.runTurn(makeProductionInput("Отмените мою запись"));
  assert.equal(mutationCount(), 1, "unambiguous imperative with lookup proof must produce exactly 1 mutation");
});
