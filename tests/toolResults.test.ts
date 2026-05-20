import assert from "node:assert/strict";
import test from "node:test";

import type { ToolName } from "../src/runtime/toolPolicy.ts";
import {
  makeFailedToolResult,
  makeNotImplementedToolResult,
  type AvailabilityCheckResult,
  type BookingConfirmResult,
  type HoldCreateResult,
  type KbSearchResult,
  type ToolExecutionResult,
} from "../src/runtime/toolResults.ts";

test("each success result type can be constructed with valid data", () => {
  const kbSearchResult: KbSearchResult = {
    tool: "kb.search",
    status: "success",
    data: { chunks: [{ chunk_id: "c1", text: "cleaning policy" }] },
  };

  const availabilityCheckResult: AvailabilityCheckResult = {
    tool: "availability.check",
    status: "success",
    data: {
      slots: [{ slot_id: "s1", starts_at: "2026-05-22T09:00:00Z", ends_at: "2026-05-22T09:30:00Z" }],
      timezone: "UTC",
    },
  };

  const holdCreateResult: HoldCreateResult = {
    tool: "hold.create",
    status: "success",
    data: {
      hold_id: "h1",
      slot_id: "s1",
      starts_at: "2026-05-22T09:00:00Z",
      ends_at: "2026-05-22T09:30:00Z",
      expires_at: "2026-05-22T08:55:00Z",
      contact_id: "contact_1",
      case_id: "case_1",
    },
  };

  const bookingConfirmResult: BookingConfirmResult = {
    tool: "booking.confirm",
    status: "success",
    data: {
      appointment_id: "appt_1",
      hold_id: "h1",
      contact_id: "contact_1",
      case_id: "case_1",
      starts_at: "2026-05-22T09:00:00Z",
      ends_at: "2026-05-22T09:30:00Z",
      status: "booked_pending_admin_confirmation",
    },
  };

  assert.equal(kbSearchResult.data.chunks.length, 1);
  assert.equal(availabilityCheckResult.data.slots.length, 1);
  assert.equal(holdCreateResult.data.expires_at, "2026-05-22T08:55:00Z");
  assert.equal(bookingConfirmResult.data.appointment_id, "appt_1");
  assert.equal(bookingConfirmResult.data.hold_id, "h1");
  assert.equal(bookingConfirmResult.data.contact_id, "contact_1");
  assert.equal(bookingConfirmResult.data.case_id, "case_1");
});

test("makeNotImplementedToolResult for appointment.mutate returns not_implemented", () => {
  const result = makeNotImplementedToolResult("appointment.mutate");
  assert.equal(result.tool, "appointment.mutate");
  assert.equal(result.status, "not_implemented");
});

test("makeFailedToolResult returns failed with error", () => {
  const result = makeFailedToolResult("availability.check", "upstream_timeout", "provider timeout", true);
  assert.equal(result.tool, "availability.check");
  assert.equal(result.status, "failed");
  assert.deepEqual(result.error, {
    code: "upstream_timeout",
    message: "provider timeout",
    retryable: true,
  });
});

test("ToolExecutionResult union accepts all current runtime tools and excludes admin.notify", () => {
  const tools: ToolName[] = [
    "kb.search",
    "availability.check",
    "hold.create",
    "booking.confirm",
    "cancel_hold",
    "appointment.mutate",
  ];

  const results: ToolExecutionResult[] = [
    { tool: "kb.search", status: "success", data: { chunks: [] } },
    { tool: "availability.check", status: "success", data: { slots: [] } },
    {
      tool: "hold.create",
      status: "success",
      data: {
        hold_id: "h1",
        slot_id: "s1",
        starts_at: "2026-05-22T09:00:00Z",
        ends_at: "2026-05-22T09:30:00Z",
        expires_at: "2026-05-22T08:55:00Z",
        contact_id: "contact_1",
        case_id: "case_1",
      },
    },
    {
      tool: "booking.confirm",
      status: "success",
      data: {
        appointment_id: "appt_1",
        hold_id: "h1",
        contact_id: "contact_1",
        case_id: "case_1",
        starts_at: "2026-05-22T09:00:00Z",
        ends_at: "2026-05-22T09:30:00Z",
        status: "booked_confirmed",
      },
    },
    { tool: "cancel_hold", status: "success", data: { hold_id: "h1", status: "cancelled" } },
    { tool: "appointment.mutate", status: "not_implemented", data: null },
  ];

  assert.equal(results.length, tools.length);
  assert.equal(tools.includes("kb.search"), true);
  assert.equal(tools.includes("cancel_hold"), true);
  assert.equal(tools.includes("appointment.mutate"), true);
  assert.equal(tools.includes("admin.notify" as ToolName), false);
});
