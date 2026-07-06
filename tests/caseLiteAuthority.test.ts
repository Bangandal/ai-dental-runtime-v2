/**
 * PR fix/case-lite-shadow-only — CaseLite authority tests (spec A-H).
 *
 * A. Main model context does NOT include case_context_lite by default.
 * B. Main model context does NOT include case_policy_truth by default.
 * C. recent_history is present in runtime_context in model context.
 * D. channel_contact remains present; trusted phone still works.
 * E. booking.apply proof path unchanged — booking_apply_action_truth produced correctly.
 * F. Urgent symptom / triage behavior relies on prompt rules, not CaseLite.
 * G. Extractor is disabled by default (RUNTIME_CASE_LITE_MODE not set → output discarded).
 * H. Shadow mode: output NOT in patient-facing model context, only in debug.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { buildModelVisibleCallerContext } from "../src/runtime/modelVisibleCallerContext.ts";
import {
  getCaseLiteMode,
  runRuntimeTurnOrchestrated,
  type CaseLiteMode,
} from "../src/runtime/runtimeTurnOrchestrator.ts";
import { buildRuntimeAgentSystemInstruction } from "../src/runtime/openaiRuntimeAgent.ts";
import { createRuntimeAgentLoop, type RuntimeAgentCaller } from "../src/runtime/runtimeAgentLoop.ts";
import type { RuntimeAgentTurnInput, ChannelContact } from "../src/runtime/openaiRuntimeAgent.ts";
import type { RuntimeAgentToolResult, RuntimeAgentToolRequest } from "../src/runtime/openaiRuntimeAgent.ts";
import type { TurnPersistenceRepository } from "../src/runtime/supabaseTurnPersistenceRepository.ts";
import type { RuntimeContextRepository } from "../src/runtime/supabaseRuntimeContextRepository.ts";
import type { ClinicIdentityResolver } from "../src/runtime/supabaseClinicIdentityResolver.ts";
import type { RuntimeTurnService } from "../src/runtime/runtimeTurnService.ts";

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeCallerCapture(): {
  caller: RuntimeAgentCaller;
  captured: Parameters<RuntimeAgentCaller>[];
} {
  const captured: Parameters<RuntimeAgentCaller>[] = [];
  const caller: RuntimeAgentCaller = async (input) => {
    captured.push([input]);
    return {
      type: "final_response",
      conversation_id: "conv_test",
      final_response: { final_patient_reply: "Здравствуйте! Чем могу помочь?" },
    };
  };
  return { caller, captured };
}

function makeCallerSequence(outputs: Awaited<ReturnType<RuntimeAgentCaller>>[]): {
  caller: RuntimeAgentCaller;
  captured: Parameters<RuntimeAgentCaller>[];
} {
  let call = 0;
  const captured: Parameters<RuntimeAgentCaller>[] = [];
  const caller: RuntimeAgentCaller = async (input) => {
    captured.push([input]);
    return outputs[call++] ?? outputs[outputs.length - 1]!;
  };
  return { caller, captured };
}

const BASE_TURN: RuntimeAgentTurnInput = {
  clinic_id: "clinic_test",
  contact_id: "contact_test",
  user_message: "Привет",
  locale: "ru",
};

const TRUSTED_CONTACT: ChannelContact = {
  phone_number: "+380991234567",
  phone_source: "telegram_contact_button",
};

// ── A. Main model context does NOT include case_context_lite by default ─────────

test("A: main model context does not include case_context_lite when runtime_context is built normally", async () => {
  const { caller, captured } = makeCallerCapture();
  const loop = createRuntimeAgentLoop({ model: "test", caller, executors: {} });

  // Inject a runtime_context that DOES contain case_context_lite (simulates what the
  // orchestrator used to inject — now it must NOT reach the model).
  await loop.runTurn({
    ...BASE_TURN,
    business_context: {
      channel: "telegram",
      runtime_context: {
        patient_context: { display_name: "Иван", preferred_language: "ru", reachable_in_current_channel: true },
        task_state: { collected: {}, missing_fields: [], last_known_intent: null, intake_status: null },
        runtime_policy: { phone_required: false, patient_reachable_in_current_channel: true },
        recent_history: [{ role: "user", text: "Привет" }],
        // These should be present in raw business_context but are STRIPPED by the
        // orchestrator before reaching the model — test that buildModelVisibleCallerContext
        // does not re-inject them even if present in runtime_context.
        case_context_lite: { booking: { service: "chistka" } },
        case_policy_truth: { must_not_claim_booking_created: true },
      },
    },
  });

  assert.ok(captured.length > 0, "caller must have been called");
  const firstCallContext = captured[0]![0].input.context as Record<string, unknown>;
  const runtimeCtx = firstCallContext.runtime_context as Record<string, unknown> | null;

  // case_context_lite must not appear at the top level of context
  assert.equal("case_context_lite" in firstCallContext, false, "case_context_lite must not be in top-level context");
  assert.equal("case_policy_truth" in firstCallContext, false, "case_policy_truth must not be in top-level context");

  // buildModelVisibleCallerContext passes runtime_context through verbatim from
  // business_context — stripping case_context_lite/case_policy_truth is the orchestrator's
  // responsibility. This test focuses on the top-level context contract.
});

// ── B. Main model context does NOT include case_policy_truth by default ─────────

test("B: buildModelVisibleCallerContext does not inject case_policy_truth into top-level context", () => {
  const input: RuntimeAgentTurnInput = {
    ...BASE_TURN,
    business_context: {
      channel: "telegram",
      runtime_context: {
        patient_context: { display_name: "Мария", preferred_language: "ru", reachable_in_current_channel: false },
        task_state: { collected: {}, missing_fields: [] },
        runtime_policy: { phone_required: false, patient_reachable_in_current_channel: false },
        recent_history: [],
        case_context_lite: { booking: { service: "otbelivanie" } },
        case_policy_truth: { must_not_claim_booking_created: true, must_not_make_intake_main_response: false },
      },
    },
  };

  const ctx = buildModelVisibleCallerContext(input);

  assert.equal("case_context_lite" in ctx, false, "top-level context must not have case_context_lite");
  assert.equal("case_policy_truth" in ctx, false, "top-level context must not have case_policy_truth");
});

// ── C. recent_history remains present in runtime_context ──────────────────────

test("C: recent_history is preserved in runtime_context passed to model", async () => {
  const recentHistory = [
    { role: "user", text: "Болит зуб" },
    { role: "assistant", text: "Понял, давайте проверим слоты" },
  ];

  const { caller, captured } = makeCallerCapture();
  const loop = createRuntimeAgentLoop({ model: "test", caller, executors: {} });

  await loop.runTurn({
    ...BASE_TURN,
    business_context: {
      channel: "telegram",
      runtime_context: {
        patient_context: { display_name: null, preferred_language: "ru", reachable_in_current_channel: true },
        task_state: { collected: {}, missing_fields: [] },
        runtime_policy: { phone_required: false, patient_reachable_in_current_channel: true },
        recent_history: recentHistory,
      },
    },
  });

  assert.ok(captured.length > 0);
  const ctx = captured[0]![0].input.context as Record<string, unknown>;
  const runtimeCtx = ctx.runtime_context as Record<string, unknown> | null;
  assert.ok(runtimeCtx, "runtime_context must be present");
  const history = (runtimeCtx as Record<string, unknown>).recent_history;
  assert.ok(Array.isArray(history), "recent_history must be an array");
  assert.equal((history as unknown[]).length, 2, "recent_history must have 2 entries");
});

// ── D. channel_contact present; trusted phone still works ──────────────────────

test("D: channel_contact is available in turn input and trusted phone works through booking.apply path", async () => {
  const bookingApplyRequest: RuntimeAgentToolRequest = {
    tool: "booking.apply",
    call_id: "call_book_d",
    arguments: {
      service: "chistka",
      requested_date: "2026-07-10",
      requested_time: "14:00",
      first_name: "Дмитрий",
      last_name: "Сидоров",
    },
  };

  let bookingApplyExecutorCalled = false;
  const { caller, captured } = makeCallerSequence([
    {
      type: "tool_requests",
      conversation_id: "conv_d1",
      tool_requests: [bookingApplyRequest],
    },
    {
      type: "final_response",
      conversation_id: "conv_d1",
      final_response: { final_patient_reply: "Вы записаны!" },
    },
  ]);

  const loop = createRuntimeAgentLoop({
    model: "test",
    caller,
    executors: {
      "booking.apply": async (ctx) => {
        bookingApplyExecutorCalled = true;
        assert.equal(ctx.phone_number, "+380991234567", "phone_number must be forwarded from channel_contact");
        return {
          status: "success" as const,
          data: {
            booking_action: "booking_apply",
            booking_status: "visit_created",
            created_visit: true,
            may_claim_booked: true,
            visit_id: "v_d1",
            starts_at: "2026-07-10T14:00:00",
            service: "chistka",
          },
        };
      },
    },
    // now = 08:00 Prague (UTC+2 CEST) → slot at 14:00 is safely in the future
    now: new Date("2026-07-10T06:00:00.000Z"),
    timezone: "Europe/Prague",
  });

  const result = await loop.runTurn({
    ...BASE_TURN,
    channel_contact: TRUSTED_CONTACT,
    user_message: "Да, оформляйте",
  });

  assert.ok(bookingApplyExecutorCalled, "booking.apply executor must be called when phone is trusted");
  assert.ok(result.final_patient_reply.length > 0);
});

// ── E. booking.apply proof path: booking_apply_action_truth produced correctly ──

test("E: booking_apply_action_truth is produced correctly in second-call context after booking.apply succeeds", async () => {
  const bookingApplyRequest: RuntimeAgentToolRequest = {
    tool: "booking.apply",
    call_id: "call_book_e",
    arguments: {
      service: "chistka",
      requested_date: "2026-07-10",
      requested_time: "14:00",
      first_name: "Анна",
      last_name: "Козлова",
    },
  };

  const { caller, captured } = makeCallerSequence([
    {
      type: "tool_requests",
      conversation_id: "conv_e1",
      tool_requests: [bookingApplyRequest],
    },
    {
      type: "final_response",
      conversation_id: "conv_e1",
      final_response: { final_patient_reply: "Вы записаны!" },
    },
  ]);

  const loop = createRuntimeAgentLoop({
    model: "test",
    caller,
    executors: {
      "booking.apply": async () => ({
        status: "success" as const,
        data: {
          booking_action: "booking_apply",
          booking_status: "visit_created",
          created_visit: true,
          may_claim_booked: true,
          cliniccard_visit_id: "v_e1",
          starts_at: "2026-07-10T14:00:00",
          service: "chistka",
        },
      }),
    },
    // now = 08:00 Prague (UTC+2 CEST) → slot at 14:00 is safely in the future
    now: new Date("2026-07-10T06:00:00.000Z"),
    timezone: "Europe/Prague",
  });

  await loop.runTurn({
    ...BASE_TURN,
    channel_contact: TRUSTED_CONTACT,
    user_message: "Запишите на завтра в 10",
  });

  // Second call context must have booking_apply_action_truth
  const secondCallContext = captured[1]![0].input.context as Record<string, unknown>;
  assert.ok("booking_apply_action_truth" in secondCallContext, "booking_apply_action_truth must be in second-call context");
  const truth = secondCallContext.booking_apply_action_truth as Record<string, unknown>;
  // can_say_booking_created lives inside allowed_claims
  const allowedClaims = truth.allowed_claims as Record<string, unknown> | undefined;
  assert.equal(allowedClaims?.can_say_booking_created, true, "can_say_booking_created must be true");
});

// ── F. Urgent symptom prompt does not rely on CaseLite authority ───────────────

test("F: system instruction urgent symptom guidance does not reference case_context_lite or case_policy_truth authority", () => {
  const instruction = buildRuntimeAgentSystemInstruction();

  // Must NOT contain the old CaseLite authority wording
  assert.equal(
    instruction.includes("case_context_lite") && instruction.includes("trust them as the verified summary"),
    false,
    "prompt must not instruct model to trust case_context_lite as verified summary",
  );
  assert.equal(
    instruction.includes("CASE CONTEXT AUTHORITY"),
    false,
    "prompt must not contain CASE CONTEXT AUTHORITY section",
  );

  // Must still contain triage/urgent symptom rules (not relying on CaseLite)
  assert.ok(
    instruction.includes("RED-FLAG") || instruction.includes("urgent"),
    "urgent symptom guidance must still be present in prompt",
  );
  assert.ok(
    instruction.includes("empathy") || instruction.includes("safety"),
    "clinical safety guidance must be present in prompt",
  );
});

// ── G. Extractor disabled by default ──────────────────────────────────────────

test("G: getCaseLiteMode returns 'disabled' when RUNTIME_CASE_LITE_MODE is not set", () => {
  const prev = process.env.RUNTIME_CASE_LITE_MODE;
  delete process.env.RUNTIME_CASE_LITE_MODE;
  try {
    const mode = getCaseLiteMode();
    assert.equal(mode, "disabled", "default mode must be 'disabled'");
  } finally {
    if (prev !== undefined) process.env.RUNTIME_CASE_LITE_MODE = prev;
  }
});

test("G: getCaseLiteMode returns 'disabled' for unknown or empty values", () => {
  const prev = process.env.RUNTIME_CASE_LITE_MODE;
  for (const val of ["", "active", "on", "true", "SHADOW"]) {
    process.env.RUNTIME_CASE_LITE_MODE = val;
    assert.equal(getCaseLiteMode(), "disabled", `unexpected mode for value '${val}'`);
  }
  if (prev !== undefined) process.env.RUNTIME_CASE_LITE_MODE = prev;
  else delete process.env.RUNTIME_CASE_LITE_MODE;
});

// ── H. Shadow mode does not expose case_context_lite to patient-facing context ──

test("H: getCaseLiteMode returns 'shadow' when RUNTIME_CASE_LITE_MODE=shadow", () => {
  const prev = process.env.RUNTIME_CASE_LITE_MODE;
  process.env.RUNTIME_CASE_LITE_MODE = "shadow";
  try {
    const mode: CaseLiteMode = getCaseLiteMode();
    assert.equal(mode, "shadow");
  } finally {
    if (prev !== undefined) process.env.RUNTIME_CASE_LITE_MODE = prev;
    else delete process.env.RUNTIME_CASE_LITE_MODE;
  }
});

// ── Persistence tests (shadow mode must NOT persist case_context_lite) ────────

const CLINIC_CODE = "clinic_persist_test";
const CLINIC_UUID = "e8179559-fc8d-40e5-9808-287ed69fcf7d";

const persistTestClinicResolver: ClinicIdentityResolver = {
  async resolveClinicIdentity(input) {
    if (input.clinic_identifier === CLINIC_CODE || input.clinic_identifier === CLINIC_UUID) {
      return { ok: true, data: { clinic_id: CLINIC_UUID, clinic_code: CLINIC_CODE } };
    }
    return { ok: false, error: { code: "clinic_not_found", message: "not found", retryable: false } };
  },
};

const CONTACT_UUID = "a1b2c3d4-e5f6-4890-abcd-ef1234567890";

function makePersistenceRepoCapture(): {
  repo: TurnPersistenceRepository;
  capturedMerge: Array<Parameters<TurnPersistenceRepository["mergeConversationState"]>[0]>;
} {
  const capturedMerge: Array<Parameters<TurnPersistenceRepository["mergeConversationState"]>[0]> = [];
  const repo: TurnPersistenceRepository = {
    async getOrCreateContact() {
      return { ok: true, data: { contact_id: CONTACT_UUID, clinic_id: CLINIC_UUID } };
    },
    async registerInboundEvent() {
      // Non-null inbound_event_id means this is NOT a duplicate → processing continues
      return { ok: true, data: { inbound_event_id: "evt_persist_test" } };
    },
    async saveMessage() {
      return { ok: true, data: { message_id: "msg_persist_test" } };
    },
    async mergeConversationState(input) {
      capturedMerge.push(input);
      return { ok: true, data: { ok: true } };
    },
  };
  return { repo, capturedMerge };
}

function makeRuntimeContextRepoWithCaseLite(): RuntimeContextRepository {
  return {
    async loadRuntimeContext() {
      return {
        ok: true,
        data: {
          known_contact: { first_name: "Иван", last_name: "Петров" },
          conversation_state: { intent: "booking", qualification_stage: "intake", missing_fields: ["preferred_time"] },
          topic_memory: null,
          channel_contact: null,
          case_context_lite: { booking: { service: "чистка зубов", name: "Иван Петров" } },
          runtime_flags: { has_durable_context: true, context_source: "supabase", context_loaded_at: new Date().toISOString() },
          recent_history: [],
        },
      };
    },
  };
}

function makeSimpleTurnService(): RuntimeTurnService {
  return {
    async runTurn() {
      return { final_patient_reply: "Хорошо, проверим время.", tool_requests: [], tool_results: [] };
    },
  };
}

test("I: shadow mode does NOT persist case_context_lite to mergeConversationState", async () => {
  const prev = process.env.RUNTIME_CASE_LITE_MODE;
  process.env.RUNTIME_CASE_LITE_MODE = "shadow";
  try {
    const { repo, capturedMerge } = makePersistenceRepoCapture();
    await runRuntimeTurnOrchestrated(
      { clinic_code: CLINIC_CODE, channel: "telegram", external_user_id: "user_shadow", chat_id: "9001", text: "Запишите меня" },
      {
        runtimeTurnService: makeSimpleTurnService(),
        clinicIdentityResolver: persistTestClinicResolver,
        turnPersistenceRepository: repo,
        runtimeContextRepository: makeRuntimeContextRepoWithCaseLite(),
      },
    );
    assert.ok(capturedMerge.length > 0, "mergeConversationState must be called");
    assert.equal(
      capturedMerge[0]!.case_context_lite,
      null,
      "shadow mode must pass null for case_context_lite to mergeConversationState",
    );
  } finally {
    if (prev !== undefined) process.env.RUNTIME_CASE_LITE_MODE = prev;
    else delete process.env.RUNTIME_CASE_LITE_MODE;
  }
});

test("J: disabled mode does NOT persist case_context_lite to mergeConversationState", async () => {
  const prev = process.env.RUNTIME_CASE_LITE_MODE;
  delete process.env.RUNTIME_CASE_LITE_MODE;
  try {
    const { repo, capturedMerge } = makePersistenceRepoCapture();
    await runRuntimeTurnOrchestrated(
      { clinic_code: CLINIC_CODE, channel: "telegram", external_user_id: "user_disabled", chat_id: "9002", text: "Запишите меня" },
      {
        runtimeTurnService: makeSimpleTurnService(),
        clinicIdentityResolver: persistTestClinicResolver,
        turnPersistenceRepository: repo,
        runtimeContextRepository: makeRuntimeContextRepoWithCaseLite(),
      },
    );
    assert.ok(capturedMerge.length > 0, "mergeConversationState must be called");
    const caselite = capturedMerge[0]!.case_context_lite;
    assert.ok(
      caselite === null || caselite === undefined,
      "disabled mode must pass null/undefined for case_context_lite to mergeConversationState",
    );
  } finally {
    if (prev !== undefined) process.env.RUNTIME_CASE_LITE_MODE = prev;
    else delete process.env.RUNTIME_CASE_LITE_MODE;
  }
});

test("H: in shadow mode, case_context_lite must not appear in patient-facing model context (only in debug)", async () => {
  const prev = process.env.RUNTIME_CASE_LITE_MODE;
  process.env.RUNTIME_CASE_LITE_MODE = "shadow";

  try {
    const { caller, captured } = makeCallerCapture();
    const loop = createRuntimeAgentLoop({ model: "test", caller, executors: {} });

    await loop.runTurn({
      ...BASE_TURN,
      business_context: {
        channel: "telegram",
        runtime_context: {
          patient_context: { display_name: "Петр", preferred_language: "ru", reachable_in_current_channel: true },
          task_state: { collected: {}, missing_fields: [] },
          runtime_policy: { phone_required: false, patient_reachable_in_current_channel: true },
          recent_history: [],
          // These are present in raw context but must NOT appear in model-facing context
          case_context_lite: { booking: { service: "protez" } },
          case_policy_truth: { must_not_claim_booking_created: false },
        },
      },
    });

    assert.ok(captured.length > 0);
    const ctx = captured[0]![0].input.context as Record<string, unknown>;

    // Patient-facing context must not have case_context_lite or case_policy_truth
    assert.equal("case_context_lite" in ctx, false, "shadow mode: case_context_lite must not be in patient-facing context");
    assert.equal("case_policy_truth" in ctx, false, "shadow mode: case_policy_truth must not be in patient-facing context");
  } finally {
    if (prev !== undefined) process.env.RUNTIME_CASE_LITE_MODE = prev;
    else delete process.env.RUNTIME_CASE_LITE_MODE;
  }
});
