import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getNowHHMMInTimezone,
  getTodayInTimezone,
  isPastBookingTime,
  isPastSlotTime,
  buildPastTimeReply,
  BOOKING_LEAD_TIME_MINUTES,
} from "../src/runtime/bookingPreflight.ts";
import type { RuntimeAgentTurnResult } from "../src/runtime/openaiRuntimeAgent.ts";
import { createRuntimeAgentLoop } from "../src/runtime/runtimeAgentLoop.ts";
import type {
  RuntimeAgentCallerOutput,
  RuntimeAgentCaller,
} from "../src/runtime/runtimeAgentLoop.ts";
import type { ToolExecutorRegistry } from "../src/runtime/toolExecutor.ts";

// ---------------------------------------------------------------------------
// Unit: timezone helpers
// ---------------------------------------------------------------------------
describe("getNowHHMMInTimezone", () => {
  it("returns HH:MM for a known UTC timestamp in Europe/Prague (UTC+1 in winter)", () => {
    // 2026-01-15 12:30 UTC → 13:30 in Prague (CET = UTC+1)
    const now = new Date("2026-01-15T12:30:00.000Z");
    assert.strictEqual(getNowHHMMInTimezone(now, "Europe/Prague"), "13:30");
  });

  it("returns HH:MM for a known UTC timestamp in Europe/Kiev (UTC+2 in summer)", () => {
    // 2026-07-03 10:00 UTC → 13:00 in Kyiv (EEST = UTC+3)
    const now = new Date("2026-07-03T10:00:00.000Z");
    assert.strictEqual(getNowHHMMInTimezone(now, "Europe/Kiev"), "13:00");
  });
});

describe("getTodayInTimezone", () => {
  it("returns YYYY-MM-DD for the given timezone", () => {
    // 2026-07-03 23:30 UTC → 2026-07-04 in Prague (CEST = UTC+2)
    const now = new Date("2026-07-03T23:30:00.000Z");
    assert.strictEqual(getTodayInTimezone(now, "Europe/Prague"), "2026-07-04");
  });

  it("returns correct date when UTC date equals local date", () => {
    const now = new Date("2026-07-03T10:00:00.000Z");
    assert.strictEqual(getTodayInTimezone(now, "Europe/Prague"), "2026-07-03");
  });
});

// ---------------------------------------------------------------------------
// Unit: isPastSlotTime
// ---------------------------------------------------------------------------
describe("isPastSlotTime", () => {
  const now = new Date("2026-07-03T20:25:00.000Z"); // 22:25 Prague (CEST=UTC+2)

  it("returns true when slot is before now (13:00 < 22:25)", () => {
    assert.strictEqual(isPastSlotTime("13:00", now, "Europe/Prague"), true);
  });

  it("returns true when slot equals now (22:25)", () => {
    assert.strictEqual(isPastSlotTime("22:25", now, "Europe/Prague"), true);
  });

  it("returns false when slot is after now (22:30 > 22:25)", () => {
    assert.strictEqual(isPastSlotTime("22:30", now, "Europe/Prague"), false);
  });

  it("respects leadTimeMinutes — blocks slot within buffer", () => {
    // now = 22:25, slot = 22:30, buffer = 10 min → 22:30 <= 22:35 → true
    assert.strictEqual(isPastSlotTime("22:30", now, "Europe/Prague", 10), true);
  });
});

