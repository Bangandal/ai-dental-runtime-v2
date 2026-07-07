/**
 * PR #164: Past-time preflight debug + regression guard for "завтра" false-positive.
 *
 * Live regression: patient said "Завтра в 12 00", bot replied
 * "Завтра в 12:00 уже не подходит, потому что это время прошло."
 * Root cause: model passed requested_date = today instead of tomorrow.
 *
 * Tests:
 * BPTZ-1-unit  isPastBookingTime: tomorrow 12:00 at 15:00 Prague → false (never blocked)
 * BPTZ-2-unit  isPastBookingTime: today 12:00 at 15:00 Prague → true (correctly blocked)
 * BPTZ-3       Integration: model passes today's date for "завтра" → guard fires,
 *              debug exposes wrong date via past_time_detail and tool_call_args
 * BPTZ-4       Integration: model correctly passes tomorrow → guard does NOT fire,
 *              booking proceeds to next guard (phone/name), not blocked as past_time
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { isPastBookingTime } from "../src/runtime/bookingPreflight.ts";
import { createRuntimeAgentLoop } from "../src/runtime/runtimeAgentLoop.ts";
import type {
  RuntimeAgentCaller,
  RuntimeAgentCallerOutput,
} from "../src/runtime/runtimeAgentLoop.ts";
import type { ToolExecutorRegistry } from "../src/runtime/toolExecutor.ts";

// now = 2026-07-07T13:00:00Z = 15:00 Europe/Prague (CEST = UTC+2)
const NOW = new Date("2026-07-07T13:00:00.000Z");
const TZ = "Europe/Prague";
const TODAY = "2026-07-07";
const TOMORROW = "2026-07-08";

// ── Unit tests ────────────────────────────────────────────────────────────────

describe("BPTZ-1-unit: isPastBookingTime — tomorrow 12:00 is never past", () => {
  test("tomorrow 12:00 at 15:00 Prague → false", () => {
    assert.strictEqual(
      isPastBookingTime({ requestedDate: TOMORROW, requestedTime: "12:00", timezone: TZ, now: NOW }),
      false,
      "tomorrow must never be treated as past time",
    );
  });
});

describe("BPTZ-2-unit: isPastBookingTime — today 12:00 IS past at 15:00 Prague", () => {
  test("today 12:00 at 15:00 Prague → true", () => {
    assert.strictEqual(
      isPastBookingTime({ requestedDate: TODAY, requestedTime: "12:00", timezone: TZ, now: NOW }),
      true,
      "today's past time must be correctly blocked",
    );
  });
});

// ── Integration tests ─────────────────────────────────────────────────────────

describe("BPTZ-3: model passes today's date for 'завтра' — guard fires, debug exposes wrong date", () => {
  test("booking.apply with today's date is blocked as past_time, debug.past_time_detail shows wrong date", async () => {
    let executorCalled = false;
    let callCount = 0;

    const caller: RuntimeAgentCaller = async () => {
      callCount++;
      if (callCount === 1) {
        return {
          type: "tool_requests",
          tool_requests: [{
            tool: "booking.apply",
            call_id: "bptz3-c1",
            arguments: {
              requested_date: TODAY,
              requested_time: "12:00",
              first_name: "Иван",
              last_name: "Иванов",
              service: "Консультация",
            },
          }],
        } as RuntimeAgentCallerOutput;
      }
      return {
        type: "final_response",
        final_response: { final_patient_reply: "Это время уже прошло. Выберите другое." },
      } as RuntimeAgentCallerOutput;
    };

    const loop = createRuntimeAgentLoop({
      model: "test",
      caller,
      executors: {
        "booking.apply": async () => {
          executorCalled = true;
          return { tool: "booking.apply" as const, status: "success" as const, data: {} };
        },
      } as unknown as ToolExecutorRegistry,
      now: NOW,
      timezone: TZ,
    });

    const result = await loop.runTurn({
      user_message: "Завтра в 12 00",
      clinic_id: "clinic_1",
      contact_id: "bptz3-contact",
      locale: "ru",
      channel_contact: { phone_number: "+380991234567", phone_source: "telegram_contact_button" },
    });

    const debug = result.debug as Record<string, unknown>;

    // Guard must fire
    assert.strictEqual(debug.reason, "booking_apply_preflight_past_time_round1");

    // Executor must NOT have run
    assert.strictEqual(executorCalled, false, "booking executor must NOT run when past_time guard fires");

    // tool_call_args must expose the wrong date the model passed
    const args = debug.tool_call_args as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(args), "debug.tool_call_args must be present");
    const bookingArg = args.find((a) => a.tool === "booking.apply");
    assert.ok(bookingArg, "booking.apply args must appear in tool_call_args");
    // tool_call_args for booking.apply is flat: { tool, requested_date, requested_time, service }
    assert.strictEqual(
      bookingArg.requested_date,
      TODAY,
      `debug.tool_call_args exposes the model bug: model passed today (${TODAY}) instead of tomorrow (${TOMORROW})`,
    );

    // debug.past_time_detail must be populated
    const detail = debug.past_time_detail as Record<string, unknown>;
    assert.ok(detail, "debug.past_time_detail must be present");
    assert.strictEqual(detail.requestedDate, TODAY);
    assert.strictEqual(detail.requestedTime, "12:00");
    assert.strictEqual(detail.timezone, TZ);
    assert.ok(typeof detail.nowISO === "string", "nowISO must be a string");
    assert.strictEqual(detail.todayInTimezone, TODAY);

    // guarded tool_result must carry past_time status
    const bookingResult = result.tool_results.find((r) => r.tool === "booking.apply");
    assert.ok(bookingResult, "guarded booking.apply result must appear in tool_results");
    assert.strictEqual((bookingResult!.data as Record<string, unknown>).booking_status, "past_time");
  });
});

describe("BPTZ-4: model correctly passes tomorrow — past_time guard does NOT fire, slot_proof guard does", () => {
  test("booking.apply with tomorrow's date: not past_time, next guard is slot_not_verified", async () => {
    let callCount = 0;

    const caller: RuntimeAgentCaller = async () => {
      callCount++;
      if (callCount === 1) {
        return {
          type: "tool_requests",
          tool_requests: [{
            tool: "booking.apply",
            call_id: "bptz4-c1",
            arguments: {
              requested_date: TOMORROW,
              requested_time: "12:00",
              first_name: "Иван",
              last_name: "Иванов",
              service: "Консультация",
            },
          }],
        } as RuntimeAgentCallerOutput;
      }
      // Second call: model receives slot_not_verified guarded result, asks to verify first
      return {
        type: "final_response",
        final_response: { final_patient_reply: "Сначала проверю доступное время на завтра в 12:00." },
      } as RuntimeAgentCallerOutput;
    };

    const loop = createRuntimeAgentLoop({
      model: "test",
      caller,
      executors: {} as ToolExecutorRegistry,
      now: NOW,
      timezone: TZ,
    });

    const result = await loop.runTurn({
      user_message: "Завтра в 12 00",
      clinic_id: "clinic_1",
      contact_id: "bptz4-contact",
      locale: "ru",
      channel_contact: { phone_number: "+380991234567", phone_source: "telegram_contact_button" },
    });

    const debug = result.debug as Record<string, unknown>;

    // Must NOT be blocked as past_time
    assert.notStrictEqual(debug.reason, "booking_apply_preflight_past_time_round1",
      "tomorrow must not be blocked as past_time round1");
    assert.notStrictEqual(debug.reason, "booking_apply_preflight_past_time_round2",
      "tomorrow must not be blocked as past_time round2");

    // debug.past_time_detail must NOT be set (past_time guard never fired)
    assert.ok(
      debug.past_time_detail === undefined || debug.past_time_detail === null,
      "past_time_detail must not be set when past_time guard does not fire",
    );

    // Next guard must be slot_proof (no avail.check proof in this turn, no selectedSlot)
    assert.strictEqual(
      debug.reason,
      "booking_apply_preflight_missing_slot_proof_round1",
      "slot_proof guard must fire when no avail.check proof and no selectedSlot",
    );

    // Guarded tool_result must carry slot_not_verified — no visit created
    const bookingResult = result.tool_results.find((r) => r.tool === "booking.apply");
    assert.ok(bookingResult, "guarded booking.apply result must appear in tool_results");
    const bookingData = bookingResult!.data as Record<string, unknown>;
    assert.strictEqual(bookingData.booking_status, "slot_not_verified");
    assert.strictEqual(bookingData.created_visit, false);
    assert.strictEqual(bookingData.may_claim_booked, false);

    // Final reply must not contain booking confirmation wording
    const reply = result.final_patient_reply;
    const forbidden = ["записываю", "записал", "записано", "подтверждено", "booked", "confirmed"];
    for (const word of forbidden) {
      assert.ok(
        !reply.toLowerCase().includes(word),
        `final_patient_reply must not contain booking confirmation word "${word}" without visit_created proof — got: ${reply}`,
      );
    }
  });
});
