/**
 * PR #168 — slot time normalization and last_available_slots fallback.
 *
 * Real incident: patient wrote "На 15 00" (space separator), bot replied
 * "Не вижу подтверждения слота на 15:00" because extractSlotTime only
 * handled colon and dot separators. selected_slot was never set, so
 * shouldInterceptMissingSlotProof fired even though the slot was valid.
 *
 * Two fixes:
 * 1. extractSlotTime now recognises "H M" / "HH MM" (space separator).
 * 2. shouldInterceptMissingSlotProof checks lastAvailableSlots as a
 *    defense-in-depth fallback when selected_slot is null.
 *
 * Tests:
 * STN-1  extractSlotTime: "15 00" → "15:00"
 * STN-2  extractSlotTime: "на 15 00" → "15:00"
 * STN-3  extractSlotTime: "9 00" → "09:00"
 * STN-4  extractSlotTime: "17:30" still works (colon unchanged)
 * STN-5  extractSlotTime: "17.30" still works (dot unchanged)
 * STN-6  detectSelectedSlot: "На 15 00" matches 15:00 slot
 * STN-7  shouldInterceptMissingSlotProof: does NOT fire when requested
 *         time is in lastAvailableSlots, even if selectedSlot is null
 * STN-8  shouldInterceptMissingSlotProof: DOES fire when requested time
 *         is NOT in lastAvailableSlots and selectedSlot is null
 */

import assert from "node:assert/strict";
import test from "node:test";

import { extractSlotTime, detectSelectedSlot } from "../src/runtime/bookingProcessState.ts";
import { shouldInterceptMissingSlotProof } from "../src/runtime/bookingApplyPreflight.ts";
import type { AvailableSlot } from "../src/runtime/bookingProcessState.ts";
import type { RuntimeAgentToolRequest } from "../src/runtime/openaiRuntimeAgent.ts";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const SLOT_1500: AvailableSlot = {
  starts_at: "2026-07-08T15:00:00",
  ends_at: "2026-07-08T15:30:00",
  slot_id: "s1500",
};

const SLOT_1330: AvailableSlot = {
  starts_at: "2026-07-08T13:30:00",
  ends_at: "2026-07-08T14:00:00",
  slot_id: "s1330",
};

const BOOKING_APPLY_1500: RuntimeAgentToolRequest = {
  tool: "booking.apply",
  call_id: "call_bk_168",
  arguments: {
    first_name: "Олег",
    last_name: "Захаров",
    service: "чистка",
    requested_date: "2026-07-08",
    requested_time: "15:00",
  },
};

// ── STN-1 ─────────────────────────────────────────────────────────────────────

test("STN-1: extractSlotTime('15 00') returns '15:00'", () => {
  assert.strictEqual(extractSlotTime("15 00"), "15:00");
});

// ── STN-2 ─────────────────────────────────────────────────────────────────────

test("STN-2: extractSlotTime('на 15 00') returns '15:00'", () => {
  assert.strictEqual(extractSlotTime("на 15 00"), "15:00");
});

// ── STN-3 ─────────────────────────────────────────────────────────────────────

test("STN-3: extractSlotTime('9 00') returns '09:00' (zero-padded)", () => {
  assert.strictEqual(extractSlotTime("9 00"), "09:00");
});

// ── STN-4 ─────────────────────────────────────────────────────────────────────

test("STN-4: extractSlotTime('17:30') still returns '17:30' (colon)", () => {
  assert.strictEqual(extractSlotTime("17:30"), "17:30");
});

// ── STN-5 ─────────────────────────────────────────────────────────────────────

test("STN-5: extractSlotTime('17.30') still returns '17:30' (dot)", () => {
  assert.strictEqual(extractSlotTime("17.30"), "17:30");
});

// ── STN-6 ─────────────────────────────────────────────────────────────────────

test("STN-6: detectSelectedSlot('На 15 00') matches 15:00 slot", () => {
  const result = detectSelectedSlot("На 15 00", [SLOT_1330, SLOT_1500]);
  assert.ok(result !== null, "Expected a matched slot, got null");
  assert.strictEqual(result?.slot_id, "s1500", `Expected s1500, got ${result?.slot_id}`);
});

// ── STN-7 ─────────────────────────────────────────────────────────────────────

test("STN-7: shouldInterceptMissingSlotProof returns false when requested time is in lastAvailableSlots", () => {
  const result = shouldInterceptMissingSlotProof({
    pendingToolRequests: [BOOKING_APPLY_1500],
    completedToolResults: [],
    selectedSlot: null,
    lastAvailableSlots: [SLOT_1330, SLOT_1500],
  });
  assert.strictEqual(
    result,
    false,
    "Should NOT intercept: 15:00 is in lastAvailableSlots even though selectedSlot is null",
  );
});

// ── STN-8 ─────────────────────────────────────────────────────────────────────

test("STN-8: shouldInterceptMissingSlotProof returns true when time is NOT in lastAvailableSlots and selectedSlot is null", () => {
  const result = shouldInterceptMissingSlotProof({
    pendingToolRequests: [BOOKING_APPLY_1500],
    completedToolResults: [],
    selectedSlot: null,
    lastAvailableSlots: [SLOT_1330], // only 13:30, not 15:00
  });
  assert.strictEqual(
    result,
    true,
    "Should intercept: 15:00 is NOT in lastAvailableSlots and no selectedSlot",
  );
});
