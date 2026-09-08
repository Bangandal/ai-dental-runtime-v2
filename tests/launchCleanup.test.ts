import assert from "node:assert/strict";
import test from "node:test";

import {
  buildModelVisibleRuntimeContext,
  isSemanticContextFresh,
  resolveSemanticContextTtlMs,
} from "../src/runtime/modelVisibleRuntimeContext.ts";
import { projectModelFacingContext } from "../src/runtime/modelFacingContextProjection.ts";
import { createSerializedBookingProcessStateRepository } from "../src/runtime/serializedBookingProcessStateRepository.ts";
import type { BookingProcessState, BookingProcessStateRepository } from "../src/runtime/bookingProcessState.ts";
import { normalizeTelegramUpdate } from "../src/runtime/telegramWebhookAdapter.ts";
import { normalizeWhatsAppPayload } from "../src/runtime/whatsappWebhookAdapter.ts";
import { handleInboundMediaStaffRequest } from "../src/runtime/inboundMediaStaffRequest.ts";

test("semantic context TTL defaults to 24h and expires old agent-first task memory", () => {
  const previousMode = process.env.RUNTIME_AGENT_MODE;
  const previousTtl = process.env.RUNTIME_SEMANTIC_CONTEXT_TTL_HOURS;
  try {
    process.env.RUNTIME_AGENT_MODE = "agent_first";
    delete process.env.RUNTIME_SEMANTIC_CONTEXT_TTL_HOURS;
    assert.equal(resolveSemanticContextTtlMs(), 24 * 60 * 60 * 1000);
    assert.equal(
      isSemanticContextFresh("2026-09-07T08:00:00.000Z", new Date("2026-09-08T10:00:00.000Z")),
      false,
    );

    const runtimeContext = buildModelVisibleRuntimeContext({
      known_contact: { first_name: "Mila", language_code: "uk" },
      conversation_state: {
        updated_at: "2026-09-07T08:00:00.000Z",
        collected: {
          service_interest: "braces",
          problem: "broken wire",
          preferred_time: "Friday",
          agent_qualification: { complaint: "pain", reported_facts: ["since yesterday"] },
          agent_staff_request: {
            request: {
              kind: "callback",
              patient_target: "self",
              person_ref: "Mila",
              summary: "Call me",
              preferred_contact_window: "after 17:00",
              reply_language: "uk",
            },
          },
        },
      },
      recent_history: [
        { role: "user", text: "old booking topic" },
        { role: "assistant", text: "old reply" },
      ],
    });

    const projected = projectModelFacingContext({
      locale: "uk",
      runtime_context: {
        ...runtimeContext,
        booking_subjects: {
          active_subject_id: "subject_2",
          subjects: [
            { id: "subject_1", label: "self", patient_name: "Mila", service: "braces" },
            { id: "subject_2", label: "mother", patient_name: "Anna", service: "hygiene" },
          ],
        },
      },
    });
    const visibleRuntime = projected.runtime_context as Record<string, unknown>;

    assert.equal(visibleRuntime.task_state, undefined);
    assert.equal(visibleRuntime.qualification_state, undefined);
    assert.equal(visibleRuntime.staff_request_context, undefined);
    assert.equal(visibleRuntime.booking_subjects, undefined);
    assert.deepEqual(visibleRuntime.recent_history, []);
    assert.equal("_semantic_memory_fresh" in visibleRuntime, false);
    assert.deepEqual(visibleRuntime.patient_context, { display_name: "Mila" });
  } finally {
    if (previousMode === undefined) delete process.env.RUNTIME_AGENT_MODE;
    else process.env.RUNTIME_AGENT_MODE = previousMode;
    if (previousTtl === undefined) delete process.env.RUNTIME_SEMANTIC_CONTEXT_TTL_HOURS;
    else process.env.RUNTIME_SEMANTIC_CONTEXT_TTL_HOURS = previousTtl;
  }
});

function bookingState(service: string): BookingProcessState {
  return {
    service_reason: service,
    proof: {
      service_known: true,
      name_known: false,
      slot_known: false,
      trusted_phone_known: false,
      ready_for_booking_apply: false,
    },
  };
}

test("serialized booking repository preserves write order and skips identical durable state", async () => {
  const calls: string[] = [];
  let persisted: Partial<BookingProcessState> | null = null;
  const base: BookingProcessStateRepository = {
    async loadState() {
      return persisted;
    },
    async saveState(_key, state, onDebug) {
      calls.push(`start:${state.service_reason}`);
      await new Promise((resolve) => setTimeout(resolve, state.service_reason === "first" ? 20 : 1));
      persisted = state;
      calls.push(`end:${state.service_reason}`);
      onDebug?.({ saved: true });
    },
  };

  const repo = createSerializedBookingProcessStateRepository(base);
  const key = { clinic_id: "clinic", contact_id: "contact" };
  await Promise.all([
    repo.saveState(key, bookingState("first")),
    repo.saveState(key, bookingState("second")),
    repo.saveState(key, bookingState("second")),
  ]);

  assert.deepEqual(calls, [
    "start:first",
    "end:first",
    "start:second",
    "end:second",
  ]);
  assert.equal(persisted?.service_reason, "second");
});