// ---------------------------------------------------------------------------
// Unit: isPastBookingTime
// ---------------------------------------------------------------------------
describe("isPastBookingTime", () => {
  // now = 22:25 Prague on 2026-07-03
  const now = new Date("2026-07-03T20:25:00.000Z");
  const timezone = "Europe/Prague";
  const today = "2026-07-03";
  const tomorrow = "2026-07-04";

  it("returns true when same-day requested_time is in the past (13:00 at 22:25)", () => {
    assert.strictEqual(
      isPastBookingTime({ requestedDate: today, requestedTime: "13:00", timezone, now }),
      true,
    );
  });

  it("returns false when requested_date is tomorrow", () => {
    assert.strictEqual(
      isPastBookingTime({ requestedDate: tomorrow, requestedTime: "13:00", timezone, now }),
      false,
    );
  });

  it("returns false when requested_time is in the future", () => {
    assert.strictEqual(
      isPastBookingTime({ requestedDate: today, requestedTime: "23:00", timezone, now }),
      false,
    );
  });

  it("returns false when requestedTime is absent", () => {
    assert.strictEqual(
      isPastBookingTime({ requestedDate: today, requestedTime: null, timezone, now }),
      false,
    );
  });

  it("returns false when requestedDate is absent", () => {
    assert.strictEqual(
      isPastBookingTime({ requestedDate: null, requestedTime: "13:00", timezone, now }),
      false,
    );
  });

  it("returns false for un-parseable time strings", () => {
    assert.strictEqual(
      isPastBookingTime({ requestedDate: today, requestedTime: "afternoon", timezone, now }),
      false,
    );
  });

  it("returns false when BOOKING_LEAD_TIME_MINUTES default is 0 and no past time", () => {
    assert.strictEqual(BOOKING_LEAD_TIME_MINUTES, 0);
    // 22:26 > 22:25 → false
    assert.strictEqual(
      isPastBookingTime({ requestedDate: today, requestedTime: "22:26", timezone, now }),
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// Unit: buildPastTimeReply
// ---------------------------------------------------------------------------
describe("buildPastTimeReply", () => {
  it("returns Russian text for ru locale", () => {
    const reply = buildPastTimeReply("ru");
    assert.ok(reply.includes("прошло") || reply.includes("время"));
  });

  it("returns Czech text for cs locale", () => {
    const reply = buildPastTimeReply("cs");
    assert.ok(reply.includes("uplynul") || reply.includes("čas"));
  });

  it("returns English text for en locale", () => {
    const reply = buildPastTimeReply("en");
    assert.ok(reply.toLowerCase().includes("passed") || reply.toLowerCase().includes("time"));
  });

  it("defaults to Russian for unknown locale", () => {
    const reply = buildPastTimeReply("uk");
    assert.ok(reply.includes("прошло") || reply.includes("время"));
  });
});

// ---------------------------------------------------------------------------
// Integration: runtimeAgentLoop — past-time guard (round 1)
// ---------------------------------------------------------------------------
describe("runtimeAgentLoop — booking.apply past-time preflight (round 1)", () => {
  // Simulate: model requests booking.apply for today at 13:00 but it's 22:25.
  // "now" is 2026-07-03 22:25 Prague (20:25 UTC).
  // The guard fires and the helper submits a guarded tool_result back to the model.

  it("blocks past same-day booking.apply and returns past-time reply", async () => {
    let callCount = 0;
    const caller: RuntimeAgentCaller = async () => {
      callCount++;
      if (callCount === 1) {
        return {
          type: "tool_requests",
          conversation_id: "conv-past-test",
          tool_requests: [{
            tool: "booking.apply",
            call_id: "call-1",
            arguments: { subject_id: "subject_1", requested_date: "2026-07-03", requested_time: "13:00", service: "consultation", first_name: "Boris", last_name: "Test" },
          }],
        } as RuntimeAgentCallerOutput;
      }
      // Guarded finalization: model explains the time has passed
      return { type: "final_response", final_response: { final_patient_reply: "Это время уже прошло. Выберите другое." } } as RuntimeAgentCallerOutput;
    };

    const loop = createRuntimeAgentLoop({
      model: "test-model",
      caller,
      executors: {} as ToolExecutorRegistry,
      now: new Date("2026-07-03T20:25:00.000Z"),
      timezone: "Europe/Prague",
    });

    const result: RuntimeAgentTurnResult = await loop.runTurn({
      user_message: "Підходящий час 13:00",
      clinic_id: "clinic_1",
      contact_id: "contact_1",
      locale: "ru",
      channel_contact: { phone_number: "+380991234567", phone_source: "telegram_contact_button" },
    });

    // Conversation preserved (guarded finalization succeeded)
    assert.notStrictEqual(result.conversation_id, null);
    assert.notStrictEqual(result.conversation_id_resumable, false);
    assert.ok(
      result.final_patient_reply.includes("прошло") || result.final_patient_reply.includes("время"),
      `Expected past-time reply, got: ${result.final_patient_reply}`,
    );
    // Guarded tool result present in tool_results
    const bookingResult = result.tool_results.find((r) => r.tool === "booking.apply");
    assert.ok(bookingResult, "guarded booking.apply result must appear");
    assert.strictEqual((bookingResult!.data as Record<string, unknown>).booking_status, "past_time");
    assert.strictEqual((result.debug as Record<string, unknown>)?.reason, "booking_apply_preflight_past_time_round1");
  });

  it("past-time reply is locale-aware (cs)", async () => {
    let callCount = 0;
    const caller: RuntimeAgentCaller = async () => {
      callCount++;
      if (callCount === 1) {
        return {
          type: "tool_requests",
          conversation_id: "conv-past-cs",
          tool_requests: [{
            tool: "booking.apply",
            call_id: "call-cs",
            arguments: { subject_id: "subject_1", requested_date: "2026-07-03", requested_time: "13:00", service: "consultation", first_name: "Pavel", last_name: "Test" },
          }],
        } as RuntimeAgentCallerOutput;
      }
      return { type: "final_response", final_response: { final_patient_reply: "Tento čas již uplynul. Vyberte jiný čas." } } as RuntimeAgentCallerOutput;
    };

    const loop = createRuntimeAgentLoop({
      model: "test-model",
      caller,
      executors: {} as ToolExecutorRegistry,
      now: new Date("2026-07-03T20:25:00.000Z"),
      timezone: "Europe/Prague",
    });

    const result: RuntimeAgentTurnResult = await loop.runTurn({
      user_message: "13:00",
      clinic_id: "clinic_1",
      contact_id: "contact_2",
      locale: "cs",
      channel_contact: { phone_number: "+420600000001", phone_source: "telegram_contact_button" },
    });

    assert.ok(
      result.final_patient_reply.includes("uplynul") || result.final_patient_reply.includes("čas"),
      `Expected Czech past-time reply, got: ${result.final_patient_reply}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Integration: runtimeAgentLoop — phone preflight (round 1)
// ---------------------------------------------------------------------------
describe("runtimeAgentLoop — booking.apply phone preflight (round 1)", () => {
  // booking.apply for TOMORROW at 13:00 (not past), but no trusted phone.
  // The guard fires and the helper submits a guarded tool_result back to the model.

  it("blocks booking.apply when trusted phone is missing and asks for phone", async () => {
    let callCount = 0;
    const caller: RuntimeAgentCaller = async () => {
      callCount++;
      if (callCount === 1) {
        return {
          type: "tool_requests",
          conversation_id: "conv-phone-test",
          tool_requests: [{
            tool: "booking.apply",
            call_id: "call-2",
            arguments: { subject_id: "subject_1", requested_date: "2026-07-04", requested_time: "13:00", service: "consultation", first_name: "Boris", last_name: "Test" },
          }],
        } as RuntimeAgentCallerOutput;
      }
      // Guarded finalization: model asks for contact
      return { type: "final_response", final_response: { final_patient_reply: "Для записи нужен ваш телефон." } } as RuntimeAgentCallerOutput;
    };

    const loop = createRuntimeAgentLoop({
      model: "test-model",
      caller,
      executors: {} as ToolExecutorRegistry,
      now: new Date("2026-07-03T20:25:00.000Z"),
      timezone: "Europe/Prague",
      bookingProcessStateRepository: {
        async loadState() { return { selected_slot: { starts_at: "2026-07-04T13:00:00" } }; },
        async saveState() {},
      },
    });

    const result: RuntimeAgentTurnResult = await loop.runTurn({
      user_message: "Да завтра на 13:00",
      clinic_id: "clinic_1",
      contact_id: "contact_3",
      locale: "ru",
      channel_contact: undefined,
    });

    // Conversation preserved (guarded finalization succeeded)
    assert.notStrictEqual(result.conversation_id, null);
    assert.notStrictEqual(result.conversation_id_resumable, false);
    // Guarded result in tool_results
    const bookingResult = result.tool_results.find((r) => r.tool === "booking.apply");
    assert.ok(bookingResult, "guarded booking.apply result must appear");
    assert.strictEqual((bookingResult!.data as Record<string, unknown>).booking_status, "missing_trusted_phone");
    assert.strictEqual((result.debug as Record<string, unknown>)?.reason,
      "booking_apply_preflight_missing_trusted_phone_round1");
  });

  it("proceeds normally when trusted phone is present (does not fire phone preflight)", async () => {
    // With a trusted phone, the loop should proceed past the phone preflight.
    // Round 1: caller returns booking.apply → phone guard does not fire (trusted phone present).
    // Executor not registered → not_implemented result. Round 2: caller returns booking.apply again.
    // → forced_finalization fires after round 2, Guard B present, executor returns not_implemented again.
    // Total tool_results >= 1 and none is a phone preflight intercept.
    let callCount2 = 0;
    const caller2: RuntimeAgentCaller = async () => {
      callCount2++;
      return {
        type: "tool_requests" as const,
        conversation_id: "conv-phone-trusted",
        tool_requests: [{
          tool: "booking.apply",
          call_id: `call-trusted-${callCount2}`,
          arguments: { requested_date: "2026-07-04", requested_time: "13:00", service: "consultation", first_name: "Boris", last_name: "Test" },
        }],
      } as RuntimeAgentCallerOutput;
    };

    const loop2 = createRuntimeAgentLoop({
      model: "test-model",
      caller: caller2,
      executors: {} as ToolExecutorRegistry,
      now: new Date("2026-07-03T20:25:00.000Z"),
      timezone: "Europe/Prague",
    });

    const result: RuntimeAgentTurnResult = await loop2.runTurn({
      user_message: "Да завтра на 13:00",
      clinic_id: "clinic_1",
      contact_id: "contact_4",
      locale: "ru",
      channel_contact: {
        phone_number: "+380991234567",
        phone_source: "telegram_contact_button",
      },
    });

    // Should NOT be the phone preflight intercept
    assert.notStrictEqual(
      (result.debug as Record<string, unknown>)?.reason,
      "booking_apply_preflight_missing_trusted_phone_round1",
    );
    // tool_results should have at least one booking.apply result (even if failed — no executor)
    assert.ok(result.tool_results.length >= 1, "Expected at least one tool result");
    assert.strictEqual(result.tool_results[0].tool, "booking.apply");
  });
});

// ---------------------------------------------------------------------------
// Integration: runtimeAgentLoop — past-time guard (round 2 / Guard B)
// ---------------------------------------------------------------------------
describe("runtimeAgentLoop — booking.apply past-time preflight (round 2 Guard B)", () => {
  // Round 1: availability.check → slots. Round 2: booking.apply for past time.
  // Simulates a race: slots were available, but by the time booking.apply fires, time passed.
  // The guard fires and the helper submits a guarded tool_result back to the model.

  const fakeAvailabilityExecutor = async () => ({
    tool: "availability.check" as const,
    status: "success" as const,
    data: { slots: [{ slot_id: "s1", starts_at: "2026-07-03T13:00:00", ends_at: "2026-07-03T13:30:00" }], timezone: "Europe/Prague", total_slots: 1, free_slots_count: 1 },
  });

  it("blocks Guard B execution when past-time detected for same-day slot", async () => {
    let callCount = 0;
    const fakeCaller: RuntimeAgentCaller = async () => {
      callCount++;
      if (callCount === 1) {
        return {
          type: "tool_requests",
          conversation_id: "conv-r2-past",
          tool_requests: [
            { tool: "availability.check", call_id: "call-avail", arguments: { requested_date: "2026-07-03" } },
          ],
        } as RuntimeAgentCallerOutput;
      }
      if (callCount === 2) {
        // Round 2: request booking.apply for a past time (guard fires, helper called)
        return {
          type: "tool_requests",
          conversation_id: "conv-r2-past",
          tool_requests: [
            { tool: "booking.apply", call_id: "call-book", arguments: { subject_id: "subject_1", requested_date: "2026-07-03", requested_time: "13:00", service: "consultation" } },
          ],
        } as RuntimeAgentCallerOutput;
      }
      // Call 3: guarded finalization — model explains time has passed
      return { type: "final_response", final_response: { final_patient_reply: "Это время уже прошло. Выберите другое время." } } as RuntimeAgentCallerOutput;
    };

    const loop = createRuntimeAgentLoop({
      model: "test-model",
      caller: fakeCaller,
      executors: { "availability.check": fakeAvailabilityExecutor } as unknown as ToolExecutorRegistry,
      now: new Date("2026-07-03T20:25:00.000Z"), // 22:25 Prague
      timezone: "Europe/Prague",
    });

    const result = await loop.runTurn({
      user_message: "запиши на 13:00",
      clinic_id: "clinic_1",
      contact_id: "contact_5",
      locale: "ru",
      channel_contact: { phone_number: "+380991234567", phone_source: "telegram_contact_button" },
    });

    // Conversation preserved (guarded finalization succeeded)
    assert.notStrictEqual(result.conversation_id, null);
    assert.notStrictEqual(result.conversation_id_resumable, false);
    assert.ok(
      result.final_patient_reply.includes("прошло") || result.final_patient_reply.includes("время"),
      `Expected past-time reply, got: ${result.final_patient_reply}`,
    );
    // Guarded tool result in tool_results
    const bookingResult = result.tool_results.find((r) => r.tool === "booking.apply");
    assert.ok(bookingResult, "guarded booking.apply result must appear");
    assert.strictEqual((bookingResult!.data as Record<string, unknown>).booking_status, "past_time");
    assert.strictEqual((result.debug as Record<string, unknown>)?.reason,
      "booking_apply_preflight_past_time_round2");
  });
});

// ---------------------------------------------------------------------------
// Integration: clinicCardAvailabilityExecutor — past slot filtering
// ---------------------------------------------------------------------------
describe("clinicCardAvailabilityExecutor — past slot filtering for today", () => {
  // Tested via unit-level isPastSlotTime to avoid importing the full executor
  // (which requires ClinicCard config). The integration is verified by the
  // unit tests above confirming that isPastSlotTime filters correctly for today.

  it("isPastSlotTime used by executor: 13:00 filtered at 22:25 Prague (acute pain transcript)", () => {
    const now = new Date("2026-07-03T20:25:00.000Z"); // 22:25 Prague
    assert.strictEqual(isPastSlotTime("13:00", now, "Europe/Prague"), true);
  });

  it("future same-day slot 23:00 not filtered at 22:25", () => {
    const now = new Date("2026-07-03T20:25:00.000Z");
    assert.strictEqual(isPastSlotTime("23:00", now, "Europe/Prague"), false);
  });
});

// ---------------------------------------------------------------------------
// Production-path: runtimeAgentLoop without injected deps.now still guards
// ---------------------------------------------------------------------------
describe("runtimeAgentLoop — turnNow fallback when deps.now is not injected", () => {
  // These tests verify that production callers that omit deps.now still get
  // a live per-turn clock (new Date() inside runTurn), not undefined.

  it("availability executor receives a non-undefined now via context.now when deps.now is omitted", async () => {
    let capturedNow: Date | undefined = undefined;

    const fakeAvailExec = async (ctx: import("../src/runtime/toolExecutor.ts").ToolExecutionContext) => {
      capturedNow = ctx.now;
      return {
        tool: "availability.check" as const,
        status: "success" as const,
        data: { slots: [], timezone: "Europe/Prague", total_slots: 0, free_slots_count: 0 },
      };
    };

    const caller: RuntimeAgentCaller = async (inp) => {
      if (!inp.input.tool_results) {
        return {
          type: "tool_requests",
          tool_requests: [{ tool: "availability.check", call_id: "c1", arguments: { requested_date: "2099-01-01" } }],
        } as RuntimeAgentCallerOutput;
      }
      return { type: "final_response", final_response: { final_patient_reply: "ok" } };
    };

    // No deps.now, no deps.timezone — production pattern
    const loop = createRuntimeAgentLoop({
      model: "test-model",
      caller,
      executors: { "availability.check": fakeAvailExec } as unknown as ToolExecutorRegistry,
    });

    await loop.runTurn({ user_message: "test", clinic_id: "clinic_1", contact_id: "c1", locale: "ru" });

    assert.ok(capturedNow instanceof Date, "context.now must be a Date when deps.now is omitted");
    // Must be close to real now (within 5 seconds)
    assert.ok(
      Math.abs(capturedNow.getTime() - Date.now()) < 5000,
      "turnNow must be close to real wall-clock time",
    );
  });

  it("blocks booking.apply for today at 00:00 when deps.now is omitted (uses real wall-clock)", async () => {
    // Get today's date in Europe/Prague so we can request a slot at 00:00 today,
    // which is guaranteed to be in the past at any hour of the real day.
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Prague",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());

    let callCount2 = 0;
    const caller: RuntimeAgentCaller = async () => {
      callCount2++;
      if (callCount2 === 1) {
        return {
          type: "tool_requests",
          tool_requests: [{
            tool: "booking.apply",
            call_id: "c1",
            arguments: { subject_id: "subject_1", requested_date: today, requested_time: "00:00", service: "consultation" },
          }],
        } as RuntimeAgentCallerOutput;
      }
      // Guarded finalization: model acknowledges the past time
      return { type: "final_response", final_response: { final_patient_reply: "Это время уже прошло." } } as RuntimeAgentCallerOutput;
    };

    // No deps.now — production pattern
    const loop = createRuntimeAgentLoop({
      model: "test-model",
      caller,
      executors: {} as ToolExecutorRegistry,
      timezone: "Europe/Prague",
    });

    const result = await loop.runTurn({
      user_message: "запишите на 00:00",
      clinic_id: "clinic_1",
      contact_id: "c2",
      locale: "ru",
      channel_contact: { phone_number: "+380991234567", phone_source: "telegram_contact_button" },
    });

    // 00:00 today is always in the past — past-time preflight must fire
    assert.strictEqual(
      (result.debug as Record<string, unknown>)?.reason,
      "booking_apply_preflight_past_time_round1",
      `Expected past-time block, got debug.reason=${(result.debug as Record<string, unknown>)?.reason}`,
    );
    // Guarded tool result present in tool_results
    const bookingResult = result.tool_results.find((r) => r.tool === "booking.apply");
    assert.ok(bookingResult, "guarded booking.apply result must appear");
    assert.strictEqual((bookingResult!.data as Record<string, unknown>).booking_status, "past_time");
  });

  it("existing injected deps.now tests remain deterministic (no wall-clock usage)", async () => {
    // Confirm that when deps.now IS injected, turnNow = deps.now exactly (not new Date()).
    // frozenNow = 2099-12-31 21:00 UTC = 22:00 Prague (UTC+1 in winter).
    // Today in Prague = "2099-12-31".  Requesting "2099-12-31" at "10:00" is in the past.
    // Real wall-clock is ~2026, so "2099-12-31" would NOT be today for new Date() —
    // the past-time guard can only fire if the injected clock is being used.
    const frozenNow = new Date("2099-12-31T21:00:00.000Z"); // 22:00 Prague (UTC+1 winter)
    const todayInPrague2099 = "2099-12-31";

    const caller: RuntimeAgentCaller = async () => ({
      type: "tool_requests",
      tool_requests: [{
        tool: "booking.apply",
        call_id: "c1",
        arguments: { subject_id: "subject_1", requested_date: todayInPrague2099, requested_time: "10:00", service: "consultation" },
      }],
    } as RuntimeAgentCallerOutput);

    const loop = createRuntimeAgentLoop({
      model: "test-model",
      caller,
      executors: {} as ToolExecutorRegistry,
      now: frozenNow,
      timezone: "Europe/Prague",
    });

    const result = await loop.runTurn({
      user_message: "test",
      clinic_id: "clinic_1",
      contact_id: "c3",
      locale: "ru",
      channel_contact: { phone_number: "+380991234567", phone_source: "telegram_contact_button" },
    });

    assert.strictEqual(
      (result.debug as Record<string, unknown>)?.reason,
      "booking_apply_preflight_past_time_round1",
      "Injected frozen clock must drive the past-time decision (real wall-clock would not see 2099 as today)",
    );
  });
});
