/**
 * PR #136: booking final reply date truth guard.
 *
 * Tests:
 * A. weekday.ru === "вторник" for 2026-07-07
 * B. weekday.uk === "вівторок", weekday.cs === "úterý", weekday.en === "Tuesday"
 * C. date_display locale values correct
 * D. time_start and date extracted correctly
 * E. Returns null when no date can be extracted
 * F. appointment_display_truth injected in second model call after booking.apply success
 * G. System instruction contains appointment_display_truth weekday rules
 * H. Existing bookingApplyGuard behaviour unchanged (regression)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildAppointmentDisplayTruth } from "../src/runtime/appointmentDisplayTruth.ts";
import { buildRuntimeAgentSystemInstruction } from "../src/runtime/openaiRuntimeAgent.ts";
import { createRuntimeAgentLoop } from "../src/runtime/runtimeAgentLoop.ts";
import type {
  RuntimeAgentCaller,
  RuntimeAgentCallerOutput,
  RuntimeAgentCallerInput,
} from "../src/runtime/runtimeAgentLoop.ts";
import type { ToolExecutorRegistry } from "../src/runtime/toolExecutor.ts";
import type { RuntimeAgentToolResult } from "../src/runtime/openaiRuntimeAgent.ts";
import { buildBookingApplyActionTruth } from "../src/runtime/bookingApplyGuard.ts";

function makeSlotStateRepo(starts_at: string) {
  return {
    async loadState() { return { selected_slot: { starts_at } }; },
    async saveState() {},
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeBookingSuccessResult(overrides: Record<string, unknown> = {}): RuntimeAgentToolResult {
  return {
    tool: "booking.apply",
    call_id: "call_test",
    status: "success",
    data: {
      booking_status: "visit_created",
      created_visit: true,
      may_claim_booked: true,
      cliniccard_visit_id: "58702311",
      cliniccard_patient_id: "16311921",
      date: "2026-07-07",
      time_start: "14:00",
      time_end: "14:30",
      timezone: "Europe/Prague",
      ...overrides,
    },
  };
}

// ── A. weekday.ru for 2026-07-07 ─────────────────────────────────────────────

describe("PR #136 — A: weekday.ru is вторник for 2026-07-07", () => {
  it("returns вторник for 2026-07-07", () => {
    const truth = buildAppointmentDisplayTruth([makeBookingSuccessResult()]);
    assert.ok(truth !== null, "should build truth for success result");
    assert.strictEqual(
      truth!.weekday.ru,
      "вторник",
      `weekday.ru must be вторник for 2026-07-07, got: ${truth!.weekday.ru}`,
    );
  });

  it("extracts date 2026-07-07", () => {
    const truth = buildAppointmentDisplayTruth([makeBookingSuccessResult()]);
    assert.strictEqual(truth!.date, "2026-07-07");
  });
});

// ── B. All locale weekdays ────────────────────────────────────────────────────

describe("PR #136 — B: all locale weekdays for 2026-07-07", () => {
  const truth = buildAppointmentDisplayTruth([makeBookingSuccessResult()]);

  it("weekday.uk === вівторок", () => {
    assert.ok(truth !== null);
    assert.strictEqual(truth!.weekday.uk, "вівторок");
  });

  it("weekday.cs === úterý", () => {
    assert.ok(truth !== null);
    assert.strictEqual(truth!.weekday.cs, "úterý");
  });

  it("weekday.en === Tuesday", () => {
    assert.ok(truth !== null);
    assert.strictEqual(truth!.weekday.en, "Tuesday");
  });
});

// ── C. date_display locale values ────────────────────────────────────────────

describe("PR #136 — C: date_display locale values for 2026-07-07", () => {
  const truth = buildAppointmentDisplayTruth([makeBookingSuccessResult()]);

  it("date_display.ru includes 7 июля", () => {
    assert.ok(truth !== null);
    assert.ok(
      truth!.date_display.ru.includes("июля") && truth!.date_display.ru.includes("7"),
      `date_display.ru must include '7 июля', got: ${truth!.date_display.ru}`,
    );
  });

  it("date_display.en includes July 7", () => {
    assert.ok(truth !== null);
    assert.ok(
      truth!.date_display.en.includes("July") && truth!.date_display.en.includes("7"),
      `date_display.en must include 'July 7', got: ${truth!.date_display.en}`,
    );
  });

  it("date_display.cs includes července", () => {
    assert.ok(truth !== null);
    assert.ok(
      truth!.date_display.cs.includes("července"),
      `date_display.cs must include 'července', got: ${truth!.date_display.cs}`,
    );
  });

  it("date_display.uk includes липня", () => {
    assert.ok(truth !== null);
    assert.ok(
      truth!.date_display.uk.includes("липня") && truth!.date_display.uk.includes("7"),
      `date_display.uk must include '7 липня', got: ${truth!.date_display.uk}`,
    );
  });
});

// ── D. time_start and date extraction ────────────────────────────────────────

describe("PR #136 — D: time_start and date extracted correctly", () => {
  it("extracts time_start 14:00 from date/time_start fields", () => {
    const truth = buildAppointmentDisplayTruth([makeBookingSuccessResult()]);
    assert.ok(truth !== null);
    assert.strictEqual(truth!.time_start, "14:00");
  });

  it("extracts time_end 14:30", () => {
    const truth = buildAppointmentDisplayTruth([makeBookingSuccessResult()]);
    assert.ok(truth !== null);
    assert.strictEqual(truth!.time_end, "14:30");
  });

  it("extracts date from visit_start 'YYYY-MM-DD HH:MM:SS' format", () => {
    const truth = buildAppointmentDisplayTruth([
      makeBookingSuccessResult({ date: undefined, visit_start: "2026-07-07 14:00:00", visit_end: "2026-07-07 14:30:00" }),
    ]);
    assert.ok(truth !== null, "should extract date from visit_start");
    assert.strictEqual(truth!.date, "2026-07-07");
    assert.strictEqual(truth!.time_start, "14:00");
    assert.strictEqual(truth!.time_end, "14:30");
  });

  it("extracts date from requested_date when date and visit_start absent", () => {
    const truth = buildAppointmentDisplayTruth([
      makeBookingSuccessResult({ date: undefined, requested_date: "2026-07-07", requested_time: "14:00" }),
    ]);
    assert.ok(truth !== null);
    assert.strictEqual(truth!.date, "2026-07-07");
    assert.strictEqual(truth!.time_start, "14:00");
  });

  it("extracts cliniccard_visit_id and cliniccard_patient_id", () => {
    const truth = buildAppointmentDisplayTruth([makeBookingSuccessResult()]);
    assert.ok(truth !== null);
    assert.strictEqual(truth!.cliniccard_visit_id, "58702311");
    assert.strictEqual(truth!.cliniccard_patient_id, "16311921");
  });

  it("source is booking.apply", () => {
    const truth = buildAppointmentDisplayTruth([makeBookingSuccessResult()]);
    assert.ok(truth !== null);
    assert.strictEqual(truth!.source, "booking.apply");
  });
});

// ── E. Returns null when no date ──────────────────────────────────────────────

describe("PR #136 — E: returns null when date cannot be extracted", () => {
  it("returns null for empty tool results", () => {
    const truth = buildAppointmentDisplayTruth([]);
    assert.strictEqual(truth, null);
  });

  it("returns null when booking.apply result has no date fields", () => {
    const noDate: RuntimeAgentToolResult = {
      tool: "booking.apply",
      call_id: "call_x",
      status: "success",
      data: { booking_status: "visit_created", may_claim_booked: true },
    };
    const truth = buildAppointmentDisplayTruth([noDate]);
    assert.strictEqual(truth, null);
  });

  it("returns null for failed booking.apply", () => {
    const failed: RuntimeAgentToolResult = {
      tool: "booking.apply",
      call_id: "call_f",
      status: "failed",
      error: { code: "cliniccard_write_failed", message: "timeout" },
    };
    const truth = buildAppointmentDisplayTruth([failed]);
    assert.strictEqual(truth, null);
  });

  it("returns null for availability.check results (wrong tool)", () => {
    const avail: RuntimeAgentToolResult = {
      tool: "availability.check",
      call_id: "call_a",
      status: "success",
      data: { slots: [], date: "2026-07-07" },
    };
    const truth = buildAppointmentDisplayTruth([avail]);
    assert.strictEqual(truth, null);
  });
});

// ── F. Injection in second model call ────────────────────────────────────────

describe("PR #136 — F: appointment_display_truth injected in second model call after booking.apply success", () => {
  it("second caller context includes appointment_display_truth when booking.apply succeeds", async () => {
    let secondCallContext: Record<string, unknown> | null = null;
    let callCount = 0;

    const caller: RuntimeAgentCaller = async (
      input: RuntimeAgentCallerInput,
    ): Promise<RuntimeAgentCallerOutput> => {
      callCount++;
      if (callCount === 1) {
        return {
          type: "tool_requests",
          conversation_id: "conv_f_test",
          tool_requests: [
            {
              tool: "booking.apply",
              call_id: "call_f1",
              arguments: {
                subject_id: "subject_1",
                first_name: "Smoke",
                last_name: "Test136",
                service: "чистка зубов",
                requested_date: "2026-07-07",
                requested_time: "14:00",
              },
            },
          ],
        } as RuntimeAgentCallerOutput;
      }
      // Second call — capture context
      secondCallContext = input.input.context as Record<string, unknown>;
      return {
        type: "final_response",
        conversation_id: "conv_f_test",
        final_response: {
          final_patient_reply: "Запись на вторник, 7 июля, в 14:00 создана.",
        },
      };
    };

    const fakeBookingExecutor = async () => ({
      tool: "booking.apply" as const,
      status: "success" as const,
      data: {
        booking_status: "visit_created",
        created_visit: true,
        may_claim_booked: true,
        cliniccard_visit_id: "58702311",
        cliniccard_patient_id: "16311921",
        date: "2026-07-07",
        time_start: "14:00",
        time_end: "14:30",
        timezone: "Europe/Prague",
      },
    });

    const loop = createRuntimeAgentLoop({
      model: "test",
      caller,
      executors: {
        "booking.apply": fakeBookingExecutor,
      } as unknown as ToolExecutorRegistry,
      now: new Date("2026-07-05T09:00:00.000Z"),
      timezone: "Europe/Prague",
      bookingProcessStateRepository: makeSlotStateRepo("2026-07-07T14:00:00"),
    });

    await loop.runTurn({
      user_message: "Да, записывайте на вторник 14:00",
      clinic_id: "clinic_1",
      contact_id: "smoke_f_test",
      locale: "ru",
      channel_contact: {
        phone_number: "+380991350135",
        phone_source: "telegram_contact_button",
        phone_consent: true,
        phone_collected_at: new Date().toISOString(),
      },
    });

    assert.ok(secondCallContext !== null, "Second model call must have occurred");
    assert.ok(
      "appointment_display_truth" in secondCallContext,
      `Second call context must contain appointment_display_truth. Got keys: ${Object.keys(secondCallContext).join(", ")}`,
    );

    const apt = secondCallContext["appointment_display_truth"] as Record<string, unknown>;
    assert.strictEqual(apt["date"], "2026-07-07");
    assert.strictEqual(apt["time_start"], "14:00");
    const weekday = apt["weekday"] as Record<string, string>;
    assert.strictEqual(weekday["ru"], "вторник");
    assert.strictEqual(weekday["en"], "Tuesday");
  });
});

// ── G. System instruction contains appointment_display_truth rules ─────────────

describe("PR #136 — G: system instruction contains appointment_display_truth weekday rules", () => {
  const instruction = buildRuntimeAgentSystemInstruction({
    now: new Date("2026-07-05T09:00:00.000Z"),
    timezone: "Europe/Prague",
  });

  it("contains 'appointment_display_truth'", () => {
    assert.ok(
      instruction.includes("appointment_display_truth"),
      "System instruction must reference appointment_display_truth",
    );
  });

  it("contains rule against calculating weekday", () => {
    const lower = instruction.toLowerCase();
    assert.ok(
      lower.includes("do not calculate") || lower.includes("do not derive"),
      "System instruction must say 'do not calculate' or 'do not derive' weekday",
    );
  });

  it("contains rule to trust appointment_display_truth over own reasoning", () => {
    assert.ok(
      instruction.includes("trust appointment_display_truth"),
      "System instruction must say trust appointment_display_truth",
    );
  });

  it("contains rule against inventing weekday labels", () => {
    const lower = instruction.toLowerCase();
    assert.ok(
      lower.includes("never invent"),
      "System instruction must say 'never invent' weekday labels",
    );
  });
});

// ── H. bookingApplyGuard regression ──────────────────────────────────────────

describe("PR #136 — H: bookingApplyGuard regression — existing truth logic unchanged", () => {
  it("can_say_booking_created false when booking_status is visit_created but may_claim_booked false", () => {
    const results: RuntimeAgentToolResult[] = [
      {
        tool: "booking.apply",
        call_id: "call_h1",
        status: "success",
        data: {
          booking_status: "visit_created",
          created_visit: true,
          may_claim_booked: false,
          cliniccard_visit_id: null,
          cliniccard_patient_id: null,
          date: "2026-07-07",
          time_start: "14:00",
        },
      },
    ];
    const truth = buildBookingApplyActionTruth(results);
    assert.ok(truth !== null);
    assert.strictEqual(truth!.allowed_claims.can_say_booking_created, false);
  });

  it("can_say_booking_created true when all proof fields present", () => {
    const results: RuntimeAgentToolResult[] = [
      {
        tool: "booking.apply",
        call_id: "call_h2",
        status: "success",
        data: {
          booking_status: "visit_created",
          created_visit: true,
          may_claim_booked: true,
          cliniccard_visit_id: "58702311",
          cliniccard_patient_id: "16311921",
          date: "2026-07-07",
          time_start: "14:00",
          proof: {
            cliniccard_visit_id: "58702311",
            cliniccard_patient_id: "16311921",
            date: "2026-07-07",
            time_start: "14:00",
            time_end: "14:30",
          },
        },
      },
    ];
    const truth = buildBookingApplyActionTruth(results);
    assert.ok(truth !== null);
    assert.strictEqual(truth!.allowed_claims.can_say_booking_created, true);
    assert.strictEqual(truth!.allowed_claims.can_say_booking_confirmed, true);
  });

  it("appointment_display_truth and bookingApplyActionTruth both built from same results", () => {
    const results: RuntimeAgentToolResult[] = [makeBookingSuccessResult()];
    const actionTruth = buildBookingApplyActionTruth(results);
    const displayTruth = buildAppointmentDisplayTruth(results);
    assert.ok(actionTruth !== null, "action truth must be built");
    assert.ok(displayTruth !== null, "display truth must be built");
    // Both agree on date
    assert.strictEqual(displayTruth!.date, "2026-07-07");
    assert.strictEqual(displayTruth!.weekday.ru, "вторник");
  });
});

// ── TZ-1: host TZ=Pacific/Honolulu does not shift weekday ─────────────────────

describe("PR #136 — TZ-1: weekday correct under TZ=Pacific/Honolulu", () => {
  it("weekday.ru === вторник and weekday.en === Tuesday under Pacific/Honolulu host TZ", () => {
    // Spawn a child Node process with TZ=Pacific/Honolulu to verify that
    // Date.UTC + timeZone:"UTC" formatting is host-TZ-independent.
    const srcPath = fileURLToPath(new URL("../src/runtime/appointmentDisplayTruth.ts", import.meta.url));
    const childScript = `
import { buildAppointmentDisplayTruth } from ${JSON.stringify(srcPath)};
const result = buildAppointmentDisplayTruth([{
  tool: "booking.apply",
  call_id: "tz_test",
  status: "success",
  data: {
    booking_status: "visit_created",
    created_visit: true,
    may_claim_booked: true,
    cliniccard_visit_id: "58702311",
    cliniccard_patient_id: "16311921",
    date: "2026-07-07",
    time_start: "14:00",
    time_end: "14:30",
  }
}]);
process.stdout.write(JSON.stringify(result));
`;
    const child = spawnSync(
      process.execPath,
      ["--import", "tsx/esm", "--input-type=module"],
      {
        input: childScript,
        encoding: "utf8",
        env: { ...process.env, TZ: "Pacific/Honolulu" },
        timeout: 15000,
      },
    );

    assert.strictEqual(child.status, 0, `Child process failed: ${child.stderr}`);
    const result = JSON.parse(child.stdout) as { weekday: { ru: string; en: string }; date_display: { ru: string } } | null;
    assert.ok(result !== null, "buildAppointmentDisplayTruth must return non-null under Pacific/Honolulu TZ");
    assert.strictEqual(
      result!.weekday.ru,
      "вторник",
      `Under TZ=Pacific/Honolulu, weekday.ru must be вторник for 2026-07-07, got: ${result!.weekday.ru}`,
    );
    assert.strictEqual(
      result!.weekday.en,
      "Tuesday",
      `Under TZ=Pacific/Honolulu, weekday.en must be Tuesday, got: ${result!.weekday.en}`,
    );
    assert.ok(
      !result!.weekday.ru.includes("среда") && result!.weekday.ru !== "среда",
      "Must not return среда (Wednesday)",
    );
  });
});

// ── TZ-2: host TZ=America/Los_Angeles does not shift date_display ─────────────

describe("PR #136 — TZ-2: date_display correct under TZ=America/Los_Angeles", () => {
  it("date_display.ru contains '7 июля' and date_display.en contains 'July 7' under America/Los_Angeles host TZ", () => {
    const srcPath = fileURLToPath(new URL("../src/runtime/appointmentDisplayTruth.ts", import.meta.url));
    const childScript = `
import { buildAppointmentDisplayTruth } from ${JSON.stringify(srcPath)};
const result = buildAppointmentDisplayTruth([{
  tool: "booking.apply",
  call_id: "tz_test2",
  status: "success",
  data: {
    booking_status: "visit_created",
    created_visit: true,
    may_claim_booked: true,
    cliniccard_visit_id: "58702311",
    cliniccard_patient_id: "16311921",
    date: "2026-07-07",
    time_start: "14:00",
    time_end: "14:30",
  }
}]);
process.stdout.write(JSON.stringify(result));
`;
    const child = spawnSync(
      process.execPath,
      ["--import", "tsx/esm", "--input-type=module"],
      {
        input: childScript,
        encoding: "utf8",
        env: { ...process.env, TZ: "America/Los_Angeles" },
        timeout: 15000,
      },
    );

    assert.strictEqual(child.status, 0, `Child process failed: ${child.stderr}`);
    const result = JSON.parse(child.stdout) as { date_display: { ru: string; en: string } } | null;
    assert.ok(result !== null, "buildAppointmentDisplayTruth must return non-null under America/Los_Angeles TZ");
    assert.ok(
      result!.date_display.ru.includes("7") && result!.date_display.ru.includes("июля"),
      `Under TZ=America/Los_Angeles, date_display.ru must contain '7 июля', got: ${result!.date_display.ru}`,
    );
    assert.ok(
      result!.date_display.en.includes("July") && result!.date_display.en.includes("7"),
      `Under TZ=America/Los_Angeles, date_display.en must contain 'July 7', got: ${result!.date_display.en}`,
    );
    assert.ok(
      !result!.date_display.ru.includes("8"),
      `date_display.ru must not contain '8' (date must not shift to July 8), got: ${result!.date_display.ru}`,
    );
    assert.ok(
      !result!.date_display.en.includes("8"),
      `date_display.en must not contain '8', got: ${result!.date_display.en}`,
    );
  });
});

// ── PR #180 R4: Proof-gate regression tests for buildAppointmentDisplayTruth ──

describe("buildAppointmentDisplayTruth — proof gate (R4)", () => {
  test("ADT-R4-1: missing cliniccard_visit_id → returns null", () => {
    const result = buildAppointmentDisplayTruth([makeBookingSuccessResult({ cliniccard_visit_id: undefined })]);
    assert.strictEqual(result, null, "must return null when cliniccard_visit_id is absent");
  });

  test("ADT-R4-2: whitespace-only cliniccard_visit_id → returns null", () => {
    const result = buildAppointmentDisplayTruth([makeBookingSuccessResult({ cliniccard_visit_id: "   " })]);
    assert.strictEqual(result, null, "must return null when cliniccard_visit_id is whitespace only");
  });

  test("ADT-R4-3: may_claim_booked=false → returns null", () => {
    const result = buildAppointmentDisplayTruth([makeBookingSuccessResult({ may_claim_booked: false })]);
    assert.strictEqual(result, null, "must return null when may_claim_booked is false");
  });

  test("ADT-R4-4: failed tool result with visit data → returns null", () => {
    const failedResult = {
      tool: "booking.apply" as const,
      call_id: "call_failed",
      status: "denied" as const,
      error: { code: "guard_block", message: "blocked" },
      data: {
        booking_status: "visit_created",
        created_visit: true,
        may_claim_booked: true,
        cliniccard_visit_id: "99999999",
        date: "2026-07-07",
        time_start: "14:00",
      },
    };
    const result = buildAppointmentDisplayTruth([failedResult]);
    assert.strictEqual(result, null, "must return null when status is not success");
  });

  test("ADT-R4-5: complete proof → returns non-null display truth with date and time", () => {
    const result = buildAppointmentDisplayTruth([makeBookingSuccessResult()]);
    assert.notStrictEqual(result, null, "complete proof must return non-null display truth");
    assert.strictEqual(result!.date, "2026-07-07");
    assert.strictEqual(result!.time_start, "14:00");
    assert.ok(result!.weekday.ru, "weekday.ru must be populated");
    assert.ok(result!.date_display.en, "date_display.en must be populated");
  });
});
