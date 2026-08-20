import assert from "node:assert/strict";
import test from "node:test";

import { buildBookingApplyActionTruth, buildBookingApplyEmergencyFallback } from "../src/runtime/bookingApplyGuard.ts";
import type { RuntimeAgentToolResult } from "../src/runtime/openaiRuntimeAgent.ts";

const ambiguousResult: RuntimeAgentToolResult = {
  tool: "booking.apply",
  call_id: "identity-1",
  status: "success",
  data: {
    booking_action: "booking_apply",
    booking_status: "identity_ambiguous",
    created_visit: false,
    may_claim_booked: false,
    cliniccard_visit_id: null,
    reason: "ambiguous identity",
    proof: null,
  },
};

test("IDENTITY-ACTION-1: identity_ambiguous deterministically requires admin_handoff", () => {
  const truth = buildBookingApplyActionTruth([ambiguousResult]);
  assert.ok(truth);
  assert.equal(truth.required_next_action, "admin_handoff");
  assert.equal(truth.allowed_claims.can_say_booking_created, false);
  assert.equal(truth.allowed_claims.can_say_booking_confirmed, false);
});

test("IDENTITY-ACTION-2: emergency fallback never claims booking success for ambiguous identity", () => {
  const reply = buildBookingApplyEmergencyFallback([ambiguousResult], "ru");
  assert.match(reply, /карточк|пациент/i);
  assert.doesNotMatch(reply, /запись создана/i);
});
