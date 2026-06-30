/**
 * PR #116 — booking.apply activation tests.
 *
 * Verifies activation invariants that span the agent loop, executor, and
 * patient-facing reply guard. Executor-level unit tests (mode gate, phone
 * check, conflict, success path) live in bookingApplyExecutor.test.ts.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import test from "node:test";

import { ACTIVE_RUNTIME_AGENT_TOOLS } from "../src/runtime/openaiRuntimeAgent.ts";
import { createRuntimeAgentLoop, type RuntimeAgentCaller } from "../src/runtime/runtimeAgentLoop.ts";
import { createBookingApplyExecutor } from "../src/integrations/cliniccard/bookingApplyExecutor.ts";
import type { ToolExecutionContext } from "../src/runtime/toolExecutor.ts";
import type { ClinicCardAdapter } from "../src/integrations/cliniccard/clinicCardAdapter.ts";
import type { ClinicCardConfig } from "../src/integrations/cliniccard/clinicCardTypes.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

const LIVE_ENV: Record<string, string> = {
  CLINICCARD_API_BASE_URL: "https://cliniccard.example",
  CLINICCARD_API_TOKEN: "tok_test",
  CLINICCARD_BOOKING_MODE: "live",
  CLINICCARD_DEFAULT_DOCTOR_ID: "1",
  CLINICCARD_DEFAULT_CABINET_ID: "2",
  CLINICCARD_TIMEZONE: "Europe/Prague",
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

/** Builds a minimal agent loop with booking.apply wired to the given executor env. */
function makeLoopWithBooking(env: Record<string, string>, adapterOverrides: Partial<ClinicCardAdapter> = {}) {
  const callerQueue: RuntimeAgentCaller[] = [];

  return {
    pushCaller(caller: RuntimeAgentCaller) {
      callerQueue.push(caller);
    },
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
    }),
  };
}

// ── Test 1: ACTIVE_RUNTIME_AGENT_TOOLS now includes booking.apply ─────────────

test("PR#116/T1: ACTIVE_RUNTIME_AGENT_TOOLS is exactly [kb.search, availability.check, booking.apply]", () => {
  assert.deepEqual(ACTIVE_RUNTIME_AGENT_TOOLS, ["kb.search", "availability.check", "booking.apply"]);
});

// ── Test 4: tool selectable + mode disabled → booking_write_disabled, no writes ─

test("PR#116/T4: booking.apply can be selected by loop; returns booking_write_disabled when mode is disabled; no ClinicCard write", async () => {
  const writeCalls: string[] = [];
  const { loop, pushCaller } = makeLoopWithBooking(DISABLED_ENV, {
    createPatient: async () => {
      writeCalls.push("createPatient");
      return { ok: true, data: { id: 1, name: "X", phone: null } };
    },
    createVisit: async () => {
      writeCalls.push("createVisit");
      return { ok: true, data: { id: 1, patient_id: 1, doctor_id: 1, cabinet_id: 1, date: "2026-07-15", time_start: "10:00", time_end: "10:30", status: "PLANNED", note: null } };
    },
  });

  // Round 1: model requests booking.apply
  pushCaller(async () => ({
    type: "tool_requests",
    tool_requests: [{
      tool: "booking.apply",
      call_id: "call_1",
      arguments: {
        first_name: "Ivan",
        last_name: "Petrov",
        service: "Чистка",
        requested_date: "2026-07-15",
        requested_time: "10:00",
      },
    }],
  }));

  // Round 2: model produces final reply given the tool result
  pushCaller(async (input) => {
    const toolResult = input.input.tool_results?.[0];
    const bookingStatus = (toolResult?.data as Record<string, unknown> | undefined)?.booking_status;
    return {
      type: "final_response",
      final_response: {
        final_patient_reply: `Запись временно недоступна. Статус: ${String(bookingStatus)}.`,
      },
    };
  });

  const result = await loop.runTurn({
    clinic_id: "clinic_1",
    contact_id: "c1",
    case_id: null,
    user_message: "Запишите меня",
    locale: "ru",
    channel_contact: { phone_number: "+420777000001", phone_source: "telegram_contact_button" },
  });

  // Tool was executed (not denied by loop) and returned booking_write_disabled
  const toolResult = result.tool_results[0];
  assert.equal(toolResult?.tool, "booking.apply");
  assert.equal(toolResult?.status, "success");
  assert.equal((toolResult?.data as Record<string, unknown>)?.booking_status, "booking_write_disabled");
  assert.equal((toolResult?.data as Record<string, unknown>)?.created_visit, false);
  assert.equal((toolResult?.data as Record<string, unknown>)?.may_claim_booked, false);

  // No ClinicCard writes occurred
  assert.deepEqual(writeCalls, [], "createPatient and createVisit must not be called when mode is disabled");

  // Final reply does not claim booking
  const reply = result.final_patient_reply;
  for (const forbidden of ["записан", "записано", "запись создана", "подтверждён", "booked", "confirmed", "reserved"]) {
    assert.equal(reply.toLowerCase().includes(forbidden), false, `Reply must not contain "${forbidden}"`);
  }
});

