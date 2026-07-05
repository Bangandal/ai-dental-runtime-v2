/**
 * PR #134: availability.check past-time preflight + system instruction hardening.
 *
 * Tests:
 * 1. availability.check for today at a past time → no executor call, past-time reply.
 * 2. availability.check for today without requested_time → executor runs normally.
 * 3. booking.apply past-time guards (PR #133) still pass (regression).
 * 4. System instruction snapshot includes availability-hallucination guard rules.
 * 5. telegram_contact_button channel_contact is trusted by hasTrustedPhone.
 * 6. manual_input / typed phone is rejected by hasTrustedPhone.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRuntimeAgentLoop } from "../src/runtime/runtimeAgentLoop.ts";
import type {
  RuntimeAgentCaller,
  RuntimeAgentCallerOutput,
} from "../src/runtime/runtimeAgentLoop.ts";
import type { ToolExecutorRegistry } from "../src/runtime/toolExecutor.ts";
import { buildRuntimeAgentSystemInstruction } from "../src/runtime/openaiRuntimeAgent.ts";
import { hasTrustedPhone } from "../src/runtime/bookingContactGuard.ts";

// ── 1. availability.check past-time preflight ─────────────────────────────────

describe("availability.check past-time preflight (PR #134)", () => {
  // now = 22:25 Prague on 2026-07-03 (20:25 UTC)
  const now = new Date("2026-07-03T20:25:00.000Z");
  const timezone = "Europe/Prague";

  it("blocks availability.check for today at a past time (13:00 at 22:25) — no executor call", async () => {
    let executorCalled = false;

    const fakeAvailExecutor = async () => {
      executorCalled = true;
      return {
        tool: "availability.check" as const,
        status: "success" as const,
        data: { slots: [], timezone, total_slots: 0, free_slots_count: 0 },
      };
    };

    const caller: RuntimeAgentCaller = async () => ({
      type: "tool_requests",
      tool_requests: [{
        tool: "availability.check",
        call_id: "c1",
        arguments: { requested_date: "2026-07-03", requested_time: "13:00" },
      }],
    } as RuntimeAgentCallerOutput);

    const loop = createRuntimeAgentLoop({
      model: "test",
      caller,
      executors: { "availability.check": fakeAvailExecutor } as unknown as ToolExecutorRegistry,
      now,
      timezone,
    });

    const result = await loop.runTurn({
      user_message: "Хочу сегодня на 13:00",
      clinic_id: "clinic_1",
      contact_id: "avail_pf_1",
      locale: "ru",
    });

    assert.strictEqual(executorCalled, false, "availability executor must NOT be called for past time");
    assert.strictEqual((result.debug as Record<string, unknown>).reason, "availability_preflight_past_time");
    assert.deepStrictEqual(result.tool_results, []);
    assert.strictEqual(result.conversation_id, null);
    assert.strictEqual(result.conversation_id_resumable, false);
    assert.ok(
      result.final_patient_reply.includes("прошло") || result.final_patient_reply.includes("время"),
      `Expected past-time reply, got: ${result.final_patient_reply}`,
    );
  });

  it("past-time reply for availability.check is locale-aware (cs)", async () => {
    const caller: RuntimeAgentCaller = async () => ({
      type: "tool_requests",
      tool_requests: [{ tool: "availability.check", call_id: "c1", arguments: { requested_date: "2026-07-03", requested_time: "09:00" } }],
    } as RuntimeAgentCallerOutput);

    const loop = createRuntimeAgentLoop({ model: "test", caller, executors: {} as ToolExecutorRegistry, now, timezone });
    const result = await loop.runTurn({ user_message: "dnes v 9:00", clinic_id: "clinic_1", contact_id: "avail_pf_cs", locale: "cs" });

    assert.ok(
      result.final_patient_reply.includes("uplynul") || result.final_patient_reply.includes("čas"),
      `Expected Czech past-time reply, got: ${result.final_patient_reply}`,
    );
  });
});

// ── 2. availability.check without requested_time → executor runs normally ─────

describe("availability.check without requested_time — executor runs, past-slot filtering only", () => {
  const now = new Date("2026-07-03T20:25:00.000Z"); // 22:25 Prague
  const timezone = "Europe/Prague";

  it("no requested_time → preflight does not fire, executor is called", async () => {
    let executorCalled = false;

    const fakeAvailExecutor = async () => {
      executorCalled = true;
      return {
        tool: "availability.check" as const,
        status: "success" as const,
        data: { slots: [], timezone, total_slots: 0, free_slots_count: 0 },
      };
    };

    let callerCallCount = 0;
    const caller: RuntimeAgentCaller = async () => {
      callerCallCount++;
      if (callerCallCount === 1) {
        return {
          type: "tool_requests",
          tool_requests: [{ tool: "availability.check", call_id: "c1", arguments: { requested_date: "2026-07-03" } }],
        } as RuntimeAgentCallerOutput;
      }
      return { type: "final_response", final_response: { final_patient_reply: "Нет слотов на сегодня." } };
    };

    const loop = createRuntimeAgentLoop({
      model: "test",
      caller,
      executors: { "availability.check": fakeAvailExecutor } as unknown as ToolExecutorRegistry,
      now,
      timezone,
    });

    await loop.runTurn({ user_message: "Есть слоты сегодня?", clinic_id: "clinic_1", contact_id: "avail_pf_2", locale: "ru" });

    assert.strictEqual(executorCalled, true, "executor must run when no requested_time");
  });

  it("future date with past-looking time → preflight does NOT fire (not today)", async () => {
    let executorCalled = false;
    const fakeAvailExecutor = async () => {
      executorCalled = true;
      return { tool: "availability.check" as const, status: "success" as const, data: { slots: [], timezone, total_slots: 0, free_slots_count: 0 } };
    };

    let count = 0;
    const caller: RuntimeAgentCaller = async () => {
      count++;
      if (count === 1) return { type: "tool_requests", tool_requests: [{ tool: "availability.check", call_id: "c1", arguments: { requested_date: "2026-07-04", requested_time: "09:00" } }] } as RuntimeAgentCallerOutput;
      return { type: "final_response", final_response: { final_patient_reply: "ok" } };
    };

    const loop = createRuntimeAgentLoop({ model: "test", caller, executors: { "availability.check": fakeAvailExecutor } as unknown as ToolExecutorRegistry, now, timezone });
    await loop.runTurn({ user_message: "завтра в 9:00", clinic_id: "clinic_1", contact_id: "avail_pf_3", locale: "ru" });
    assert.strictEqual(executorCalled, true, "tomorrow's slots — executor must run");
  });
});

// ── 3. booking.apply past-time regression ────────────────────────────────────

describe("booking.apply past-time guard (PR #133 regression)", () => {
  it("booking.apply for today at past time still blocked after PR #134", async () => {
    const now = new Date("2026-07-03T20:25:00.000Z");
    const caller: RuntimeAgentCaller = async () => ({
      type: "tool_requests",
      tool_requests: [{ tool: "booking.apply", call_id: "c1", arguments: { requested_date: "2026-07-03", requested_time: "13:00", service: "consultation" } }],
    } as RuntimeAgentCallerOutput);

    const loop = createRuntimeAgentLoop({ model: "test", caller, executors: {} as ToolExecutorRegistry, now, timezone: "Europe/Prague" });
    const result = await loop.runTurn({
      user_message: "запиши на 13:00",
      clinic_id: "clinic_1",
      contact_id: "avail_pf_r1",
      locale: "ru",
      channel_contact: { phone_number: "+380991234567", phone_source: "telegram_contact_button" },
    });

    assert.strictEqual((result.debug as Record<string, unknown>).reason, "booking_apply_preflight_past_time_round1");
  });
});

// ── 4. System instruction snapshot ───────────────────────────────────────────

describe("buildRuntimeAgentSystemInstruction — availability hallucination guard (PR #134)", () => {
  const instruction = buildRuntimeAgentSystemInstruction({
    now: new Date("2026-07-03T20:25:00.000Z"),
    timezone: "Europe/Prague",
  });

  it("includes hard rule: never claim availability without availability.check proof", () => {
    assert.ok(
      instruction.includes("availability.check") && instruction.includes("tool_results"),
      "System instruction must reference availability.check and tool_results in the availability rule",
    );
  });

  it("explicitly forbids inventing time windows like '13:00–18:00' or 'после обеда'", () => {
    assert.ok(
      instruction.includes("инвент") || instruction.includes("invent") || instruction.includes("после обеда") || instruction.includes("time window"),
      "System instruction must warn against inventing time windows",
    );
  });

  it("includes rule about disabled mode not implying online booking can complete", () => {
    assert.ok(
      instruction.includes("disabled") || instruction.includes("online booking"),
      "System instruction must mention disabled mode booking restriction",
    );
  });
});

// ── 5 & 6. Contact button trust audit ────────────────────────────────────────

describe("hasTrustedPhone — contact button audit (PR #134)", () => {
  it("5. telegram_contact_button is trusted", () => {
    assert.strictEqual(
      hasTrustedPhone({ phone_number: "+380991234567", phone_source: "telegram_contact_button" }),
      true,
    );
  });

  it("6. manual_input (typed phone) is NOT trusted", () => {
    assert.strictEqual(
      hasTrustedPhone({ phone_number: "+380991234567", phone_source: "manual_input" }),
      false,
    );
  });

  it("6b. missing phone_source is NOT trusted", () => {
    assert.strictEqual(
      hasTrustedPhone({ phone_number: "+380991234567", phone_source: "" }),
      false,
    );
  });

  it("5b. API test: channel_contact with phone_source=telegram_contact_button bypasses phone preflight", async () => {
    // When trusted phone is present, the round-1 phone guard does not fire.
    // booking.apply for tomorrow → phone guard passes → executor runs (or fails due to no executor).
    const caller: RuntimeAgentCaller = async () => ({
      type: "tool_requests",
      tool_requests: [{ tool: "booking.apply", call_id: "c1", arguments: { requested_date: "2026-07-04", requested_time: "13:00", service: "consultation", first_name: "Test", last_name: "Patient" } }],
    } as RuntimeAgentCallerOutput);

    const loop = createRuntimeAgentLoop({
      model: "test",
      caller,
      executors: {} as ToolExecutorRegistry,
      now: new Date("2026-07-03T20:25:00.000Z"),
      timezone: "Europe/Prague",
    });

    const result = await loop.runTurn({
      user_message: "завтра 13:00",
      clinic_id: "clinic_1",
      contact_id: "avail_pf_tb1",
      locale: "ru",
      channel_contact: { phone_number: "+380991234567", phone_source: "telegram_contact_button" },
    });

    // Must NOT fire the phone preflight
    assert.notStrictEqual(
      (result.debug as Record<string, unknown>).reason,
      "booking_apply_preflight_missing_trusted_phone_round1",
      "trusted phone must bypass the phone preflight guard",
    );
    // booking.apply must appear in tool_results (executor ran, even if it returned not_implemented)
    assert.ok(
      result.tool_results.some((r) => r.tool === "booking.apply"),
      "booking.apply must have a tool result when phone is trusted",
    );
  });
});
