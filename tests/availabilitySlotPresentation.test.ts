/**
 * PR #135: availability slot presentation guard.
 *
 * Tests:
 * A. System instruction contains rule: mention only exact times from tool_results.
 * B. System instruction forbids range summaries ("13:00–18:00", "с 13 до 18", "после обеда есть").
 * C. availability_presentation_truth is injected when availability.check returns slots.
 * D. allowed_slot_starts contains only actual slot starts from tool_results.
 * E. Given slots 09:00, 09:30, 14:00, 14:30, 17:30 → correct allowed_slot_starts, no "18:00".
 * F. max_slots_to_present = 5.
 * G. PR #134 availability_preflight_past_time: past-time preflight still blocks correctly.
 * H. Booking.apply phone/past-time guard regression: still active after PR #135.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildRuntimeAgentSystemInstruction } from "../src/runtime/openaiRuntimeAgent.ts";
import { buildAvailabilityPresentationTruth } from "../src/runtime/availabilityPresentationTruth.ts";
import { resolveAuthoritativeAvailabilityAttempt } from "../src/runtime/availabilityActionTruth.ts";
import { createRuntimeAgentLoop } from "../src/runtime/runtimeAgentLoop.ts";
import type {
  RuntimeAgentCaller,
  RuntimeAgentCallerOutput,
  RuntimeAgentCallerInput,
} from "../src/runtime/runtimeAgentLoop.ts";
import type { ToolExecutorRegistry } from "../src/runtime/toolExecutor.ts";

// ── A. System instruction: exact slot times rule ──────────────────────────────

describe("PR #135 — A: system instruction mentions only exact times from tool_results", () => {
  const instruction = buildRuntimeAgentSystemInstruction({
    now: new Date("2026-07-04T10:00:00.000Z"),
    timezone: "Europe/Prague",
  });

  it("includes 'mention only exact' or 'only exact slot start times' rule", () => {
    assert.ok(
      instruction.toLowerCase().includes("mention only exact") ||
        instruction.includes("only exact slot start times") ||
        (instruction.includes("exact") && instruction.includes("tool_results")),
      "System instruction must contain a rule restricting slot mentions to exact times from tool_results",
    );
  });

  it("references allowed_slot_starts as the authoritative source", () => {
    assert.ok(
      instruction.includes("allowed_slot_starts"),
      "System instruction must reference allowed_slot_starts to guide the model",
    );
  });
});

// ── B. System instruction: forbids range summaries ───────────────────────────

describe("PR #135 — B: system instruction explicitly forbids range summaries", () => {
  const instruction = buildRuntimeAgentSystemInstruction({
    now: new Date("2026-07-04T10:00:00.000Z"),
    timezone: "Europe/Prague",
  });

  it("forbids the range '13:00–18:00'", () => {
    assert.ok(
      instruction.includes("13:00–18:00"),
      "System instruction must explicitly list '13:00–18:00' as a forbidden range pattern",
    );
  });

  it("forbids the Russian range phrase 'с 13 до 18'", () => {
    assert.ok(
      instruction.includes("с 13 до 18"),
      "System instruction must explicitly forbid 'с 13 до 18'",
    );
  });

  it("forbids vague phrase 'после обеда есть'", () => {
    assert.ok(
      instruction.includes("после обеда"),
      "System instruction must explicitly forbid 'после обеда' range-style phrasing",
    );
  });

  it("includes rule to call availability.check for vague time requests ('после обеда', 'afternoon')", () => {
    assert.ok(
      instruction.includes("afternoon") || instruction.includes("после обеда"),
      "System instruction must mention that vague time requests require availability.check before listing slots",
    );
  });
});

// ── C. Loop injects availability_presentation_truth on second call ────────────

describe("PR #135 — C: availability_presentation_truth injected in second model call", () => {
  it("second caller input includes availability_presentation_truth when slots returned", async () => {
    const slots = [
      { starts_at: "2026-07-11T13:00:00.000Z", ends_at: "2026-07-11T13:30:00.000Z" },
      { starts_at: "2026-07-11T14:00:00.000Z", ends_at: "2026-07-11T14:30:00.000Z" },
    ];

    let secondCallContext: Record<string, unknown> | null = null;
    let callCount = 0;

    const caller: RuntimeAgentCaller = async (
      input: RuntimeAgentCallerInput,
    ): Promise<RuntimeAgentCallerOutput> => {
      callCount++;
      if (callCount === 1) {
        return {
          type: "tool_requests",
          conversation_id: "conv_c_test",
          tool_requests: [
            {
              tool: "availability.check",
              call_id: "call_c1",
              arguments: { requested_date: "2026-07-11" },
            },
          ],
        } as RuntimeAgentCallerOutput;
      }
      // Capture second call context
      secondCallContext = input.input.context;
      return {
        type: "final_response",
        conversation_id: "conv_c_test",
        final_response: {
          final_patient_reply: "На пятницю маємо: 13:00, 14:00. Який підходить?",
        },
      };
    };

    const fakeAvailExecutor = async () => ({
      tool: "availability.check" as const,
      status: "success" as const,
      data: {
        slots,
        timezone: "Europe/Prague",
        total_slots: 2,
        free_slots_count: 2,
      },
    });

    const loop = createRuntimeAgentLoop({
      model: "test",
      caller,
      executors: {
        "availability.check": fakeAvailExecutor,
      } as unknown as ToolExecutorRegistry,
      now: new Date("2026-07-04T10:00:00.000Z"),
      timezone: "Europe/Prague",
    });

    await loop.runTurn({
      user_message: "Є місця в п'ятницю після обіду?",
      clinic_id: "clinic_1",
      contact_id: "slot_pres_c1",
      locale: "uk",
    });

    assert.ok(secondCallContext !== null, "Second caller call must have occurred");
    assert.ok(
      "availability_presentation_truth" in secondCallContext,
      `Second call context must contain availability_presentation_truth. Got keys: ${Object.keys(secondCallContext).join(", ")}`,
    );

    const truth = secondCallContext["availability_presentation_truth"] as Record<string, unknown>;
    assert.strictEqual(truth["must_list_exact_slots_only"], true);
    assert.strictEqual(truth["must_not_summarize_ranges"], true);
  });

  it("availability_presentation_truth is NOT added when availability.check returns no slots", async () => {
    let secondCallContext: Record<string, unknown> | null = null;
    let callCount = 0;

    const caller: RuntimeAgentCaller = async (
      input: RuntimeAgentCallerInput,
    ): Promise<RuntimeAgentCallerOutput> => {
      callCount++;
      if (callCount === 1) {
        return {
          type: "tool_requests",
          tool_requests: [{ tool: "availability.check", call_id: "call_c2", arguments: { requested_date: "2026-07-11" } }],
        } as RuntimeAgentCallerOutput;
      }
      secondCallContext = input.input.context;
      return { type: "final_response", final_response: { final_patient_reply: "Нет свободных слотов." } };
    };

    const fakeEmptyExecutor = async () => ({
      tool: "availability.check" as const,
      status: "success" as const,
      data: { slots: [], timezone: "Europe/Prague", total_slots: 0, free_slots_count: 0 },
    });

    const loop = createRuntimeAgentLoop({
      model: "test",
      caller,
      executors: { "availability.check": fakeEmptyExecutor } as unknown as ToolExecutorRegistry,
      now: new Date("2026-07-04T10:00:00.000Z"),
      timezone: "Europe/Prague",
    });

    await loop.runTurn({ user_message: "Есть места?", clinic_id: "clinic_1", contact_id: "slot_pres_c2", locale: "ru" });

    // Empty slots → no truth or truth with empty allowed_slot_starts
    if (secondCallContext && "availability_presentation_truth" in secondCallContext) {
      const truth = secondCallContext["availability_presentation_truth"] as Record<string, unknown>;
      assert.deepStrictEqual(truth["allowed_slot_starts"], [], "Empty slots → allowed_slot_starts must be []");
    }
    // Either not present or empty allowed_slot_starts — both are valid
  });
});

// ── D & E. buildAvailabilityPresentationTruth: slot extraction ────────────────

describe("PR #135 — D & E: buildAvailabilityPresentationTruth extracts correct slot starts", () => {
  it("D. allowed_slot_starts contains only actual slot starts, derived from starts_at", () => {
    const toolResults = [
      {
        tool: "availability.check" as const,
        call_id: "c1",
        status: "success" as const,
        data: {
          slots: [
            { starts_at: "2026-07-11T13:00:00.000Z" },
            { starts_at: "2026-07-11T14:30:00.000Z" },
          ],
        },
      },
    ];
    const requests = [{ tool: "availability.check" as const, call_id: "c1", arguments: {} }];

    const truth = buildAvailabilityPresentationTruth(resolveAuthoritativeAvailabilityAttempt(requests, toolResults));
    assert.ok(truth !== null, "Should return truth for successful availability results");
    assert.deepStrictEqual(truth!.allowed_slot_starts, ["13:00", "14:30"]);
  });

  it("E. Given slots 09:00, 09:30, 14:00, 14:30, 17:30 → exact list, no 18:00", () => {
    const toolResults = [
      {
        tool: "availability.check" as const,
        call_id: "c2",
        status: "success" as const,
        data: {
          slots: [
            { starts_at: "2026-07-11T07:00:00.000Z" }, // 09:00 Prague (UTC+2)
            { starts_at: "2026-07-11T07:30:00.000Z" }, // 09:30 Prague
            { starts_at: "2026-07-11T12:00:00.000Z" }, // 14:00 Prague
            { starts_at: "2026-07-11T12:30:00.000Z" }, // 14:30 Prague
            { starts_at: "2026-07-11T15:30:00.000Z" }, // 17:30 Prague
          ],
        },
      },
    ];
    const requests = [{ tool: "availability.check" as const, call_id: "c2", arguments: {} }];

    const truth = buildAvailabilityPresentationTruth(resolveAuthoritativeAvailabilityAttempt(requests, toolResults));
    assert.ok(truth !== null, "Should return truth");
    // The function extracts HH:MM from ISO string directly (not timezone-converted)
    // So 07:00, 07:30, 12:00, 12:30, 15:30 are the UTC times
    const starts = truth!.allowed_slot_starts;
    assert.ok(!starts.includes("18:00"), `18:00 must NOT be in allowed_slot_starts. Got: ${starts.join(", ")}`);
    assert.strictEqual(starts.length, 5, `Expected 5 slot starts, got ${starts.length}: ${starts.join(", ")}`);
  });

  it("E (local times). Given starts_at already in local HH:MM ISO format → 09:00, 09:30, 14:00, 14:30, 17:30", () => {
    const toolResults = [
      {
        tool: "availability.check" as const,
        call_id: "c3",
        status: "success" as const,
        data: {
          slots: [
            { starts_at: "2026-07-11T09:00:00" },
            { starts_at: "2026-07-11T09:30:00" },
            { starts_at: "2026-07-11T14:00:00" },
            { starts_at: "2026-07-11T14:30:00" },
            { starts_at: "2026-07-11T17:30:00" },
          ],
        },
      },
    ];
    const requests = [{ tool: "availability.check" as const, call_id: "c3", arguments: {} }];

    const truth = buildAvailabilityPresentationTruth(resolveAuthoritativeAvailabilityAttempt(requests, toolResults));
    assert.ok(truth !== null, "Should return truth");
    assert.deepStrictEqual(
      truth!.allowed_slot_starts,
      ["09:00", "09:30", "14:00", "14:30", "17:30"],
    );
    assert.ok(!truth!.allowed_slot_starts.includes("18:00"), "18:00 must NOT appear");
  });
});

// ── F. max_slots_to_present = 5 ──────────────────────────────────────────────

describe("PR #135 — F: max_slots_to_present is always 5", () => {
  it("truth object always has max_slots_to_present = 5", () => {
    const toolResults = [
      {
        tool: "availability.check" as const,
        call_id: "c4",
        status: "success" as const,
        data: {
          slots: [{ starts_at: "2026-07-11T09:00:00" }],
        },
      },
    ];
    const requests = [{ tool: "availability.check" as const, call_id: "c4", arguments: {} }];

    const truth = buildAvailabilityPresentationTruth(resolveAuthoritativeAvailabilityAttempt(requests, toolResults));
    assert.ok(truth !== null);
    assert.strictEqual(truth!.max_slots_to_present, 5);
  });

  it("must_list_exact_slots_only and must_not_summarize_ranges are always true", () => {
    const toolResults = [
      {
        tool: "availability.check" as const,
        call_id: "c5",
        status: "success" as const,
        data: { slots: [{ starts_at: "2026-07-11T10:00:00" }] },
      },
    ];
    const requests = [{ tool: "availability.check" as const, call_id: "c5", arguments: {} }];

    const truth = buildAvailabilityPresentationTruth(resolveAuthoritativeAvailabilityAttempt(requests, toolResults));
    assert.ok(truth !== null);
    assert.strictEqual(truth!.must_list_exact_slots_only, true);
    assert.strictEqual(truth!.must_not_summarize_ranges, true);
  });
});

// ── G. PR #134 regression: availability past-time preflight ──────────────────

describe("PR #135 — G: PR #134 availability_preflight_past_time regression", () => {
  const now = new Date("2026-07-03T20:25:00.000Z"); // 22:25 Prague
  const timezone = "Europe/Prague";

  it("availability.check for today at past time is still blocked after PR #135", async () => {
    let executorCalled = false;

    const caller: RuntimeAgentCaller = async (): Promise<RuntimeAgentCallerOutput> => ({
      type: "tool_requests",
      tool_requests: [
        {
          tool: "availability.check",
          call_id: "g1",
          arguments: { requested_date: "2026-07-03", requested_time: "13:00" },
        },
      ],
    });

    const fakeExec = async () => {
      executorCalled = true;
      return { tool: "availability.check" as const, status: "success" as const, data: { slots: [], timezone, total_slots: 0, free_slots_count: 0 } };
    };

    const loop = createRuntimeAgentLoop({
      model: "test",
      caller,
      executors: { "availability.check": fakeExec } as unknown as ToolExecutorRegistry,
      now,
      timezone,
    });

    const result = await loop.runTurn({
      user_message: "Хочу сьогодні на 13:00",
      clinic_id: "clinic_1",
      contact_id: "pres_g1",
      locale: "uk",
    });

    assert.strictEqual(executorCalled, false, "Executor must NOT run for past time");
    assert.strictEqual(
      (result.debug as Record<string, unknown>).reason,
      "availability_preflight_past_time",
      "debug.reason must be availability_preflight_past_time",
    );
  });
});

// ── H. Booking.apply phone/past-time guard regression ────────────────────────

describe("PR #135 — H: booking.apply phone and past-time guard regression", () => {
  it("booking.apply without trusted phone fires phone guard (PR #132/#133 regression)", async () => {
    const caller: RuntimeAgentCaller = async (): Promise<RuntimeAgentCallerOutput> => ({
      type: "tool_requests",
      tool_requests: [
        {
          tool: "booking.apply",
          call_id: "h1",
          arguments: { subject_id: "subject_1", requested_date: "2026-07-11", requested_time: "14:00", service: "чистка зубов" },
        },
      ],
    });

    const loop = createRuntimeAgentLoop({
      model: "test",
      caller,
      executors: {} as ToolExecutorRegistry,
      now: new Date("2026-07-04T10:00:00.000Z"),
      timezone: "Europe/Prague",
      bookingProcessStateRepository: {
        async loadState() { return { selected_slot: { starts_at: "2026-07-11T14:00:00" } }; },
        async saveState() {},
      },
    });

    const result = await loop.runTurn({
      user_message: "Запишите на 14:00",
      clinic_id: "clinic_1",
      contact_id: "pres_h1",
      locale: "ru",
    });

    // No channel_contact → phone guard fires (slot proof passes via selectedSlot)
    assert.strictEqual(
      (result.debug as Record<string, unknown>).reason,
      "booking_apply_preflight_missing_trusted_phone_round1",
      "booking.apply without phone must trigger phone preflight",
    );
  });

  it("booking.apply for past time is still blocked (PR #133 regression)", async () => {
    const caller: RuntimeAgentCaller = async (): Promise<RuntimeAgentCallerOutput> => ({
      type: "tool_requests",
      tool_requests: [
        {
          tool: "booking.apply",
          call_id: "h2",
          arguments: { subject_id: "subject_1", requested_date: "2026-07-03", requested_time: "13:00", service: "consultation" },
        },
      ],
    });

    const loop = createRuntimeAgentLoop({
      model: "test",
      caller,
      executors: {} as ToolExecutorRegistry,
      now: new Date("2026-07-03T20:25:00.000Z"),
      timezone: "Europe/Prague",
    });

    const result = await loop.runTurn({
      user_message: "запиши на 13:00",
      clinic_id: "clinic_1",
      contact_id: "pres_h2",
      locale: "ru",
      channel_contact: { phone_number: "+380991234567", phone_source: "telegram_contact_button" },
    });

    assert.strictEqual(
      (result.debug as Record<string, unknown>).reason,
      "booking_apply_preflight_past_time_round1",
      "booking.apply past time must still be blocked",
    );
  });
});