// ── Test 5: channel_contact.phone_number present + live mode → visit created ──

test("PR#116/T5: channel_contact.phone passed to executor; createPatient+createVisit called only through booking.apply; result proves visit_created", async () => {
  const executorPhones: string[] = [];
  const { loop, pushCaller } = makeLoopWithBooking(LIVE_ENV, {
    createPatient: async (input) => {
      executorPhones.push(input.phone ?? "");
      return { ok: true, data: { id: 42, name: input.name, phone: input.phone ?? null } };
    },
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
  });

  pushCaller(async () => ({
    type: "tool_requests",
    tool_requests: [{
      tool: "booking.apply",
      call_id: "call_live",
      arguments: {
        first_name: "Ivan",
        last_name: "Petrov",
        service: "Чистка",
        requested_date: "2026-07-15",
        requested_time: "10:00",
      },
    }],
  }));

  pushCaller(async (input) => {
    const toolResult = input.input.tool_results?.[0];
    const data = toolResult?.data as Record<string, unknown> | undefined;
    if (data?.may_claim_booked === true) {
      return { type: "final_response", final_response: { final_patient_reply: `Запись создана! Визит #${String(data.cliniccard_visit_id)}.` } };
    }
    return { type: "final_response", final_response: { final_patient_reply: "Запись не удалась." } };
  });

  const result = await loop.runTurn({
    clinic_id: "clinic_1",
    contact_id: "c1",
    case_id: null,
    user_message: "Запишите меня на чистку 15 июля в 10:00",
    locale: "ru",
    channel_contact: { phone_number: "+420777654321", phone_source: "telegram_contact_button" },
  });

  const toolResult = result.tool_results[0];
  assert.equal(toolResult?.tool, "booking.apply");
  assert.equal(toolResult?.status, "success");

  const data = toolResult?.data as Record<string, unknown>;
  assert.equal(data?.booking_status, "visit_created", "booking_status must be visit_created");
  assert.equal(data?.created_visit, true, "created_visit must be true");
  assert.equal(data?.may_claim_booked, true, "may_claim_booked must be true");
  assert.equal(typeof data?.cliniccard_visit_id, "string", "cliniccard_visit_id must be a string");
  assert.notEqual(data?.cliniccard_visit_id, null);

  // Phone came from channel_contact, not from tool arguments
  assert.equal(executorPhones[0], "+420777654321", "executor must use phone from channel_contact");

  // Final reply contains confirmation (model confirmed since may_claim_booked=true)
  assert.match(result.final_patient_reply, /запись создана|визит/i);
});

// ── Test 6: patient-facing proof guard ───────────────────────────────────────

test("PR#116/T6: when may_claim_booked is false, model receives that fact and must not claim booking confirmed", async () => {
  // Simulate executor returning booking_write_disabled (may_claim_booked=false)
  const { loop, pushCaller } = makeLoopWithBooking(DISABLED_ENV);

  pushCaller(async () => ({
    type: "tool_requests",
    tool_requests: [{
      tool: "booking.apply",
      call_id: "call_guard",
      arguments: {
        first_name: "Anna",
        last_name: "Koval",
        service: "Осмотр",
        requested_date: "2026-07-16",
        requested_time: "11:00",
      },
    }],
  }));

  // Model sees the tool result with may_claim_booked=false and must reply without claiming booked
  pushCaller(async (input) => {
    const toolResult = input.input.tool_results?.[0];
    const data = toolResult?.data as Record<string, unknown> | undefined;
    // Verify the model receives may_claim_booked=false
    assert.equal(data?.may_claim_booked, false, "model must see may_claim_booked=false in tool result");
    return {
      type: "final_response",
      final_response: {
        final_patient_reply: "Онлайн-запись временно недоступна, пожалуйста, позвоните нам.",
      },
    };
  });

  const result = await loop.runTurn({
    clinic_id: "clinic_1",
    contact_id: "c2",
    case_id: null,
    user_message: "Хочу на приём",
    locale: "ru",
    channel_contact: { phone_number: "+380991112233", phone_source: "telegram_contact_button" },
  });

  const forbidden = ["записан", "записано", "запись создана", "подтверждён", "booked", "confirmed", "reserved"];
  for (const word of forbidden) {
    assert.equal(
      result.final_patient_reply.toLowerCase().includes(word),
      false,
      `Final reply must not contain "${word}" when may_claim_booked=false`,
    );
  }
});

