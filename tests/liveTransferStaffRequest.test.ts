import test from "node:test";
import assert from "node:assert/strict";
import { parseStaffRequest, staffRequestReceipt, type StaffRequest } from "../src/runtime/staffRequest.ts";

const request: StaffRequest = {
  kind: "live_transfer",
  patient_target: "self",
  person_ref: "caller",
  summary: "Caller asks to speak with clinic staff now.",
  preferred_contact_window: null,
  reply_language: "en",
};

test("live transfer is accepted by the deterministic staff-request schema", () => {
  assert.deepEqual(parseStaffRequest(request), request);
});

test("live transfer receipt never claims the provider transfer already completed", () => {
  const receipt = staffRequestReceipt(request, {
    type: "staff_request",
    kind: "live_transfer",
    request_id: "request-1",
    request_saved: true,
    delivery_status: "sent",
    delivery_recorded: true,
    may_claim_notified: true,
  });
  assert.match(receipt, /not yet been confirmed/i);
});
