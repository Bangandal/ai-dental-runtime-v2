import assert from "node:assert/strict";
import test from "node:test";

import { createClinicCardAvailabilityExecutor } from "../src/integrations/cliniccard/clinicCardAvailabilityExecutor.ts";
import {
  buildAvailabilityActionTruth,
  resolveAuthoritativeAvailabilityAttempt,
} from "../src/runtime/availabilityActionTruth.ts";
import type { RuntimeAgentToolRequest, RuntimeAgentToolResult } from "../src/runtime/openaiRuntimeAgent.ts";

const ENV = {
  CLINICCARD_API_BASE_URL: "https://cliniccard.invalid",
  CLINICCARD_API_TOKEN: "test-token",
  CLINICCARD_DEFAULT_DOCTOR_ID: "10",
  CLINICCARD_DEFAULT_CABINET_ID: "20",
  CLINICCARD_TIMEZONE: "Europe/Prague",
  CLINICCARD_BOOKING_MODE: "disabled",
  CLINICCARD_AVAILABILITY_POLICY_CONFIRMED: "true",
  CLINICCARD_WORKING_DAYS: "1,2,3,4,5,6,7",
  CLINICCARD_WORKING_HOURS_START: "09:00",
  CLINICCARD_WORKING_HOURS_END: "18:00",
  CLINICCARD_SLOT_DURATION_MINUTES: "30",
  CLINICCARD_CLOSED_DATES: "",
};

function truthFor(
  request: RuntimeAgentToolRequest,
  result: RuntimeAgentToolResult,
) {
  return buildAvailabilityActionTruth(
    resolveAuthoritativeAvailabilityAttempt([request], [result]),
  );
}

test("PF-005: missing requested date deterministically asks for a date and authorizes no slots", () => {
  const request: RuntimeAgentToolRequest = {
    tool: "availability.check",
    call_id: "missing-date",
    arguments: {},
  };
  const result: RuntimeAgentToolResult = {
    tool: "availability.check",
    call_id: "missing-date",
    status: "failed",
    error: {
      code: "availability_missing_requested_date",
      message: "requested_date is required",
      retryable: false,
    },
  };

  const truth = truthFor(request, result);
  assert.ok(truth);
  assert.equal(truth.outcome, "needs_date");
  assert.equal(truth.requested_date, null);
  assert.equal(truth.can_present_slots, false);
  assert.equal(truth.required_next_action, "ask_for_date");
  assert.deepEqual(truth.allowed_slot_starts, []);
});

test("PF-005: invalid or ambiguous requested date asks for a concrete date, not technical retry", () => {
  const request: RuntimeAgentToolRequest = {
    tool: "availability.check",
    call_id: "invalid-date",
    arguments: { requested_date: "next-ish Tuesday" },
  };
  const result: RuntimeAgentToolResult = {
    tool: "availability.check",
    call_id: "invalid-date",
    status: "failed",
    error: {
      code: "availability_invalid_requested_date",
      message: "requested_date must be a valid YYYY-MM-DD clinic date",
      retryable: false,
    },
  };

  const truth = truthFor(request, result);
  assert.ok(truth);
  assert.equal(truth.outcome, "needs_date");
  assert.equal(truth.requested_date, "next-ish Tuesday");
  assert.equal(truth.can_present_slots, false);
  assert.equal(truth.required_next_action, "ask_for_date");
  assert.deepEqual(truth.allowed_slot_starts, []);
});

test("PF-005: a real ClinicCard failure remains technical_failure", () => {
  const request: RuntimeAgentToolRequest = {
    tool: "availability.check",
    call_id: "cliniccard-failure",
    arguments: { requested_date: "2099-08-21" },
  };
  const result: RuntimeAgentToolResult = {
    tool: "availability.check",
    call_id: "cliniccard-failure",
    status: "failed",
    error: {
      code: "cliniccard_http_error",
      message: "HTTP 503",
      retryable: true,
    },
  };

  const truth = truthFor(request, result);
  assert.ok(truth);
  assert.equal(truth.outcome, "technical_failure");
  assert.equal(truth.can_present_slots, false);
  assert.equal(truth.required_next_action, "retry_or_contact_clinic");
});

test("PF-005: missing or invalid date fails before any ClinicCard adapter is created", async () => {
  let adapterFactoryCalls = 0;
  const executor = createClinicCardAvailabilityExecutor({
    env: ENV,
    adapterFactory: () => {
      adapterFactoryCalls += 1;
      throw new Error("adapter must not be created for unresolved date");
    },
  });

  const missing = await executor({});
  assert.equal(missing.status, "failed");
  if (missing.status === "failed") {
    assert.equal(missing.error.code, "availability_missing_requested_date");
  }

  const invalid = await executor({ requested_date: "tomorrow maybe" });
  assert.equal(invalid.status, "failed");
  if (invalid.status === "failed") {
    assert.equal(invalid.error.code, "availability_invalid_requested_date");
  }

  assert.equal(adapterFactoryCalls, 0);
});
