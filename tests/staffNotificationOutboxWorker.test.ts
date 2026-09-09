import test from "node:test";
import assert from "node:assert/strict";
import { createStaffNotificationOutboxWorker } from "../src/runtime/staffNotificationOutboxWorker.ts";
import type { StaffNotificationOutboxItem, StaffNotificationOutboxRepository } from "../src/runtime/supabaseStaffNotificationOutboxRepository.ts";

function item(attemptCount = 1): StaffNotificationOutboxItem {
  return {
    outbox_id: "outbox-1",
    request_id: "request-1",
    clinic_id: "11111111-1111-4111-8111-111111111111",
    contact_id: "22222222-2222-4222-8222-222222222222",
    request: {
      kind: "callback",
      patient_target: "self",
      person_ref: "patient",
      summary: "Please call me back",
      preferred_contact_window: "tomorrow morning",
      reply_language: "en",
    },
    notification_context: {
      clinic_id: "11111111-1111-4111-8111-111111111111",
      clinic_code: "clinic-test",
      channel: "whatsapp",
      chat_id: "chat-1",
      external_user_id: "user-1",
      trace_id: "runtime-trace-1",
      patient_display_name: "patient",
      phone_source: null,
      phone_available: false,
      original_message: "Please call me back",
      requested_service: null,
      requested_date: null,
      requested_time: null,
      booking_status: "not_requested",
      created_visit: false,
      may_claim_booked: false,
      required_next_action: "staff_review",
      reason: "callback",
      timestamp: "2026-09-09T10:00:00.000Z",
    },
    attempt_count: attemptCount,
  };
}

function repository(items: StaffNotificationOutboxItem[]) {
  const completions: Array<Record<string, unknown>> = [];
  const repo: StaffNotificationOutboxRepository = {
    async claim() { return { ok: true, data: items }; },
    async complete(input) {
      completions.push(input as unknown as Record<string, unknown>);
      return { ok: true, data: { ok: true } };
    },
  };
  return { repo, completions };
}

test("outbox worker marks successful staff notification sent", async () => {
  const h = repository([item()]);
  let seenRequestId = "";
  const worker = createStaffNotificationOutboxWorker({
    repository: h.repo,
    notifier: {
      async notify(payload) {
        seenRequestId = payload.staff_request?.request_id ?? "";
        return {
          type: "admin_notification",
          status: "sent",
          channel: "telegram",
          reason: payload.reason,
          trace_id: payload.trace_id,
        };
      },
    },
  });
  const result = await worker.runOnce();
  assert.equal(seenRequestId, "request-1");
  assert.deepEqual(result, { claimed: 1, sent: 1, retried: 0, terminal: 0, persistence_failures: 0 });
  assert.equal(h.completions[0]?.terminal, true);
  assert.equal(h.completions[0]?.retry_after_seconds, null);
});

test("outbox worker retries transient provider failures with backoff", async () => {
  const h = repository([item(2)]);
  const worker = createStaffNotificationOutboxWorker({
    repository: h.repo,
    notifier: {
      async notify(payload) {
        return {
          type: "admin_notification",
          status: "failed",
          channel: "telegram",
          reason: payload.reason,
          trace_id: payload.trace_id,
          error_code: "network",
        };
      },
    },
    maxAttempts: 8,
  });
  const result = await worker.runOnce();
  assert.equal(result.retried, 1);
  assert.equal(h.completions[0]?.terminal, false);
  assert.equal(h.completions[0]?.retry_after_seconds, 60);
});

test("outbox worker dead-letters terminal configuration failures and exhausted retries", async () => {
  for (const [status, attempts] of [["not_configured", 1], ["failed", 8]] as const) {
    const h = repository([item(attempts)]);
    const worker = createStaffNotificationOutboxWorker({
      repository: h.repo,
      notifier: {
        async notify(payload) {
          return {
            type: "admin_notification",
            status,
            channel: "telegram",
            reason: payload.reason,
            trace_id: payload.trace_id,
          };
        },
      },
      maxAttempts: 8,
    });
    const result = await worker.runOnce();
    assert.equal(result.terminal, 1);
    assert.equal(h.completions[0]?.terminal, true);
  }
});
