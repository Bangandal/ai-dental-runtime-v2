/**
 * PR #141 — bookingApplyPreflight tests.
 *
 * Test 1 (no-slots preflight): availability.check returns 0 slots + trusted phone +
 * model requests booking.apply in round 2 → booking.apply executor NOT called,
 * reply says no slots, conversation dirty.
 *
 * Test 2 (missing trusted phone with valid slot): availability.check returns ≥1 slot +
 * no trusted phone + model requests booking.apply in round 2 → Guard A fires,
 * contact button returned, booking.apply executor NOT called.
 *
 * Test 3 (trusted phone + no slot in round-1 args): model requests booking.apply in round 1
 * with trusted phone but without requested_date/requested_time → Guard D fires,
 * executor NOT called, reply asks to choose a slot, conversation_id_resumable=false.
 *
 * Test 4 (name/service missing): model requests booking.apply with date+time but without
 * first_name or last_name → Guard E fires, executor NOT called, reply asks only the
 * missing field, conversation_id_resumable=false.
 *
 * Test 5 (full proof + BOOKING_MODE=disabled): all required fields present but mode disabled
 * → existing disabled behavior: booking_write_disabled returned, no ClinicCard write,
 * created_visit=false, may_claim_booked=false.
 *
 * Test 6 (golden flow regression): "болит зуб, записаться" → name Роман Анбасадоров +
 * "как можно скорее" → availability.check returns 0 slots → model tries booking.apply
 * → booking.apply executor NOT called, no booking_write_disabled, reply asks another time,
 * conversation_id_resumable=false.
 *
 * Test 7: all prior tests in this file and the core booking guard suites still pass
 * (enforced by running the full test suite — no dedicated test needed beyond the ones above).
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  hasAvailabilitySuccessWithNoSlots,
  shouldInterceptMissingPhoneBeforeBookingApply,
  shouldInterceptNoSlotsBeforeBookingApply,
  buildNoSlotsPreflightReply,
  bookingApplyArgsMissingSlot,
  getMissingBookingApplyNameFields,
  buildMissingSlotReply,
  buildMissingNameFieldsReply,
  bookingApplyArgsMissingService,
  buildMissingServiceReply,
  shouldInterceptInvalidSlotTime,
  buildInvalidSlotReply,
} from "../src/runtime/bookingApplyPreflight.ts";
import { createBookingApplyExecutor } from "../src/integrations/cliniccard/bookingApplyExecutor.ts";
import type { ClinicCardAdapter } from "../src/integrations/cliniccard/clinicCardAdapter.ts";
import { createRuntimeAgentLoop, type RuntimeAgentCaller } from "../src/runtime/runtimeAgentLoop.ts";
import type {
  RuntimeAgentToolRequest,
  RuntimeAgentToolResult,
  ChannelContact,
} from "../src/runtime/openaiRuntimeAgent.ts";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const SLOT = { slot_id: "2026-07-09T12:00", starts_at: "2026-07-09T12:00:00", ends_at: "2026-07-09T12:30:00" };

const AVAILABILITY_SUCCESS: RuntimeAgentToolResult = {
  tool: "availability.check",
  call_id: "call_avail_1",
  status: "success",
  data: { slots: [SLOT], total_slots: 1, free_slots_count: 1 },
};

const AVAILABILITY_EMPTY: RuntimeAgentToolResult = {
  tool: "availability.check",
  call_id: "call_avail_2",
  status: "success",
  data: { slots: [], total_slots: 0, free_slots_count: 0 },
};

const AVAILABILITY_FAILED: RuntimeAgentToolResult = {
  tool: "availability.check",
  call_id: "call_avail_3",
  status: "failed",
  error: { code: "adapter_error", message: "timeout" },
};

const BOOKING_APPLY_REQUEST: RuntimeAgentToolRequest = {
  tool: "booking.apply",
  call_id: "call_book_1",
  arguments: {
    service: "chistka",
    requested_date: "2026-07-09",
    requested_time: "12:00",
    first_name: "Роман",
    last_name: "Ансамблев",
  },
};

const AVAILABILITY_REQUEST: RuntimeAgentToolRequest = {
  tool: "availability.check",
  call_id: "call_avail_req_1",
  arguments: { service_interest: "chistka", requested_date: "2026-07-09" },
};

const TRUSTED_CONTACT: ChannelContact = {
  phone_number: "+380991350135",
  phone_source: "telegram_contact_button",
};

const BASE_TURN_INPUT = {
  clinic_id: "clinic_1",
  contact_id: "contact_1",
  case_id: null,
  conversation_id: "conv_141_test",
  user_message: "Запишите меня",
  locale: "ru",
  trace_id: "trace_pr141",
};

function makeCallerSequence(outputs: Awaited<ReturnType<RuntimeAgentCaller>>[]): RuntimeAgentCaller {
  let call = 0;
  return async () => outputs[call++] ?? outputs[outputs.length - 1];
}

// ── Unit: hasAvailabilitySuccessWithNoSlots ───────────────────────────────────

test("hasAvailabilitySuccessWithNoSlots: true when slots array is empty", () => {
  assert.equal(hasAvailabilitySuccessWithNoSlots([AVAILABILITY_EMPTY]), true);
});

test("hasAvailabilitySuccessWithNoSlots: false when slots present", () => {
  assert.equal(hasAvailabilitySuccessWithNoSlots([AVAILABILITY_SUCCESS]), false);
});

test("hasAvailabilitySuccessWithNoSlots: false when availability.check failed", () => {
  assert.equal(hasAvailabilitySuccessWithNoSlots([AVAILABILITY_FAILED]), false);
});

test("hasAvailabilitySuccessWithNoSlots: false for empty results list", () => {
  assert.equal(hasAvailabilitySuccessWithNoSlots([]), false);
});

// ── Unit: shouldInterceptMissingPhoneBeforeBookingApply ───────────────────────

test("shouldInterceptMissingPhoneBeforeBookingApply: true when booking.apply pending and no phone", () => {
  assert.equal(
    shouldInterceptMissingPhoneBeforeBookingApply({
      pendingToolRequests: [BOOKING_APPLY_REQUEST],
      channelContact: undefined,
    }),
    true,
  );
});

test("shouldInterceptMissingPhoneBeforeBookingApply: true when phone_source is untrusted (manual_input)", () => {
  assert.equal(
    shouldInterceptMissingPhoneBeforeBookingApply({
      pendingToolRequests: [BOOKING_APPLY_REQUEST],
      channelContact: { phone_number: "+1", phone_source: "manual_input" },
    }),
    true,
  );
});

test("shouldInterceptMissingPhoneBeforeBookingApply: false when trusted phone present", () => {
  assert.equal(
    shouldInterceptMissingPhoneBeforeBookingApply({
      pendingToolRequests: [BOOKING_APPLY_REQUEST],
      channelContact: TRUSTED_CONTACT,
    }),
    false,
  );
});

test("shouldInterceptMissingPhoneBeforeBookingApply: false when no booking.apply pending", () => {
  assert.equal(
    shouldInterceptMissingPhoneBeforeBookingApply({
      pendingToolRequests: [AVAILABILITY_REQUEST],
      channelContact: undefined,
    }),
    false,
  );
});

// ── Unit: shouldInterceptNoSlotsBeforeBookingApply ────────────────────────────

test("shouldInterceptNoSlotsBeforeBookingApply: true when booking.apply pending + trusted phone + 0 slots", () => {
  assert.equal(
    shouldInterceptNoSlotsBeforeBookingApply({
      pendingToolRequests: [BOOKING_APPLY_REQUEST],
      completedToolResults: [AVAILABILITY_EMPTY],
    }),
    true,
  );
});

test("shouldInterceptNoSlotsBeforeBookingApply: false when slots present", () => {
  assert.equal(
    shouldInterceptNoSlotsBeforeBookingApply({
      pendingToolRequests: [BOOKING_APPLY_REQUEST],
      completedToolResults: [AVAILABILITY_SUCCESS],
    }),
    false,
  );
});

test("shouldInterceptNoSlotsBeforeBookingApply: true even when no trusted phone (no-slots gate fires before phone guard)", () => {
  assert.equal(
    shouldInterceptNoSlotsBeforeBookingApply({
      pendingToolRequests: [BOOKING_APPLY_REQUEST],
      completedToolResults: [AVAILABILITY_EMPTY],
    }),
    true,
  );
});

test("shouldInterceptNoSlotsBeforeBookingApply: false when no booking.apply pending", () => {
  assert.equal(
    shouldInterceptNoSlotsBeforeBookingApply({
      pendingToolRequests: [AVAILABILITY_REQUEST],
      completedToolResults: [AVAILABILITY_EMPTY],
    }),
    false,
  );
});

// ── Unit: buildNoSlotsPreflightReply ─────────────────────────────────────────

test("buildNoSlotsPreflightReply: RU locale contains slot/slots keyword", () => {
  const reply = buildNoSlotsPreflightReply("ru");
  assert.ok(reply.length > 0);
  assert.ok(reply.includes("слот"), `RU reply should mention slots: ${reply}`);
});

test("buildNoSlotsPreflightReply: CS locale", () => {
  const reply = buildNoSlotsPreflightReply("cs");
  assert.ok(reply.includes("slot"), `CS reply should mention slot: ${reply}`);
});

test("buildNoSlotsPreflightReply: EN locale", () => {
  const reply = buildNoSlotsPreflightReply("en");
  assert.ok(reply.includes("slot"), `EN reply should mention slot: ${reply}`);
});

test("buildNoSlotsPreflightReply: defaults to RU for null locale", () => {
  const reply = buildNoSlotsPreflightReply(null);
  assert.ok(reply.includes("слот"));
});

// ── Integration Test 1: No-slots preflight ───────────────────────────────────
// availability.check returns 0 slots + trusted phone + model requests booking.apply
// → no-slots gate fires, booking.apply executor NOT called

test("runtimeAgentLoop: no-slots preflight — booking.apply not executed when 0 slots returned", async () => {
  let bookingApplyExecutorCalled = false;

  const caller = makeCallerSequence([
    {
      type: "tool_requests",
      conversation_id: "conv_141_1",
      tool_requests: [AVAILABILITY_REQUEST],
    },
    {
      type: "tool_requests",
      conversation_id: "conv_141_1",
      tool_requests: [BOOKING_APPLY_REQUEST],
    },
  ]);

  const loop = createRuntimeAgentLoop({
    model: "test-model",
    caller,
    executors: {
      "availability.check": async () => ({
        status: "success" as const,
        data: { slots: [], total_slots: 0, free_slots_count: 0 },
      }),
      "booking.apply": async () => {
        bookingApplyExecutorCalled = true;
        return {
          status: "success" as const,
          data: {
            booking_action: "booking_apply",
            booking_status: "booking_write_disabled",
            created_visit: false,
            may_claim_booked: false,
          },
        };
      },
    },
  });

  const result = await loop.runTurn({
    ...BASE_TURN_INPUT,
    conversation_id: "conv_141_1",
    channel_contact: TRUSTED_CONTACT,
  });

  // booking.apply executor must NOT have been called
  assert.equal(bookingApplyExecutorCalled, false, "booking.apply executor must not be called when 0 slots");

  // No booking_write_disabled in tool_results
  const bookingResult = result.tool_results?.find((r) => r.tool === "booking.apply");
  assert.equal(bookingResult, undefined, "booking.apply must not appear in tool_results");

  // Reply must mention no slots
  assert.ok(
    result.final_patient_reply.toLowerCase().includes("слот") ||
      result.final_patient_reply.toLowerCase().includes("slot"),
    `Reply must mention no slots: ${result.final_patient_reply}`,
  );

  // created_visit and may_claim_booked implied false — no booking result present
  // Conversation must be dirty / not resumable
  assert.equal(result.conversation_id, null, "conversation_id must be null (dirty)");
  assert.equal(result.conversation_id_resumable, false, "must not be resumable");

  // debug.reason identifies the no-slots intercept
  assert.equal(
    (result.debug as Record<string, unknown>)?.reason,
    "booking_apply_preflight_no_slots",
    "debug.reason must identify no-slots preflight",
  );
});

// ── Integration Test 2: Missing trusted phone with valid slot ─────────────────
// availability.check returns ≥1 slot + no trusted phone + model requests booking.apply
// → Guard A fires (contact button), booking.apply NOT executed

test("runtimeAgentLoop: Guard A fires when booking.apply pending and phone absent (valid slot present)", async () => {
  let bookingApplyExecutorCalled = false;

  const caller = makeCallerSequence([
    {
      type: "tool_requests",
      conversation_id: "conv_141_2",
      tool_requests: [AVAILABILITY_REQUEST],
    },
    {
      type: "tool_requests",
      conversation_id: "conv_141_2",
      tool_requests: [BOOKING_APPLY_REQUEST],
    },
  ]);

  const loop = createRuntimeAgentLoop({
    model: "test-model",
    caller,
    executors: {
      "availability.check": async () => ({
        status: "success" as const,
        data: { slots: [SLOT], total_slots: 1, free_slots_count: 1 },
      }),
      "booking.apply": async () => {
        bookingApplyExecutorCalled = true;
        return {
          status: "success" as const,
          data: {
            booking_action: "booking_apply",
            booking_status: "visit_created",
            created_visit: true,
            may_claim_booked: true,
            cliniccard_visit_id: "visit_999",
            cliniccard_patient_id: "patient_999",
            phone_source: "telegram_contact_button",
          },
        };
      },
    },
  });

  const result = await loop.runTurn({
    ...BASE_TURN_INPUT,
    conversation_id: "conv_141_2",
    channel_contact: undefined,
  });

  // booking.apply executor must NOT have been called
  assert.equal(bookingApplyExecutorCalled, false, "booking.apply executor must not be called when phone absent");

  // Contact button must be returned
  assert.equal(result.ui?.telegram?.request_contact, true, "ui.telegram.request_contact must be true");
  assert.ok(result.final_patient_reply.includes("телефон"), "reply must ask for phone number");

  // No ClinicCard write
  const bookingResult = result.tool_results?.find((r) => r.tool === "booking.apply");
  assert.equal(bookingResult, undefined, "booking.apply must not appear in tool_results");

  // Conversation dirty
  assert.equal(result.conversation_id, null);
  assert.equal(result.conversation_id_resumable, false);

  // debug.reason must identify Guard A intercept
  assert.equal(
    (result.debug as Record<string, unknown>)?.reason,
    "booking_apply_intercepted_missing_trusted_phone",
  );
});

// ── Unit: bookingApplyArgsMissingSlot ────────────────────────────────────────

test("bookingApplyArgsMissingSlot: true when both date and time absent", () => {
  assert.equal(bookingApplyArgsMissingSlot({}), true);
});

test("bookingApplyArgsMissingSlot: true when date present but time absent", () => {
  assert.equal(bookingApplyArgsMissingSlot({ requested_date: "2026-07-15" }), true);
});

test("bookingApplyArgsMissingSlot: true when time present but date absent", () => {
  assert.equal(bookingApplyArgsMissingSlot({ requested_time: "10:00" }), true);
});

test("bookingApplyArgsMissingSlot: false when both date and time present as non-empty strings", () => {
  assert.equal(bookingApplyArgsMissingSlot({ requested_date: "2026-07-15", requested_time: "10:00" }), false);
});

test("bookingApplyArgsMissingSlot: true when date is empty string", () => {
  assert.equal(bookingApplyArgsMissingSlot({ requested_date: "", requested_time: "10:00" }), true);
});

// ── Unit: getMissingBookingApplyNameFields ────────────────────────────────────

test("getMissingBookingApplyNameFields: empty list when both name fields present", () => {
  assert.deepEqual(getMissingBookingApplyNameFields({ first_name: "Роман", last_name: "Анбасадоров" }), []);
});

test("getMissingBookingApplyNameFields: [first_name] when only first_name absent", () => {
  assert.deepEqual(getMissingBookingApplyNameFields({ last_name: "Анбасадоров" }), ["first_name"]);
});

test("getMissingBookingApplyNameFields: [last_name] when only last_name absent", () => {
  assert.deepEqual(getMissingBookingApplyNameFields({ first_name: "Роман" }), ["last_name"]);
});

test("getMissingBookingApplyNameFields: [first_name, last_name] when both absent", () => {
  assert.deepEqual(getMissingBookingApplyNameFields({}), ["first_name", "last_name"]);
});

// ── Unit: buildMissingSlotReply ───────────────────────────────────────────────

test("buildMissingSlotReply: RU reply mentions date/time selection", () => {
  const reply = buildMissingSlotReply("ru");
  assert.ok(reply.length > 0);
  assert.ok(reply.includes("дату") || reply.includes("время") || reply.includes("слот"), `RU: ${reply}`);
});

test("buildMissingSlotReply: EN reply mentions date/time", () => {
  const reply = buildMissingSlotReply("en");
  assert.ok(reply.includes("date") || reply.includes("time") || reply.includes("slot"), `EN: ${reply}`);
});

test("buildMissingSlotReply: CS reply is non-empty", () => {
  assert.ok(buildMissingSlotReply("cs").length > 0);
});

test("buildMissingSlotReply: defaults to RU for null locale", () => {
  const ru = buildMissingSlotReply("ru");
  const def = buildMissingSlotReply(null);
  assert.equal(def, ru);
});

// ── Unit: buildMissingNameFieldsReply ────────────────────────────────────────

test("buildMissingNameFieldsReply: asks for both when both missing (RU)", () => {
  const reply = buildMissingNameFieldsReply(["first_name", "last_name"], "ru");
  assert.ok(reply.includes("имя") || reply.includes("фамилию"), `RU both: ${reply}`);
});

test("buildMissingNameFieldsReply: asks only for first_name when only first_name missing (RU)", () => {
  const reply = buildMissingNameFieldsReply(["first_name"], "ru");
  assert.ok(reply.includes("имя") || reply.includes("зовут"), `RU first_name: ${reply}`);
  assert.ok(!reply.includes("фамили"), `must not ask for last name when only first_name missing: ${reply}`);
});

test("buildMissingNameFieldsReply: asks only for last_name when only last_name missing (RU)", () => {
  const reply = buildMissingNameFieldsReply(["last_name"], "ru");
  assert.ok(reply.includes("фамили"), `RU last_name: ${reply}`);
});

test("buildMissingNameFieldsReply: EN locale — both missing", () => {
  const reply = buildMissingNameFieldsReply(["first_name", "last_name"], "en");
  assert.ok(reply.includes("name"), `EN both: ${reply}`);
});

// ── Test 3: Trusted phone + no slot in round-1 booking.apply args ─────────────
// Guard D fires: executor NOT called, reply asks to choose slot, conversation dirty.

test("Test 3: Guard D (round 1) — trusted phone + no date/time → executor not called, asks for slot", async () => {
  let executorCalled = false;

  const LIVE_ENV: Record<string, string> = {
    CLINICCARD_API_BASE_URL: "https://cliniccard.example",
    CLINICCARD_API_TOKEN: "tok_test",
    CLINICCARD_BOOKING_MODE: "live",
    CLINICCARD_DEFAULT_DOCTOR_ID: "1",
    CLINICCARD_DEFAULT_CABINET_ID: "2",
    CLINICCARD_TIMEZONE: "Europe/Prague",
    CLINICCARD_LIVE_CLINIC_ALLOWLIST: "clinic_1",
  };

  const loop = createRuntimeAgentLoop({
    model: "test-model",
    caller: async () => ({
      type: "tool_requests",
      tool_requests: [{
        tool: "booking.apply",
        call_id: "call_t3",
        // No requested_date or requested_time — slot not selected
        arguments: { first_name: "Роман", last_name: "Анбасадоров", service: "осмотр" },
      }],
    }),
    executors: {
      "booking.apply": async () => {
        executorCalled = true;
        return { status: "success" as const, data: { booking_action: "booking_apply", booking_status: "visit_created", created_visit: true, may_claim_booked: true, cliniccard_visit_id: "99", cliniccard_patient_id: 42 } };
      },
    },
  });

  const result = await loop.runTurn({
    ...BASE_TURN_INPUT,
    channel_contact: TRUSTED_CONTACT,
  });

  // booking.apply executor must NOT have been called
  assert.equal(executorCalled, false, "booking.apply executor must not be called when date/time absent");

  // tool_results must be empty
  assert.deepEqual(result.tool_results, [], "tool_results must be empty");

  // Reply asks patient to choose a slot/time
  const reply = result.final_patient_reply.toLowerCase();
  assert.ok(
    reply.includes("дату") || reply.includes("время") || reply.includes("слот") || reply.includes("date") || reply.includes("slot"),
    `Reply must ask to choose a slot: ${result.final_patient_reply}`,
  );

  // Conversation must be dirty / not resumable
  assert.equal(result.conversation_id, null, "conversation_id must be null");
  assert.equal(result.conversation_id_resumable, false, "must not be resumable");

  // debug.reason identifies the guard
  assert.equal(
    (result.debug as Record<string, unknown>)?.reason,
    "booking_apply_preflight_missing_slot_round1",
  );
});

// ── Test 4a: First name missing in round-1 booking.apply args ─────────────────

test("Test 4a: Guard E (round 1) — first_name missing → executor not called, asks for first name only", async () => {
  let executorCalled = false;

  const loop = createRuntimeAgentLoop({
    model: "test-model",
    caller: async () => ({
      type: "tool_requests",
      tool_requests: [{
        tool: "booking.apply",
        call_id: "call_t4a",
        arguments: {
          // first_name absent, last_name present, date+time present
          last_name: "Анбасадоров",
          requested_date: "2026-07-15",
          requested_time: "10:00",
          service: "осмотр",
        },
      }],
    }),
    executors: {
      "booking.apply": async () => {
        executorCalled = true;
        return { status: "success" as const, data: { booking_action: "booking_apply", booking_status: "visit_created", created_visit: true, may_claim_booked: true, cliniccard_visit_id: "99" } };
      },
    },
  });

  const result = await loop.runTurn({
    ...BASE_TURN_INPUT,
    channel_contact: TRUSTED_CONTACT,
  });

  assert.equal(executorCalled, false, "booking.apply executor must not be called when first_name absent");
  assert.deepEqual(result.tool_results, []);

  // Reply must ask for first name specifically, not last name
  const reply = result.final_patient_reply.toLowerCase();
  assert.ok(
    reply.includes("имя") || reply.includes("зовут") || reply.includes("first") || reply.includes("name"),
    `Reply must ask for first name: ${result.final_patient_reply}`,
  );

  assert.equal(result.conversation_id, null);
  assert.equal(result.conversation_id_resumable, false);
  assert.equal(
    (result.debug as Record<string, unknown>)?.reason,
    "booking_apply_preflight_missing_name_round1",
  );
  const missingFields = (result.debug as Record<string, unknown>)?.missing_fields as string[];
  assert.ok(Array.isArray(missingFields) && missingFields.includes("first_name"), "missing_fields must include first_name");
  assert.ok(!missingFields.includes("last_name"), "missing_fields must NOT include last_name");
});

// ── Test 4b: Last name missing ────────────────────────────────────────────────

test("Test 4b: Guard E (round 1) — last_name missing → executor not called, asks for last name only", async () => {
  let executorCalled = false;

  const loop = createRuntimeAgentLoop({
    model: "test-model",
    caller: async () => ({
      type: "tool_requests",
      tool_requests: [{
        tool: "booking.apply",
        call_id: "call_t4b",
        arguments: {
          first_name: "Роман",
          // last_name absent
          requested_date: "2026-07-15",
          requested_time: "10:00",
          service: "осмотр",
        },
      }],
    }),
    executors: {
      "booking.apply": async () => {
        executorCalled = true;
        return { status: "success" as const, data: { booking_action: "booking_apply", booking_status: "visit_created", created_visit: true, may_claim_booked: true, cliniccard_visit_id: "99" } };
      },
    },
  });

  const result = await loop.runTurn({
    ...BASE_TURN_INPUT,
    channel_contact: TRUSTED_CONTACT,
  });

  assert.equal(executorCalled, false, "booking.apply executor must not be called when last_name absent");
  assert.deepEqual(result.tool_results, []);

  const reply = result.final_patient_reply.toLowerCase();
  assert.ok(
    reply.includes("фамили") || reply.includes("last") || reply.includes("surname"),
    `Reply must ask for last name: ${result.final_patient_reply}`,
  );

  assert.equal(result.conversation_id, null);
  assert.equal(result.conversation_id_resumable, false);
  const missingFields = (result.debug as Record<string, unknown>)?.missing_fields as string[];
  assert.ok(Array.isArray(missingFields) && missingFields.includes("last_name"), "missing_fields must include last_name");
  assert.ok(!missingFields.includes("first_name"), "missing_fields must NOT include first_name");
});

// ── Test 5: Full proof + BOOKING_MODE=disabled ────────────────────────────────
// When all required fields are present but mode=disabled, the executor IS called
// and returns booking_write_disabled (not a missing-slot or name guard).
// ClinicCard write never happens; created_visit=false, may_claim_booked=false.

test("Test 5: full proof + BOOKING_MODE=disabled → booking_write_disabled, no ClinicCard write, no false claim", async () => {
  let writeAttempted = false;

  const DISABLED_ENV: Record<string, string> = {
    CLINICCARD_API_BASE_URL: "https://cliniccard.example",
    CLINICCARD_API_TOKEN: "tok_test",
    CLINICCARD_BOOKING_MODE: "disabled",
    CLINICCARD_DEFAULT_DOCTOR_ID: "1",
    CLINICCARD_DEFAULT_CABINET_ID: "2",
    CLINICCARD_TIMEZONE: "Europe/Prague",
    CLINICCARD_LIVE_CLINIC_ALLOWLIST: "clinic_1",
  };

  const mockAdapter: ClinicCardAdapter = {
    findPatientByPhone: async () => ({ ok: true, data: [] }),
    createPatient: async () => { writeAttempted = true; return { ok: true, data: { id: 1, name: "x", phone: null } }; },
    createVisit: async () => { writeAttempted = true; return { ok: false, error: { code: "e", message: "e" } }; },
    listVisits: async () => { writeAttempted = true; return { ok: true, data: [] }; },
    listPayments: async () => ({ ok: true, data: [] }),
  };

  // Round 1: model requests booking.apply with all required fields present
  const loop = createRuntimeAgentLoop({
    model: "test-model",
    caller: makeCallerSequence([
      {
        type: "tool_requests",
        tool_requests: [{
          tool: "booking.apply",
          call_id: "call_t5",
          arguments: {
            first_name: "Іван",
            last_name: "Петров",
            requested_date: "2026-07-20",
            requested_time: "11:00",
            service: "Чистка зубов",
          },
        }],
      },
      {
        type: "final_response",
        final_response: { final_patient_reply: "Онлайн-запись временно недоступна. Свяжитесь с клиникой напрямую." },
      },
    ]),
    executors: {
      "booking.apply": createBookingApplyExecutor({
        env: DISABLED_ENV,
        adapterFactory: () => mockAdapter,
      }),
    },
  });

  const result = await loop.runTurn({
    ...BASE_TURN_INPUT,
    channel_contact: TRUSTED_CONTACT,
  });

  // booking_write_disabled must be in tool_results (executor WAS called because all fields present)
  const bookingResult = result.tool_results.find((r) => r.tool === "booking.apply");
  assert.ok(bookingResult, "booking.apply must appear in tool_results");
  const data = bookingResult!.data as Record<string, unknown>;
  assert.equal(data.booking_status, "booking_write_disabled", "status must be booking_write_disabled");
  assert.equal(data.created_visit, false, "created_visit must be false");
  assert.equal(data.may_claim_booked, false, "may_claim_booked must be false");

  // No ClinicCard write attempted
  assert.equal(writeAttempted, false, "no ClinicCard write must occur when mode=disabled");
});

// ── Test 6: Golden flow regression ───────────────────────────────────────────
// Sequence: booking intent → name "Роман Анбасадоров" + "как можно скорее" →
// availability.check returns 0 slots → model tries booking.apply.
// Expected: executor NOT called, no booking_write_disabled, reply asks another time,
// conversation_id_resumable=false.

test("Test 6: golden flow regression — 0 slots → booking.apply executor not called, no booking_write_disabled", async () => {
  let bookingApplyExecutorCalled = false;

  const loop = createRuntimeAgentLoop({
    model: "test-model",
    caller: makeCallerSequence([
      // Round 1: model requests availability.check (no ASAP slot available)
      {
        type: "tool_requests",
        conversation_id: "conv_roman_asap",
        tool_requests: [{
          tool: "availability.check",
          call_id: "call_avail_roman",
          arguments: { service_interest: "осмотр из-за боли", requested_date: "2026-07-10" },
        }],
      },
      // Round 2: model incorrectly tries booking.apply after seeing 0 slots
      {
        type: "tool_requests",
        conversation_id: "conv_roman_asap",
        tool_requests: [{
          tool: "booking.apply",
          call_id: "call_book_roman",
          arguments: {
            first_name: "Роман",
            last_name: "Анбасадоров",
            service: "осмотр из-за боли",
            // No date/time because availability returned 0 slots and patient said "как можно скорее"
          },
        }],
      },
    ]),
    executors: {
      "availability.check": async () => ({
        status: "success" as const,
        data: { slots: [], total_slots: 0, free_slots_count: 0 },
      }),
      "booking.apply": async () => {
        bookingApplyExecutorCalled = true;
        return {
          status: "success" as const,
          data: {
            booking_action: "booking_apply",
            booking_status: "booking_write_disabled",
            created_visit: false,
            may_claim_booked: false,
            cliniccard_visit_id: null,
          },
        };
      },
    },
  });

  const result = await loop.runTurn({
    ...BASE_TURN_INPUT,
    user_message: "Хотел бы записаться на приём, у меня болит зуб. Меня зовут Роман Анбасадоров, как можно скорее.",
    conversation_id: "conv_roman_asap",
    channel_contact: TRUSTED_CONTACT,
  });

  // booking.apply executor must NOT have been called
  assert.equal(bookingApplyExecutorCalled, false, "booking.apply executor must not be called when 0 slots available");

  // No booking_write_disabled in results (executor not called at all)
  const bookingResult = result.tool_results.find((r) => r.tool === "booking.apply");
  assert.equal(bookingResult, undefined, "booking.apply must not appear in tool_results");

  // Reply asks patient to choose another time / check another date
  const reply = result.final_patient_reply.toLowerCase();
  assert.ok(
    reply.includes("слот") || reply.includes("время") || reply.includes("дату") ||
    reply.includes("slot") || reply.includes("time") || reply.includes("date"),
    `Reply must ask for another time or mention no slots: ${result.final_patient_reply}`,
  );

  // conversation_id_resumable=false (conversation dirty after blocked booking.apply)
  assert.equal(result.conversation_id_resumable, false, "conversation_id_resumable must be false");

  // debug identifies the no-slots intercept
  const reason = (result.debug as Record<string, unknown>)?.reason;
  assert.ok(
    reason === "booking_apply_preflight_no_slots" || reason === "booking_apply_preflight_missing_slot_round2",
    `debug.reason must identify no-slot intercept, got: ${reason}`,
  );
});

// ── Test 1a: No slots + NO trusted phone → no-slots reply (not contact button) ──
// The no-slots gate must fire before the phone guard so we never ask for phone
// when there are no slots to book.

test("Test 1a: no slots + no trusted phone → no-slots reply, no contact button", async () => {
  let bookingApplyExecutorCalled = false;

  const loop = createRuntimeAgentLoop({
    model: "test-model",
    caller: makeCallerSequence([
      {
        type: "tool_requests",
        conversation_id: "conv_1a",
        tool_requests: [AVAILABILITY_REQUEST],
      },
      {
        type: "tool_requests",
        conversation_id: "conv_1a",
        tool_requests: [BOOKING_APPLY_REQUEST],
      },
    ]),
    executors: {
      "availability.check": async () => ({
        status: "success" as const,
        data: { slots: [], total_slots: 0, free_slots_count: 0 },
      }),
      "booking.apply": async () => {
        bookingApplyExecutorCalled = true;
        return {
          status: "success" as const,
          data: { booking_action: "booking_apply", booking_status: "booking_write_disabled", created_visit: false, may_claim_booked: false },
        };
      },
    },
  });

  const result = await loop.runTurn({
    ...BASE_TURN_INPUT,
    conversation_id: "conv_1a",
    channel_contact: undefined, // no trusted phone
  });

  assert.equal(bookingApplyExecutorCalled, false, "executor must not be called");

  // Must be no-slots reply, NOT contact button
  assert.equal(result.ui?.telegram?.request_contact, undefined, "must NOT return contact button when no slots");
  assert.ok(
    result.final_patient_reply.toLowerCase().includes("слот") ||
      result.final_patient_reply.toLowerCase().includes("slot"),
    `Reply must mention no slots: ${result.final_patient_reply}`,
  );

  assert.equal(result.conversation_id, null);
  assert.equal(result.conversation_id_resumable, false);
  assert.equal((result.debug as Record<string, unknown>)?.reason, "booking_apply_preflight_no_slots");
});

// ── Unit: shouldInterceptInvalidSlotTime ──────────────────────────────────────

test("shouldInterceptInvalidSlotTime: true when requested_time not in allowed slots", () => {
  assert.equal(
    shouldInterceptInvalidSlotTime({
      pendingToolRequests: [{
        tool: "booking.apply",
        call_id: "c1",
        arguments: { requested_date: "2026-07-09", requested_time: "13:00", first_name: "A", last_name: "B", service: "s" },
      }],
      completedToolResults: [AVAILABILITY_SUCCESS], // AVAILABILITY_SUCCESS has 12:00 slot
    }),
    true,
  );
});

test("shouldInterceptInvalidSlotTime: false when requested_time matches a slot", () => {
  assert.equal(
    shouldInterceptInvalidSlotTime({
      pendingToolRequests: [{
        tool: "booking.apply",
        call_id: "c2",
        arguments: { requested_date: "2026-07-09", requested_time: "12:00", first_name: "A", last_name: "B", service: "s" },
      }],
      completedToolResults: [AVAILABILITY_SUCCESS], // has starts_at "2026-07-09T12:00:00"
    }),
    false,
  );
});

test("shouldInterceptInvalidSlotTime: false when no availability results (nothing to validate against)", () => {
  assert.equal(
    shouldInterceptInvalidSlotTime({
      pendingToolRequests: [BOOKING_APPLY_REQUEST],
      completedToolResults: [],
    }),
    false,
  );
});

test("shouldInterceptInvalidSlotTime: false when no booking.apply pending", () => {
  assert.equal(
    shouldInterceptInvalidSlotTime({
      pendingToolRequests: [AVAILABILITY_REQUEST],
      completedToolResults: [AVAILABILITY_SUCCESS],
    }),
    false,
  );
});

test("shouldInterceptInvalidSlotTime: false when requested_time absent (Guard D handles it)", () => {
  assert.equal(
    shouldInterceptInvalidSlotTime({
      pendingToolRequests: [{
        tool: "booking.apply",
        call_id: "c3",
        arguments: { requested_date: "2026-07-09", first_name: "A", last_name: "B", service: "s" },
      }],
      completedToolResults: [AVAILABILITY_SUCCESS],
    }),
    false,
  );
});

test("shouldInterceptInvalidSlotTime: handles HH:MM:SS format in requested_time", () => {
  // requested_time "12:00:00" normalized to "12:00" should match slot at 12:00
  assert.equal(
    shouldInterceptInvalidSlotTime({
      pendingToolRequests: [{
        tool: "booking.apply",
        call_id: "c4",
        arguments: { requested_date: "2026-07-09", requested_time: "12:00:00", first_name: "A", last_name: "B", service: "s" },
      }],
      completedToolResults: [AVAILABILITY_SUCCESS],
    }),
    false,
  );
});

// ── Unit: buildInvalidSlotReply ───────────────────────────────────────────────

test("buildInvalidSlotReply: RU mentions time/slot", () => {
  const r = buildInvalidSlotReply("ru");
  assert.ok(r.includes("врем") || r.includes("слот"), `RU: ${r}`);
});

test("buildInvalidSlotReply: EN mentions time/slot", () => {
  const r = buildInvalidSlotReply("en");
  assert.ok(r.includes("time") || r.includes("slot"), `EN: ${r}`);
});

// ── Unit: bookingApplyArgsMissingService ──────────────────────────────────────

test("bookingApplyArgsMissingService: true when both service and service_reason absent", () => {
  assert.equal(bookingApplyArgsMissingService({}), true);
});

test("bookingApplyArgsMissingService: false when service is present", () => {
  assert.equal(bookingApplyArgsMissingService({ service: "cleaning" }), false);
});

test("bookingApplyArgsMissingService: false when service_reason is present", () => {
  assert.equal(bookingApplyArgsMissingService({ service_reason: "tooth pain" }), false);
});

test("bookingApplyArgsMissingService: true when service is empty string", () => {
  assert.equal(bookingApplyArgsMissingService({ service: "  " }), true);
});

// ── Unit: buildMissingServiceReply ────────────────────────────────────────────

test("buildMissingServiceReply: RU mentions visit reason", () => {
  const r = buildMissingServiceReply("ru");
  assert.ok(r.includes("визит") || r.includes("услуг"), `RU: ${r}`);
});

test("buildMissingServiceReply: EN is non-empty", () => {
  assert.ok(buildMissingServiceReply("en").length > 0);
});

// ── Integration Test: slot validity (invalid time, round 2) ──────────────────

test("Integration: invalid slot time in round-2 → executor not called, asks to choose slot", async () => {
  let bookingApplyExecutorCalled = false;

  const BOOKING_WRONG_TIME: RuntimeAgentToolRequest = {
    tool: "booking.apply",
    call_id: "call_wrong_time",
    arguments: {
      service: "chistka",
      requested_date: "2026-07-09",
      requested_time: "13:00", // NOT in availability results (slot is 12:00)
      first_name: "Роман",
      last_name: "Анбасадоров",
    },
  };

  const loop = createRuntimeAgentLoop({
    model: "test-model",
    caller: makeCallerSequence([
      {
        type: "tool_requests",
        conversation_id: "conv_invalid_slot",
        tool_requests: [AVAILABILITY_REQUEST],
      },
      {
        type: "tool_requests",
        conversation_id: "conv_invalid_slot",
        tool_requests: [BOOKING_WRONG_TIME],
      },
    ]),
    executors: {
      "availability.check": async () => ({
        status: "success" as const,
        data: { slots: [SLOT], total_slots: 1, free_slots_count: 1 }, // 12:00 slot
      }),
      "booking.apply": async () => {
        bookingApplyExecutorCalled = true;
        return { status: "success" as const, data: { booking_status: "booking_write_disabled", created_visit: false, may_claim_booked: false } };
      },
    },
  });

  const result = await loop.runTurn({
    ...BASE_TURN_INPUT,
    conversation_id: "conv_invalid_slot",
    channel_contact: TRUSTED_CONTACT,
  });

  assert.equal(bookingApplyExecutorCalled, false, "executor must not be called for invalid slot time");
  assert.equal(result.tool_results?.find((r) => r.tool === "booking.apply"), undefined, "booking.apply must not appear in results");
  assert.ok(
    result.final_patient_reply.toLowerCase().includes("врем") ||
      result.final_patient_reply.toLowerCase().includes("слот") ||
      result.final_patient_reply.toLowerCase().includes("time") ||
      result.final_patient_reply.toLowerCase().includes("slot"),
    `Reply must ask to choose available slot: ${result.final_patient_reply}`,
  );
  assert.equal(result.conversation_id, null);
  assert.equal(result.conversation_id_resumable, false);
  assert.equal((result.debug as Record<string, unknown>)?.reason, "booking_apply_preflight_invalid_slot_round2");
});

// ── Integration Test: valid slot time passes preflight ────────────────────────

test("Integration: valid slot time (12:00 in [12:00]) — passes slot validity, executor called", async () => {
  let bookingApplyExecutorCalled = false;

  const BOOKING_CORRECT_TIME: RuntimeAgentToolRequest = {
    tool: "booking.apply",
    call_id: "call_correct_time",
    arguments: {
      service: "chistka",
      requested_date: "2026-07-09",
      requested_time: "12:00", // matches the available slot
      first_name: "Роман",
      last_name: "Анбасадоров",
    },
  };

  const loop = createRuntimeAgentLoop({
    model: "test-model",
    caller: makeCallerSequence([
      {
        type: "tool_requests",
        conversation_id: "conv_valid_slot",
        tool_requests: [AVAILABILITY_REQUEST],
      },
      {
        type: "tool_requests",
        conversation_id: "conv_valid_slot",
        tool_requests: [BOOKING_CORRECT_TIME],
      },
      {
        type: "final_response",
        conversation_id: "conv_valid_slot",
        final_response: { final_patient_reply: "Запись оформлена." },
      },
    ]),
    executors: {
      "availability.check": async () => ({
        status: "success" as const,
        data: { slots: [SLOT], total_slots: 1, free_slots_count: 1 },
      }),
      "booking.apply": async () => {
        bookingApplyExecutorCalled = true;
        return {
          status: "success" as const,
          data: { booking_action: "booking_apply", booking_status: "booking_write_disabled", created_visit: false, may_claim_booked: false },
        };
      },
    },
  });

  const result = await loop.runTurn({
    ...BASE_TURN_INPUT,
    conversation_id: "conv_valid_slot",
    channel_contact: TRUSTED_CONTACT,
  });

  assert.equal(bookingApplyExecutorCalled, true, "executor must be called when slot time is valid");
  assert.ok(
    result.tool_results?.some((r) => r.tool === "booking.apply"),
    "booking.apply must appear in tool_results",
  );
});

// ── Integration Test: missing service in round-1 → executor not called ────────

test("Integration: missing service in round-1 args → executor not called, asks for service reason", async () => {
  let bookingApplyExecutorCalled = false;

  const loop = createRuntimeAgentLoop({
    model: "test-model",
    caller: async () => ({
      type: "tool_requests",
      tool_requests: [{
        tool: "booking.apply",
        call_id: "call_no_svc",
        arguments: {
          requested_date: "2026-07-09",
          requested_time: "12:00",
          first_name: "Роман",
          last_name: "Анбасадоров",
          // no service, no service_reason
        },
      }],
    }),
    executors: {
      "booking.apply": async () => {
        bookingApplyExecutorCalled = true;
        return { status: "success" as const, data: { booking_status: "booking_write_disabled", created_visit: false, may_claim_booked: false } };
      },
    },
  });

  const result = await loop.runTurn({
    ...BASE_TURN_INPUT,
    channel_contact: TRUSTED_CONTACT,
  });

  assert.equal(bookingApplyExecutorCalled, false, "executor must not be called when service is missing");
  assert.deepEqual(result.tool_results, []);
  assert.ok(
    result.final_patient_reply.toLowerCase().includes("визит") ||
      result.final_patient_reply.toLowerCase().includes("услуг") ||
      result.final_patient_reply.toLowerCase().includes("visit") ||
      result.final_patient_reply.toLowerCase().includes("service"),
    `Reply must ask for service reason: ${result.final_patient_reply}`,
  );
  assert.equal(result.conversation_id, null);
  assert.equal(result.conversation_id_resumable, false);
  assert.equal((result.debug as Record<string, unknown>)?.reason, "booking_apply_preflight_missing_service_round1");
});