// ── Test 5b: missing_phone path via loop ──────────────────────────────────────

test("PR#116/T3-loop: when channel_contact is absent, booking.apply returns missing_phone; no writes; no forbidden reply", async () => {
  const writeCalls: string[] = [];
  const { loop, pushCaller } = makeLoopWithBooking(LIVE_ENV, {
    createPatient: async () => { writeCalls.push("createPatient"); return { ok: true, data: { id: 1, name: "", phone: null } }; },
    createVisit: async () => { writeCalls.push("createVisit"); return { ok: true, data: { id: 1, patient_id: 1, doctor_id: 1, cabinet_id: 1, date: "", time_start: "", time_end: "", status: "PLANNED", note: null } }; },
  });

  pushCaller(async () => ({
    type: "tool_requests",
    tool_requests: [{
      tool: "booking.apply",
      call_id: "call_nophone",
      arguments: {
        first_name: "Test",
        last_name: "User",
        service: "Чистка",
        requested_date: "2026-07-20",
        requested_time: "09:00",
      },
    }],
  }));

  pushCaller(async (input) => {
    const toolResult = input.input.tool_results?.[0];
    const data = toolResult?.data as Record<string, unknown> | undefined;
    assert.equal(data?.booking_status, "missing_phone");
    assert.equal(data?.may_claim_booked, false);
    return {
      type: "final_response",
      final_response: { final_patient_reply: "Для записи нужен ваш номер телефона — нажмите кнопку «Поделиться контактом»." },
    };
  });

  const result = await loop.runTurn({
    clinic_id: "clinic_1",
    contact_id: "c3",
    case_id: null,
    user_message: "Запишите меня",
    locale: "ru",
    // No channel_contact → phone_number will be undefined in executor context
  });

  assert.equal((result.tool_results[0]?.data as Record<string, unknown>)?.booking_status, "missing_phone");
  assert.deepEqual(writeCalls, [], "no createPatient or createVisit when phone is missing");

  for (const word of ["записан", "записано", "запись создана", "подтверждён", "booked", "confirmed", "reserved"]) {
    assert.equal(result.final_patient_reply.toLowerCase().includes(word), false, `Reply must not contain "${word}"`);
  }
});

// ── Test 9: no direct ClinicCard writes outside bookingApplyExecutor ──────────

test("PR#116/T9: no direct ClinicCard write calls exist outside bookingApplyExecutor and ClinicCard adapter files", async () => {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const srcDir = resolve(thisDir, "../src");

  // Files allowed to contain ClinicCard write calls (createPatient, createVisit)
  const allowedFiles = new Set([
    resolve(srcDir, "integrations/cliniccard/bookingApplyExecutor.ts"),
    resolve(srcDir, "integrations/cliniccard/clinicCardAdapter.ts"),
    resolve(srcDir, "integrations/cliniccard/clinicCardTypes.ts"),
  ]);

  const { readdir } = await import("node:fs/promises");

  async function collectTsFiles(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...await collectTsFiles(full));
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        files.push(full);
      }
    }
    return files;
  }

  const allFiles = await collectTsFiles(srcDir);
  const violations: string[] = [];

  for (const file of allFiles) {
    if (allowedFiles.has(file)) continue;
    const content = await readFile(file, "utf8");
    if (content.includes("createPatient") || content.includes("createVisit")) {
      violations.push(file.replace(srcDir + "/", "src/"));
    }
  }

  assert.deepEqual(
    violations,
    [],
    `ClinicCard write calls (createPatient, createVisit) found outside allowed files: ${violations.join(", ")}`,
  );
});