test("Telegram photo/document normalization exposes metadata notice without provider file ids", () => {
  const photo = normalizeTelegramUpdate({
    update_id: 10,
    message: {
      message_id: 20,
      chat: { id: 30, type: "private" },
      from: { id: 40, first_name: "Mila" },
      photo: [{ file_id: "secret-photo-file-id" }],
    },
  }, "clinic_1");
  assert.equal(photo.ok, true);
  assert.equal(photo.ok && photo.type, "media_notice");
  assert.equal(JSON.stringify(photo).includes("secret-photo-file-id"), false);

  const document = normalizeTelegramUpdate({
    update_id: 11,
    message: {
      message_id: 21,
      chat: { id: 31, type: "private" },
      from: { id: 41 },
      document: { file_id: "secret-document-file-id", file_name: "xray.pdf" },
    },
  }, "clinic_1");
  assert.equal(document.ok, true);
  assert.equal(document.ok && document.type, "media_notice");
  assert.equal(JSON.stringify(document).includes("secret-document-file-id"), false);
  assert.equal(JSON.stringify(document).includes("xray.pdf"), false);
});

test("WhatsApp image/document normalization exposes media notice without media ids", () => {
  const result = normalizeWhatsAppPayload({
    object: "whatsapp_business_account",
    entry: [{
      changes: [{
        value: {
          messages: [
            { from: "420700000001", id: "wamid-image", type: "image", image: { id: "private-image-id" } },
            { from: "420700000001", id: "wamid-doc", type: "document", document: { id: "private-doc-id", filename: "scan.pdf" } },
          ],
        },
      }],
    }],
  }, "clinic_1");

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.normalizedTurns.length, 2);
  assert.equal(result.ok && result.normalizedTurns[0]?.type, "media_notice");
  assert.equal(result.ok && result.normalizedTurns[1]?.type, "media_notice");
  assert.equal(JSON.stringify(result).includes("private-image-id"), false);
  assert.equal(JSON.stringify(result).includes("private-doc-id"), false);
  assert.equal(JSON.stringify(result).includes("scan.pdf"), false);
});

test("metadata-only media handoff dedupes and notifies staff without media content", async () => {
  let inboundRegistrations = 0;
  let requestCreates = 0;
  let notificationPayload: Record<string, unknown> | null = null;

  const deps = {
    clinicIdentityResolver: {
      async resolveClinicIdentity() {
        return { ok: true as const, data: { clinic_id: "clinic-uuid", clinic_code: "clinic_1" } };
      },
    },
    turnPersistenceRepository: {
      async getOrCreateContact() {
        return { ok: true as const, data: { contact_id: "contact-uuid", clinic_id: "clinic-uuid" } };
      },
      async registerInboundEvent() {
        inboundRegistrations += 1;
        return { ok: true as const, data: { inbound_event_id: "evt", is_duplicate: inboundRegistrations > 1, accepted: true } };
      },
    },
    staffRequestRepository: {
      async create(input: { request: unknown }) {
        requestCreates += 1;
        assert.equal(JSON.stringify(input).includes("file_id"), false);
        assert.equal(JSON.stringify(input).includes("media_id"), false);
        return { ok: true as const, data: { request_id: "req-1", created: true, delivery_status: "pending" as const } };
      },
      async recordDelivery() {
        return { ok: true as const, data: { ok: true as const } };
      },
    },
    adminNotifier: {
      async notify(payload: Record<string, unknown>) {
        notificationPayload = payload;
        return {
          type: "admin_notification" as const,
          status: "sent" as const,
          channel: "telegram" as const,
          reason: "document_update",
          trace_id: String(payload.trace_id),
        };
      },
    },
  } as any;

  const notice = {
    clinic_code: "clinic_1",
    channel: "telegram" as const,
    external_user_id: "40",
    chat_id: "30",
    message_id: "20",
    update_id: "10",
    media_kind: "photo" as const,
    patient_display_name: "Mila",
  };

  const first = await handleInboundMediaStaffRequest(notice, deps);
  const second = await handleInboundMediaStaffRequest(notice, deps);

  assert.equal(first.outcome, "processed");
  assert.equal(second.outcome, "duplicate");
  assert.equal(requestCreates, 1);
  assert.ok(notificationPayload);
  assert.equal(JSON.stringify(notificationPayload).includes("file_id"), false);
  assert.equal(JSON.stringify(notificationPayload).includes("media_id"), false);
});
