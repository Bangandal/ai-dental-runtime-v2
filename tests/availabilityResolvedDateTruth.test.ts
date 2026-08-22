import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAvailabilityActionTruth,
  type AuthoritativeAvailabilityAttempt,
} from "../src/runtime/availabilityActionTruth.ts";
import { buildAvailabilityPresentationTruth } from "../src/runtime/availabilityPresentationTruth.ts";
import type { RuntimeAgentToolRequest, RuntimeAgentToolResult } from "../src/runtime/openaiRuntimeAgent.ts";

function autoExtendedAttempt(): AuthoritativeAvailabilityAttempt {
  const request: RuntimeAgentToolRequest = {
    tool: "availability.check",
    call_id: "availability-1",
    arguments: { requested_date: "2026-08-22", service_interest: "cleaning" },
  };
  const result: RuntimeAgentToolResult = {
    tool: "availability.check",
    call_id: "availability-1",
    status: "success",
    data: {
      nearest_available_date: "2026-08-24",
      timezone: "Europe/Prague",
      slots: [
        {
          slot_id: "2026-08-24T09:00",
          starts_at: "2026-08-24T09:00:00",
          ends_at: "2026-08-24T09:30:00",
        },
        {
          slot_id: "2026-08-24T09:30",
          starts_at: "2026-08-24T09:30:00",
          ends_at: "2026-08-24T10:00:00",
        },
      ],
    },
  };
  return { attempted: true, request, pair: { request, result } };
}

test("action truth separates requested date from auto-extended resolved date", () => {
  const truth = buildAvailabilityActionTruth(autoExtendedAttempt());
  assert.ok(truth);
  assert.equal(truth.requested_date, "2026-08-22");
  assert.equal(truth.requested_weekday, "saturday");
  assert.equal(truth.resolved_date, "2026-08-24");
  assert.equal(truth.resolved_weekday, "monday");
  assert.equal(truth.nearest_available_date, "2026-08-24");
  assert.deepEqual(truth.allowed_slot_starts, ["09:00", "09:30"]);
});

test("presentation truth carries exact resolved date and weekday with every slot", () => {
  const truth = buildAvailabilityPresentationTruth(autoExtendedAttempt());
  assert.ok(truth);
  assert.equal(truth.resolved_date, "2026-08-24");
  assert.equal(truth.resolved_weekday, "monday");
  assert.equal(truth.timezone, "Europe/Prague");
  assert.deepEqual(truth.allowed_slot_starts, ["09:00", "09:30"]);
  assert.deepEqual(
    truth.allowed_slots.map((slot) => ({ date: slot.date, weekday: slot.weekday, time: slot.time })),
    [
      { date: "2026-08-24", weekday: "monday", time: "09:00" },
      { date: "2026-08-24", weekday: "monday", time: "09:30" },
    ],
  );
});

test("presentation truth fails closed for slots that do not belong to nearest_available_date", () => {
  const attempt = autoExtendedAttempt();
  if (!attempt.attempted || attempt.pair === null) throw new Error("expected pair");
  attempt.pair.result.data = {
    nearest_available_date: "2026-08-24",
    timezone: "Europe/Prague",
    slots: [
      {
        slot_id: "stale",
        starts_at: "2026-08-22T12:00:00",
        ends_at: "2026-08-22T12:30:00",
      },
      {
        slot_id: "fresh",
        starts_at: "2026-08-24T09:00:00",
        ends_at: "2026-08-24T09:30:00",
      },
    ],
  };

  const truth = buildAvailabilityPresentationTruth(attempt);
  assert.ok(truth);
  assert.deepEqual(truth.allowed_slot_starts, ["09:00"]);
  assert.equal(truth.allowed_slots[0].date, "2026-08-24");
});
