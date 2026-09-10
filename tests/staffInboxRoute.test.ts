import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerStaffInboxRoutes } from "../src/runtime/staffInboxRoute.ts";
import type { StaffInboxItem, StaffInboxRepository } from "../src/runtime/staffInboxRepository.ts";

const sample: StaffInboxItem = {
  request_id: "11111111-1111-4111-8111-111111111111",
  clinic_id: "22222222-2222-4222-8222-222222222222",
  contact_id: "33333333-3333-4333-8333-333333333333",
  request: {
    kind: "callback",
    patient_target: "self",
    person_ref: "patient",
    summary: "Please call me",
    preferred_contact_window: null,
    reply_language: "en",
  },
  delivery_status: "sent",
  workflow_status: "open",
  resolution_note: null,
  created_at: "2026-09-09T10:00:00.000Z",
  updated_at: "2026-09-09T10:00:00.000Z",
  resolved_at: null,
};

function makeRepository() {
  const calls: Array<{ method: string; input: unknown }> = [];
  const repository: StaffInboxRepository = {
    async list(input) {
      calls.push({ method: "list", input });
      return { ok: true, data: [sample] };
    },
    async setStatus(input) {
      calls.push({ method: "setStatus", input });
      return { ok: true, data: {
        ...sample,
        workflow_status: input.status,
        resolution_note: input.status === "resolved" ? input.resolution_note ?? null : null,
        resolved_at: input.status === "resolved" ? "2026-09-09T11:00:00.000Z" : null,
      } };
    },
    async metrics(input) {
      calls.push({ method: "metrics", input });
      return { ok: true, data: {
        open_requests: 1,
        acknowledged_requests: 2,
        queued_notifications: 3,
        processing_notifications: 1,
        dead_letter_notifications: 0,
        oldest_queued_age_seconds: 42,
      } };
    },
  };
  return { repository, calls };
}

async function createApp() {
  const h = makeRepository();
  const app = Fastify();
  registerStaffInboxRoutes(app, {
    repository: h.repository,
    apiKey: "staff-test-secret",
    isProduction: true,
  });
  await app.ready();
  return { app, ...h };
}

test("staff inbox API fails closed without Runtime API auth", async () => {
  const { app } = await createApp();
  try {
    const response = await app.inject({
      method: "GET",
      url: `/staff/requests?clinic_id=${sample.clinic_id}`,
    });
    assert.equal(response.statusCode, 401);
  } finally {
    await app.close();
  }
});

test("staff inbox lists open requests with bounded defaults", async () => {
  const { app, calls } = await createApp();
  try {
    const response = await app.inject({
      method: "GET",
      url: `/staff/requests?clinic_id=${sample.clinic_id}`,
      headers: { authorization: "Bearer staff-test-secret" },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().items, [sample]);
    assert.deepEqual(calls[0], {
      method: "list",
      input: { clinic_id: sample.clinic_id, status: "open", limit: 50 },
    });
  } finally {
    await app.close();
  }
});

test("staff inbox resolves requests with an operator note", async () => {
  const { app, calls } = await createApp();
  try {
    const response = await app.inject({
      method: "POST",
      url: `/staff/requests/${sample.request_id}/status`,
      headers: { authorization: "Bearer staff-test-secret" },
      payload: {
        clinic_id: sample.clinic_id,
        status: "resolved",
        resolution_note: "Called patient back",
      },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().item.workflow_status, "resolved");
    assert.deepEqual(calls[0], {
      method: "setStatus",
      input: {
        clinic_id: sample.clinic_id,
        request_id: sample.request_id,
        status: "resolved",
        resolution_note: "Called patient back",
      },
    });
  } finally {
    await app.close();
  }
});

test("staff metrics exposes queue and dead-letter health", async () => {
  const { app, calls } = await createApp();
  try {
    const response = await app.inject({
      method: "GET",
      url: `/staff/metrics?clinic_id=${sample.clinic_id}`,
      headers: { "x-runtime-api-key": "staff-test-secret" },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().queued_notifications, 3);
    assert.equal(response.json().oldest_queued_age_seconds, 42);
    assert.deepEqual(calls[0], { method: "metrics", input: { clinic_id: sample.clinic_id } });
  } finally {
    await app.close();
  }
});

test("staff inbox rejects unsupported workflow status", async () => {
  const { app } = await createApp();
  try {
    const response = await app.inject({
      method: "GET",
      url: `/staff/requests?clinic_id=${sample.clinic_id}&status=deleted`,
      headers: { authorization: "Bearer staff-test-secret" },
    });
    assert.equal(response.statusCode, 400);
  } finally {
    await app.close();
  }
});
