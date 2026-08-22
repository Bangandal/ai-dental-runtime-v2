/**
 * PR #116 — booking.apply activation tests.
 *
 * Architecture: model owns language, runtime owns action truth.
 * Runtime passes structured booking_apply_action_truth to the model after
 * booking.apply execution. The model produces the patient-facing reply.
 * Runtime does NOT regex-check or replace the final reply.
 *
 * Executor-level unit tests live in bookingApplyExecutor.test.ts.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import test from "node:test";

import { clinicCardServiceAuthorityEnv } from "./clinicCardServiceAuthorityTestHelper.ts";

import { ACTIVE_RUNTIME_AGENT_TOOLS } from "../src/runtime/openaiRuntimeAgent.ts";
import { createRuntimeAgentLoop, type RuntimeAgentCaller } from "../src/runtime/runtimeAgentLoop.ts";
import {
  hasSuccessfulBookingApplyProof,
  buildBookingApplyActionTruth,
  buildBookingApplyEmergencyFallback,
  type BookingApplyActionTruth,
} from "../src/runtime/bookingApplyGuard.ts";
import { createBookingApplyExecutor } from "../src/integrations/cliniccard/bookingApplyExecutor.ts";
import type { ToolExecutionContext } from "../src/runtime/toolExecutor.ts";
import type { ClinicCardAdapter } from "../src/integrations/cliniccard/clinicCardAdapter.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

const LIVE_ENV: Record<string, string> = {
  ...clinicCardServiceAuthorityEnv({ service_key: "cleaning", aliases: ["Чистка", "чистка"], doctor_id: 1, cabinet_id: 2, duration_minutes: 30 }),

  CLINICCARD_API_BASE_URL: "https://cliniccard.example",
  CLINICCARD_API_TOKEN: "tok_test",
  CLINICCARD_BOOKING_MODE: "live",
  CLINICCARD_DEFAULT_DOCTOR_ID: "1",
  CLINICCARD_DEFAULT_CABINET_ID: "2",
  CLINICCARD_TIMEZONE: "Europe/Prague",
  CLINICCARD_LIVE_CLINIC_ALLOWLIST: "clinic_1",
  CLINICCARD_AVAILABILITY_POLICY_CONFIRMED: "true",
  CLINICCARD_WORKING_DAYS: "1,2,3,4,5,6,7",
  CLINICCARD_WORKING_HOURS_START: "00:00",
  CLINICCARD_WORKING_HOURS_END: "23:59",
  CLINICCARD_SLOT_DURATION_MINUTES: "30",
  CLINICCARD_CLOSED_DATES: "",
};

const DISABLED_ENV: Record<string, string> = {
  ...LIVE_ENV,
  CLINICCARD_BOOKING_MODE: "disabled",
};

function makeAdapter(overrides: Partial<ClinicCardAdapter> = {}): ClinicCardAdapter {
  return {
    findPatientByPhone: async () => ({ ok: true, data: [] }),
    createPatient: async (input) => ({
      ok: true,
      data: { id: 42, name: input.name, phone: input.phone ?? null },
    }),
    listVisits: async () => ({ ok: true, data: [] }),
    createVisit: async (input) => ({
      ok: true,
      data: {
        id: 99,
        patient_id: 42,
        doctor_id: input.doctor_id,
        cabinet_id: input.cabinet_id,
        date: input.date,
        time_start: input.time_start,
        time_end: input.time_end,
        status: input.status,
        note: input.note ?? null,
      },
    }),
    listPayments: async () => ({ ok: true, data: [] }),
    ...overrides,
  };
}

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

function makeLoopWithBooking(env: Record<string, string>, adapterOverrides: Partial<ClinicCardAdapter> = {}, slotStartsAt?: string, now?: Date) {
  const callerQueue: RuntimeAgentCaller[] = [];
  return {
    pushCaller(caller: RuntimeAgentCaller) { callerQueue.push(caller); },
    loop: createRuntimeAgentLoop({
      model: "test-model",
      caller: async (input) => {
        const caller = callerQueue.shift();
        if (!caller) throw new Error("No mock caller queued");
        return caller(input);
      },
      executors: {
        "booking.apply": createBookingApplyExecutor({
          env,
          adapterFactory: () => makeAdapter(adapterOverrides),
        }),
      },
      ...(slotStartsAt ? { bookingProcessStateRepository: makeSlotStateRepo(slotStartsAt) } : {}),
      ...(now ? { now } : {}),
    }),
  };
}

// ── A: Active tools ───────────────────────────────────────────────────────────

test("A: ACTIVE_RUNTIME_AGENT_TOOLS is exactly [kb.search, availability.check, booking.select_slot, booking.apply, appointment.lookup]", () => {
  assert.deepEqual(ACTIVE_RUNTIME_AGENT_TOOLS, ["kb.search", "availability.check", "booking.select_slot", "booking.apply", "appointment.lookup"]);
});

// ── B: Booking disabled — action truth has can_say_booking_created=false ──────

test("B: CLINICCARD_BOOKING_MODE disabled → booking_write_disabled; action truth has can_say_booking_created=false, required_next_action=admin_handoff; no writes", async () => {
  const writeCalls: string[] = [];
  let receivedActionTruth: BookingApplyActionTruth | undefined;

  const { loop, pushCaller } = makeLoopWithBooking(DISABLED_ENV, {
    createPatient: async () => { writeCalls.push("createPatient"); return { ok: true, data: { id: 1, name: "X", phone: null } }; },
    createVisit: async () => { writeCalls.push("createVisit"); return { ok: true, data: { id: 1, patient_id: 1, doctor_id: 1, cabinet_id: 1, date: "", time_start: "", time_end: "", status: "PLANNED", note: null } }; },
  }, "2027-08-15T10:00:00", new Date("2027-08-15T07:00:00Z"));

  // Round 1: model requests booking.apply
  pushCaller(async () => ({
    type: "tool_requests",
    tool_requests: [{ tool: "booking.apply", call_id: "call_b", arguments: { subject_id: "subject_1", first_name: "Ivan", last_name: "Petrov", service: "Чистка", requested_date: "2027-08-15", requested_time: "10:00" } }],
  }));

  // Round 2: model receives tool result + booking_apply_action_truth in context
  pushCaller(async (input) => {
    receivedActionTruth = (input.input.context as Record<string, unknown>)?.booking_apply_action_truth as BookingApplyActionTruth | undefined;
    return { type: "final_response", final_response: { final_patient_reply: "Онлайн-запись временно недоступна. Администратор вам перезвонит." } };
  });

  const result = await loop.runTurn({
    clinic_id: "clinic_1", contact_id: "c_b", case_id: null,
    user_message: "Запишите меня", locale: "ru",
    channel_contact: { phone_number: "+420777000001", phone_source: "telegram_contact_button" },
  });

  // Executor returned booking_write_disabled
  const toolData = result.tool_results[0]?.data as Record<string, unknown>;
  assert.equal(toolData?.booking_status, "booking_write_disabled");
  assert.equal(toolData?.created_visit, false);
  assert.equal(toolData?.may_claim_booked, false);

  // No ClinicCard writes
  assert.deepEqual(writeCalls, []);

  // Model received structured action truth
  assert.ok(receivedActionTruth, "second model call must receive booking_apply_action_truth in context");
  assert.equal(receivedActionTruth!.allowed_claims.can_say_booking_created, false);
  assert.equal(receivedActionTruth!.allowed_claims.can_say_booking_confirmed, false);
  assert.equal(receivedActionTruth!.required_next_action, "admin_handoff");
});

// ── C: Missing phone — global preflight returns contact button without executing booking.apply ──
// PR #133: round-1 booking.apply with no trusted phone is now intercepted by the global
// preflight guard before the executor runs.

test("C: no channel_contact → global preflight fires; contact button returned; booking.apply executor not called", async () => {
  const writeCalls: string[] = [];

  const { loop, pushCaller } = makeLoopWithBooking(LIVE_ENV, {
    createPatient: async () => { writeCalls.push("createPatient"); return { ok: true, data: { id: 1, name: "", phone: null } }; },
    createVisit: async () => { writeCalls.push("createVisit"); return { ok: true, data: { id: 1, patient_id: 1, doctor_id: 1, cabinet_id: 1, date: "", time_start: "", time_end: "", status: "PLANNED", note: null } }; },
  }, "2027-08-15T12:00:00", new Date("2027-08-15T07:00:00Z"));

  pushCaller(async () => ({
    type: "tool_requests",
    tool_requests: [{ tool: "booking.apply", call_id: "call_c", arguments: { subject_id: "subject_1", first_name: "Test", last_name: "User", service: "Чистка", requested_date: "2027-08-15", requested_time: "12:00" } }],
  }));
  // Second caller: guarded finalization — model asks for phone after seeing guarded result
  pushCaller(async () => ({
    type: "final_response",
    final_response: { final_patient_reply: "Для записи нужен ваш номер телефона. Поделитесь контактом." },
  }));

  const result = await loop.runTurn({
    clinic_id: "clinic_1", contact_id: "c_c", case_id: null,
    user_message: "Запишите меня", locale: "ru",
    // No channel_contact
  });

  // booking.apply executor was NOT called — guarded result in tool_results instead
  const bookingResult = result.tool_results?.find((r) => r.tool === "booking.apply");
  assert.ok(bookingResult, "guarded booking.apply result must appear in tool_results");
  assert.equal((bookingResult!.data as Record<string, unknown>).booking_status, "missing_trusted_phone");
  assert.equal((bookingResult!.data as Record<string, unknown>).created_visit, false);
  assert.equal((bookingResult!.data as Record<string, unknown>).may_claim_booked, false);
  // No ClinicCard writes attempted
  assert.deepEqual(writeCalls, []);
  // debug indicates the global preflight fired
  assert.equal((result.debug as Record<string, unknown>)?.reason, "booking_apply_preflight_missing_trusted_phone_round1");
  // conversation NOT dirtied — guarded finalization succeeded (no conversation_id_resumable=false)
  assert.notStrictEqual(result.conversation_id_resumable, false, "conversation must not be marked dirty");
});

// ── D: Slot conflict — action truth has required_next_action=offer_another_time ─

test("D: slot_conflict → action truth required_next_action=offer_another_time", () => {
  const results = [{
    tool: "booking.apply" as const,
    call_id: "call_d",
    status: "success" as const,
    data: { booking_status: "slot_conflict", created_visit: false, may_claim_booked: false, cliniccard_visit_id: null },
  }];

  const actionTruth = buildBookingApplyActionTruth(results);
  assert.ok(actionTruth, "must produce action truth");
  assert.equal(actionTruth!.required_next_action, "offer_another_time");
  assert.equal(actionTruth!.allowed_claims.can_say_booking_created, false);
  assert.equal(actionTruth!.allowed_claims.can_say_booking_confirmed, false);
  assert.equal(actionTruth!.created_visit, false);
  assert.equal(actionTruth!.may_claim_booked, false);
});

// ── E: Success — action truth has can_say_booking_created=true; model reply unchanged ─

test("E: visit_created → action truth can_say_booking_created=true; model reply returned unchanged", async () => {
  const executorPhones: string[] = [];
  let receivedActionTruth: BookingApplyActionTruth | undefined;

  const { loop, pushCaller } = makeLoopWithBooking(LIVE_ENV, {
    createPatient: async (input) => {
      executorPhones.push(input.phone ?? "");
      return { ok: true, data: { id: 42, name: input.name, phone: input.phone ?? null } };
    },
  }, "2027-08-15T10:00:00", new Date("2027-08-15T07:00:00Z"));

  pushCaller(async () => ({
    type: "tool_requests",
    tool_requests: [{ tool: "booking.apply", call_id: "call_e", arguments: { subject_id: "subject_1", first_name: "Ivan", last_name: "Petrov", service: "Чистка", requested_date: "2027-08-15", requested_time: "10:00" } }],
  }));

  const modelReply = "Отлично, вы записаны на 15 августа в 10:00! Ждём вас.";
  pushCaller(async (input) => {
    receivedActionTruth = (input.input.context as Record<string, unknown>)?.booking_apply_action_truth as BookingApplyActionTruth | undefined;
    return { type: "final_response", final_response: { final_patient_reply: modelReply } };
  });

  const result = await loop.runTurn({
    clinic_id: "clinic_1", contact_id: "c_e", case_id: null,
    user_message: "Запишите меня на чистку 15 июля в 10:00", locale: "ru",
    channel_contact: { phone_number: "+420777654321", phone_source: "telegram_contact_button" },
  });

  const toolData = result.tool_results[0]?.data as Record<string, unknown>;
  assert.equal(toolData?.booking_status, "visit_created");
  assert.equal(toolData?.created_visit, true);
  assert.equal(toolData?.may_claim_booked, true);
  assert.equal(typeof toolData?.cliniccard_visit_id, "string");

  // Phone came from channel_contact
  assert.equal(executorPhones[0], "+420777654321");

  // Model received action truth with can_say_booking_created=true
  assert.ok(receivedActionTruth, "second model call must receive booking_apply_action_truth");
  assert.equal(receivedActionTruth!.allowed_claims.can_say_booking_created, true);
  assert.equal(receivedActionTruth!.allowed_claims.can_say_booking_confirmed, true);
  assert.equal(receivedActionTruth!.required_next_action, "none");

  // Model reply is returned UNCHANGED — runtime does not intercept or replace
  assert.equal(result.final_patient_reply, modelReply, "runtime must return model reply unchanged on success path");
});

// ── F: Forced finalization — booking_apply_action_truth in resolved_context ───

test("F: bounded continuation preserves booking_apply_action_truth while resolving the second batch by protocol", async () => {
  let boundedCallContext: Record<string, unknown> | undefined;
  let boundedCallToolResults: unknown[] | undefined;

  const { loop, pushCaller } = makeLoopWithBooking(DISABLED_ENV, {}, "2027-08-15T10:00:00", new Date("2027-08-15T07:00:00Z"));

  // Round 1: model requests booking.apply
  pushCaller(async () => ({
    type: "tool_requests",
    tool_requests: [{ tool: "booking.apply", call_id: "call_f1", arguments: { subject_id: "subject_1", first_name: "Ivan", last_name: "Petrov", service: "Чистка", requested_date: "2027-08-15", requested_time: "10:00" } }],
  }));

  // Round 2: model requests more tools (triggers forced finalization path)
  pushCaller(async () => ({
    type: "tool_requests",
    tool_requests: [{ tool: "availability.check", call_id: "call_f2", arguments: { requested_date: "2027-08-15" } }],
  }));

  // Bounded third model step: capture structured truth and the exact second-batch outputs.
  pushCaller(async (input) => {
    boundedCallContext = input.input.context as Record<string, unknown>;
    boundedCallToolResults = input.input.tool_results as unknown[] | undefined;
    return { type: "final_response", final_response: { final_patient_reply: "Онлайн-запись недоступна. Обратитесь к администратору." } };
  });

  const result = await loop.runTurn({
    clinic_id: "clinic_1", contact_id: "c_f", case_id: null,
    user_message: "Запишите меня", locale: "ru",
    channel_contact: { phone_number: "+420777333444", phone_source: "telegram_contact_button" },
  });

  assert.ok(boundedCallContext, "bounded continuation must be called");
  assert.ok(!("resolved_context" in boundedCallContext!), "protocol-resolved second batch must not be duplicated as resolved_context");
  assert.deepEqual(
    (boundedCallToolResults ?? []).map((item) => (item as { call_id?: string }).call_id),
    ["call_f2"],
    "third model step receives exactly the pending second-batch output",
  );

  // booking_apply_action_truth remains structured business truth from the cumulative results.
  const actionTruth = boundedCallContext?.booking_apply_action_truth as BookingApplyActionTruth | undefined;
  assert.ok(actionTruth, "bounded continuation context must contain booking_apply_action_truth");
  assert.equal(actionTruth!.tool, "booking.apply");
  assert.equal(actionTruth!.required_next_action, "admin_handoff");
  assert.equal(actionTruth!.allowed_claims.can_say_booking_created, false);

  // Runtime returns forced finalization model reply unchanged
  assert.equal(result.final_patient_reply, "Онлайн-запись недоступна. Обратитесь к администратору.");
});

// ── G: hasSuccessfulBookingApplyProof — all four proof fields required ─────────

test("G: hasSuccessfulBookingApplyProof — true only when all four proof fields present and valid", () => {
  const proof = {
    tool: "booking.apply" as const,
    status: "success" as const,
    data: { booking_status: "visit_created", created_visit: true, may_claim_booked: true, cliniccard_visit_id: "99" },
  };
  assert.equal(hasSuccessfulBookingApplyProof([proof]), true);
  assert.equal(hasSuccessfulBookingApplyProof([{ ...proof, data: { ...proof.data, may_claim_booked: false } }]), false);
  assert.equal(hasSuccessfulBookingApplyProof([{ ...proof, data: { ...proof.data, created_visit: false } }]), false);
  assert.equal(hasSuccessfulBookingApplyProof([{ ...proof, data: { ...proof.data, cliniccard_visit_id: "" } }]), false);
  assert.equal(hasSuccessfulBookingApplyProof([{ ...proof, data: { ...proof.data, booking_status: "booking_write_disabled" } }]), false);
  assert.equal(hasSuccessfulBookingApplyProof([]), false);
});

// ── buildBookingApplyActionTruth unit tests ───────────────────────────────────

test("buildBookingApplyActionTruth: returns null when no booking.apply in results", () => {
  assert.equal(buildBookingApplyActionTruth([
    { tool: "kb.search" as const, status: "success", data: {} },
  ]), null);
  assert.equal(buildBookingApplyActionTruth([]), null);
});

test("buildBookingApplyActionTruth: visit_created → none + can_say_booking_created=true", () => {
  const result = buildBookingApplyActionTruth([{
    tool: "booking.apply" as const,
    status: "success",
    data: { booking_status: "visit_created", created_visit: true, may_claim_booked: true, cliniccard_visit_id: "42" },
  }]);
  assert.ok(result);
  assert.equal(result!.required_next_action, "none");
  assert.equal(result!.allowed_claims.can_say_booking_created, true);
  assert.equal(result!.allowed_claims.can_say_booking_confirmed, true);
  assert.equal(result!.cliniccard_visit_id, "42");
});

test("buildBookingApplyActionTruth: booking_write_disabled → admin_handoff + can_say_booking_created=false", () => {
  const result = buildBookingApplyActionTruth([{
    tool: "booking.apply" as const,
    status: "success",
    data: { booking_status: "booking_write_disabled", created_visit: false, may_claim_booked: false, cliniccard_visit_id: null },
  }]);
  assert.ok(result);
  assert.equal(result!.required_next_action, "admin_handoff");
  assert.equal(result!.allowed_claims.can_say_booking_created, false);
  assert.equal(result!.allowed_claims.can_say_booking_confirmed, false);
});

test("buildBookingApplyActionTruth: missing_phone → ask_for_phone", () => {
  const result = buildBookingApplyActionTruth([{
    tool: "booking.apply" as const,
    status: "success",
    data: { booking_status: "missing_phone", created_visit: false, may_claim_booked: false, cliniccard_visit_id: null },
  }]);
  assert.ok(result);
  assert.equal(result!.required_next_action, "ask_for_phone");
});

test("buildBookingApplyActionTruth: slot_conflict → offer_another_time", () => {
  const result = buildBookingApplyActionTruth([{
    tool: "booking.apply" as const,
    status: "success",
    data: { booking_status: "slot_conflict", created_visit: false, may_claim_booked: false, cliniccard_visit_id: null },
  }]);
  assert.ok(result);
  assert.equal(result!.required_next_action, "offer_another_time");
});

test("buildBookingApplyActionTruth: unknown status → technical_fallback", () => {
  const result = buildBookingApplyActionTruth([{
    tool: "booking.apply" as const,
    status: "success",
    data: { booking_status: "some_unknown_error", created_visit: false, may_claim_booked: false, cliniccard_visit_id: null },
  }]);
  assert.ok(result);
  assert.equal(result!.required_next_action, "technical_fallback");
});

// ── buildBookingApplyEmergencyFallback unit tests ─────────────────────────────

test("buildBookingApplyEmergencyFallback: returns locale-aware minimal fallback (emergency only)", () => {
  const make = (status: string) => [{
    tool: "booking.apply" as const,
    status: "success" as const,
    data: { booking_status: status, created_visit: false, may_claim_booked: false, cliniccard_visit_id: null },
  }];

  // Russian (default)
  assert.match(buildBookingApplyEmergencyFallback(make("missing_phone"), "ru"), /номер телефона/);
  assert.match(buildBookingApplyEmergencyFallback(make("slot_conflict"), "ru"), /недоступно/);
  assert.match(buildBookingApplyEmergencyFallback(make("booking_write_disabled"), "ru"), /клиникой/);
  assert.match(buildBookingApplyEmergencyFallback(make("unknown"), "ru"), /клиникой/);
  // No unearned handoff/callback promise in any locale for these statuses
  assert.doesNotMatch(buildBookingApplyEmergencyFallback(make("booking_write_disabled"), "ru"), /передам|администратору клиники/);
  assert.doesNotMatch(buildBookingApplyEmergencyFallback(make("booking_write_disabled"), "en"), /team will follow up/);

  // English
  assert.match(buildBookingApplyEmergencyFallback(make("missing_phone"), "en"), /phone/);
  assert.match(buildBookingApplyEmergencyFallback(make("slot_conflict"), "en"), /available/);
  assert.match(buildBookingApplyEmergencyFallback(make("booking_write_disabled"), "en"), /clinic/);

  // Czech
  assert.match(buildBookingApplyEmergencyFallback(make("missing_phone"), "cs"), /telefon/);
});

// ── PR #160 — RC#3b: visit_created emergency fallback must be truthful ───────

test("RC3b: buildBookingApplyEmergencyFallback with visit_created never says 'не могу подтвердить'", () => {
  const make = (status: string) => [{
    tool: "booking.apply" as const,
    status: "success" as const,
    data: { booking_status: status, created_visit: true, may_claim_booked: true, cliniccard_visit_id: "58782156" },
  }];

  // Must NOT claim it cannot confirm — the visit IS in ClinicCard
  assert.doesNotMatch(buildBookingApplyEmergencyFallback(make("visit_created"), "ru"), /не могу подтвердить/i);
  assert.doesNotMatch(buildBookingApplyEmergencyFallback(make("visit_created"), "en"), /unable to confirm/i);
  assert.doesNotMatch(buildBookingApplyEmergencyFallback(make("visit_created"), "cs"), /nemohu.*potvrdit/i);

  // Must acknowledge booking was saved + advise to contact clinic for details
  assert.match(buildBookingApplyEmergencyFallback(make("visit_created"), "ru"), /создана в системе/i);
  assert.match(buildBookingApplyEmergencyFallback(make("visit_created"), "ru"), /клиник/i);
  assert.match(buildBookingApplyEmergencyFallback(make("visit_created"), "en"), /saved in our system/i);
  assert.match(buildBookingApplyEmergencyFallback(make("visit_created"), "cs"), /uložena v systému/i);
});

// ── T9: no ClinicCard writes outside bookingApplyExecutor ────────────────────

test("T9: ClinicCard booking writes live only in BookingWriteAuthority and adapter plumbing", async () => {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const srcDir = resolve(thisDir, "../src");

  const allowedFiles = new Set([
    resolve(srcDir, "integrations/cliniccard/clinicCardBookingWriteAuthority.ts"),
    resolve(srcDir, "integrations/cliniccard/clinicCardAdapter.ts"),
    resolve(srcDir, "integrations/cliniccard/clinicCardTypes.ts"),
  ]);

  const { readdir } = await import("node:fs/promises");

  async function collectTsFiles(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) { files.push(...await collectTsFiles(full)); }
      else if (entry.isFile() && entry.name.endsWith(".ts")) { files.push(full); }
    }
    return files;
  }

  const allFiles = await collectTsFiles(srcDir);
  const violations: string[] = [];
  for (const file of allFiles) {
    if (allowedFiles.has(file)) continue;
    const content = await readFile(file, "utf8");
    if (/\.create(?:Patient|Visit)\s*\(/.test(content)) {
      violations.push(file.replace(srcDir + "/", "src/"));
    }
  }
  assert.deepEqual(violations, [], `ClinicCard booking write calls found outside BookingWriteAuthority/adapter plumbing: ${violations.join(", ")}`);
});

// ── Proof: no regex semantic guard in runtime ─────────────────────────────────

test("proof: UNSAFE_BOOKING_TEXT_RE and guardBookingApplyFinalReply are removed from runtime sources", async () => {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const srcDir = resolve(thisDir, "../src");

  const { readdir } = await import("node:fs/promises");
  async function collectTsFiles(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) { files.push(...await collectTsFiles(full)); }
      else if (entry.isFile() && entry.name.endsWith(".ts")) { files.push(full); }
    }
    return files;
  }

  const allFiles = await collectTsFiles(srcDir);
  const violations: string[] = [];

  for (const file of allFiles) {
    const content = await readFile(file, "utf8");
    if (content.includes("UNSAFE_BOOKING_TEXT_RE")) {
      violations.push(`${file.replace(srcDir + "/", "src/")} contains UNSAFE_BOOKING_TEXT_RE`);
    }
    if (content.includes("guardBookingApplyFinalReply")) {
      violations.push(`${file.replace(srcDir + "/", "src/")} contains guardBookingApplyFinalReply`);
    }
  }

  assert.deepEqual(violations, [], `Regex guard must be fully removed: ${violations.join(", ")}`);
});

// ── Proof: booking_apply_action_truth is passed to model in legacy Runtime implementation ──

test("proof: runtimeAgentLoopLegacy.ts injects booking_apply_action_truth into second model call context", async () => {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const loopSrc = await readFile(resolve(thisDir, "../src/runtime/runtimeAgentLoopLegacy.ts"), "utf8");
  assert.match(loopSrc, /booking_apply_action_truth/, "runtimeAgentLoopLegacy must inject booking_apply_action_truth into model context");
  assert.match(loopSrc, /buildBookingApplyActionTruth/, "runtimeAgentLoopLegacy must call buildBookingApplyActionTruth");
});

// ── PR #180 R4: Emergency fallback gated by complete ClinicCard proof ──────────

const SLOT_REPO_EF = { async loadState() { return { selected_slot: { starts_at: "2027-08-15T11:00:00" }, last_available_slots: [{ starts_at: "2027-08-15T11:00:00" }], active_availability_evidence: { availability_call_id: "legacy_test_call", requested_date: "2027-08-15", requested_time: null, allowed_slot_keys: ["2027-08-15T11:00"] }, selected_slot_proof: { subject_id: "subject_1" as const, availability_call_id: "legacy_test_call", slot_key: "2027-08-15T11:00" } }; }, async saveState() {} };
const BASE_TURN_EF = { clinic_id: "clinic_1", contact_id: "contact_1", case_id: null, user_message: "запишите", trace_id: "trace_ef", channel_contact: { phone_number: "+380991350135", phone_source: "telegram_contact_button" as const } };

function makeExceptionLoop(executorData: Record<string, unknown>) {
  let calls = 0;
  return createRuntimeAgentLoop({
    model: "test-model",
    caller: async () => {
      calls++;
      if (calls === 1) return { type: "tool_requests" as const, tool_requests: [{ tool: "booking.apply" as const, call_id: "ba_ef", arguments: { subject_id: "subject_1", first_name: "Тест", last_name: "Пациент", service: "чистка", requested_date: "2027-08-15", requested_time: "11:00" } }] };
      throw new Error("Second caller exception");
    },
    executors: { "booking.apply": async () => ({ status: "success" as const, data: executorData }) },
    bookingProcessStateRepository: SLOT_REPO_EF,
  });
}

function makeMalformedLoop(executorData: Record<string, unknown>) {
  let calls = 0;
  return createRuntimeAgentLoop({
    model: "test-model",
    caller: async () => {
      calls++;
      if (calls === 1) return { type: "tool_requests" as const, tool_requests: [{ tool: "booking.apply" as const, call_id: "ba_ef_m", arguments: { subject_id: "subject_1", first_name: "Тест", last_name: "Пациент", service: "чистка", requested_date: "2027-08-15", requested_time: "11:00" } }] };
      return { type: "final_response" as const, final_response: { final_patient_reply: "ok", safety_notes: ["malformed_openai_response"] } };
    },
    executors: { "booking.apply": async () => ({ status: "success" as const, data: executorData }) },
    bookingProcessStateRepository: SLOT_REPO_EF,
  });
}

// Test 1: partial visit_created (no cliniccard_visit_id) + second caller exception → no booking claim (RU/CS/EN)
test("EF-partial-no-visit-id: visit_created without cliniccard_visit_id + caller exception → no booking-created claim in RU/CS/EN", async () => {
  const partialData = { booking_status: "visit_created", created_visit: true, may_claim_booked: true };
  for (const locale of ["ru", "cs", "en"] as const) {
    const result = await makeExceptionLoop(partialData).runTurn({ ...BASE_TURN_EF, locale });
    const reply = result.final_patient_reply;
    assert.doesNotMatch(reply, /создана в системе|saved in our system|uložena v systému/i,
      `locale=${locale}: partial proof (no visit_id) must not claim booking created, reply: ${reply}`);
    assert.match(reply, /клиник|clinic|kliniku/i,
      `locale=${locale}: must direct patient to contact clinic, reply: ${reply}`);
  }
});

// Test 2: whitespace-only cliniccard_visit_id + caller exception → no booking claim
test("EF-whitespace-visit-id: cliniccard_visit_id='   ' (whitespace only) + caller exception → no booking-created claim", async () => {
  const whitespaceData = { booking_status: "visit_created", created_visit: true, may_claim_booked: true, cliniccard_visit_id: "   " };
  for (const locale of ["ru", "cs", "en"] as const) {
    const result = await makeExceptionLoop(whitespaceData).runTurn({ ...BASE_TURN_EF, locale });
    const reply = result.final_patient_reply;
    assert.doesNotMatch(reply, /создана в системе|saved in our system|uložena v systému/i,
      `locale=${locale}: whitespace visit_id must not claim booking created, reply: ${reply}`);
  }
});

// Test 3 (unit): denied tool result with booking_status=visit_created in data → no booking claim
test("EF-denied-status: denied tool result containing booking_status=visit_created → no booking-created claim", () => {
  const deniedResult = [{ tool: "booking.apply" as const, call_id: "ba_denied", status: "denied" as const, error: { code: "guard_block", message: "blocked" } }];
  for (const locale of ["ru", "cs", "en"] as const) {
    const reply = buildBookingApplyEmergencyFallback(deniedResult, locale);
    assert.doesNotMatch(reply, /создана в системе|saved in our system|uložena v systému/i,
      `locale=${locale}: denied status must not claim booking created, reply: ${reply}`);
  }
});

// Test 4: full proof + caller exception → booking-saved wording IS allowed
test("EF-full-proof: complete proof + caller exception → booking-saved emergency wording (RU/CS/EN)", async () => {
  const fullData = { booking_status: "visit_created", created_visit: true, may_claim_booked: true, cliniccard_visit_id: "real-visit-99" };
  for (const locale of ["ru", "cs", "en"] as const) {
    const result = await makeExceptionLoop(fullData).runTurn({ ...BASE_TURN_EF, locale });
    const reply = result.final_patient_reply;
    assert.match(reply, /создана в системе|saved in our system|uložena v systému/i,
      `locale=${locale}: full proof must produce booking-saved wording, reply: ${reply}`);
  }
});

// Test 5: partial proof + malformed second model response → no booking claim
test("EF-partial-malformed: visit_created without cliniccard_visit_id + malformed model response → no booking-created claim", async () => {
  const partialData = { booking_status: "visit_created", created_visit: true, may_claim_booked: true };
  for (const locale of ["ru", "cs", "en"] as const) {
    const result = await makeMalformedLoop(partialData).runTurn({ ...BASE_TURN_EF, locale });
    const reply = result.final_patient_reply;
    assert.doesNotMatch(reply, /создана в системе|saved in our system|uložena v systému/i,
      `locale=${locale}: partial proof + malformed response must not claim booking created, reply: ${reply}`);
  }
});
