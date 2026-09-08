import test from "node:test";
import assert from "node:assert/strict";
import { withStaffRequestHandling } from "../src/runtime/staffRequestHandling.ts";
import type { StaffRequest } from "../src/runtime/staffRequest.ts";
import type { RuntimeTurnOrchestratorDeps } from "../src/runtime/runtimeTurnOrchestrator.ts";

process.env.RUNTIME_AGENT_MODE = "agent_first";

const CLINIC = "11111111-1111-4111-8111-111111111111";
const CONTACT = "22222222-2222-4222-8222-222222222222";
const request: StaffRequest = {
  kind: "callback",
  patient_target: "self",
  person_ref: "patient",
  summary: "Patient asks for a callback.",
  preferred_contact_window: "tomorrow 10-11",
  reply_language: "en",
};

test("same provider event uses the same durable staff-request key across Runtime retries", async () => {
  const durableKeys: string[] = [];
  let notifications = 0;
  const deps: RuntimeTurnOrchestratorDeps = {
    runtimeTurnService: {
      async runTurn() {
        return {
          final_patient_reply: "Staff were notified.",
          tool_requests: [],
          tool_results: [],
          staff_request: request,
        };
      },
    },
    staffRequestRepository: {
      async create(input) {
        const first = durableKeys.length === 0;
        durableKeys.push(input.trace_id);
        return {
          ok: true,
          data: {
            request_id: "request-1",
            created: first,
            delivery_status: first ? "pending" : "sent",
          },
        };
      },
      async recordDelivery() {
        return { ok: true, data: { ok: true } };
      },
    },
    adminNotifier: {
      async notify(payload) {
        notifications += 1;
        return {
          type: "admin_notification",
          status: "sent",
          channel: "telegram",
          reason: payload.reason,
          trace_id: payload.trace_id,
        };
      },
    },
  };

  const wrapped = withStaffRequestHandling(deps);
  const baseInput = {
    clinic_id: CLINIC,
    contact_id: CONTACT,
    trace_id: "runtime-trace-1",
    user_message: "Please call me tomorrow.",
    locale: "en",
    business_context: {
      channel: "telegram",
      chat_id: "chat-7",
      meta: { message_id: "provider-message-42" },
    },
  };

  await wrapped.runtimeTurnService.runTurn(baseInput);
  await wrapped.runtimeTurnService.runTurn({ ...baseInput, trace_id: "runtime-trace-2" });

  assert.deepEqual(durableKeys, [
    "telegram:chat-7:msg:provider-message-42",
    "telegram:chat-7:msg:provider-message-42",
  ]);
  assert.equal(notifications, 1);
});
