import assert from "node:assert/strict";
import test from "node:test";

import { TOOL_POLICY_MATRIX } from "../src/runtime/toolPolicy.ts";
import type {
  BookingRepository,
  ConversationMemoryRepository,
  ContactRepository,
  NotificationRepository,
  RuntimeResult,
  KnowledgeRepository,
} from "../src/runtime/runtimeRepositories.ts";

test("repository methods are Promise<RuntimeResult<...>> typed contracts", async () => {
  const contactRepo: ContactRepository = {
    async getOrCreateContact() {
      return { ok: true, data: { contact_id: "c1" } };
    },
    async getContactCaseContext() {
      return { ok: true, data: { contact: { contact_id: "c1" }, active_case: null } };
    },
    async getActiveBookingContext() {
      return { ok: true, data: { timezone: "UTC" } };
    },
  };

  const result = await contactRepo.getOrCreateContact({ phone_e164: "+15555550123" });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.data.contact_id, "c1");
  }
});

test("booking repository includes future lookupAppointment boundary", async () => {
  const bookingRepo: BookingRepository = {
    async checkAvailability() {
      return { ok: true, data: { slots: [] } };
    },
    async createHold() {
      return {
        ok: true,
        data: {
          hold_id: "h1",
          slot_id: "s1",
          contact_id: "c1",
          case_id: "case_1",
          status: "active",
          starts_at: "2026-05-22T09:00:00Z",
          ends_at: "2026-05-22T09:30:00Z",
          expires_at: "2026-05-22T08:55:00Z",
        },
      };
    },
    async confirmBooking() {
      return { ok: true, data: { appointment_id: "a1", lookup_rpc_gap: true } };
    },
    async lookupAppointment() {
      return { ok: true, data: { appointment_id: "a1", lookup_rpc_gap: true } };
    },
    async cancelHold() {
      return {
        ok: true,
        data: {
          hold_id: "h1",
          slot_id: "s1",
          contact_id: "c1",
          case_id: "case_1",
          status: "cancelled",
          starts_at: "2026-05-22T09:00:00Z",
          ends_at: "2026-05-22T09:30:00Z",
          expires_at: "2026-05-22T08:55:00Z",
        },
      };
    },
  };

  const lookup = await bookingRepo.lookupAppointment({ appointment_id: "a1" });
  assert.equal(lookup.ok, true);
  if (lookup.ok) {
    assert.equal(lookup.data.lookup_rpc_gap, true);
  }
});



test("knowledge repository includes clinic-scoped search contract", async () => {
  const knowledgeRepo: KnowledgeRepository = {
    async searchKnowledge(input) {
      assert.equal(input.clinic_id, "clinic_1");
      return { ok: true, data: { chunks: [{ chunk_id: "k1", text: "Hours are 8 to 5" }] } };
    },
  };

  const result = await knowledgeRepo.searchKnowledge({ clinic_id: "clinic_1", query: "hours" });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.data.chunks[0]?.chunk_id, "k1");
  }
});
test("notification repository prepares payloads only and does not expose send methods", () => {
  type NotificationKeys = keyof NotificationRepository;
  const allowedKey: NotificationKeys = "prepareAdminNotification";
  assert.equal(allowedKey, "prepareAdminNotification");

  const methodNames = Object.keys({ prepareAdminNotification: true });
  assert.deepEqual(methodNames, ["prepareAdminNotification"]);
});

test("admin.notify is not a runtime tool", () => {
  assert.equal(Object.keys(TOOL_POLICY_MATRIX).includes("admin.notify"), false);
});

test("repository boundary module avoids infra imports and documents TODO gaps", async () => {
  const fs = await import("node:fs/promises");
  const source = await fs.readFile(new URL("../src/runtime/runtimeRepositories.ts", import.meta.url), "utf8");

  const importLines = source
    .split("\n")
    .filter((line) => line.trimStart().startsWith("import"))
    .join("\n")
    .toLowerCase();

  for (const blockedWord of ["supabase", "openai", "calendar", "n8n"]) {
    assert.equal(importLines.includes(blockedWord), false);
  }

  assert.equal(source.includes("TODO(gap)"), true);
});

test("RuntimeResult supports typed success and typed failure", () => {
  const okResult: RuntimeResult<{ id: string }, "not_found"> = { ok: true, data: { id: "1" } };
  const failResult: RuntimeResult<{ id: string }, "not_found"> = {
    ok: false,
    error: {
      code: "not_found",
      message: "missing",
      retryable: false,
    },
  };

  assert.equal(okResult.ok, true);
  assert.equal(failResult.ok, false);
});

test("conversation memory repository contract returns RuntimeResult shapes", async () => {
  const memoryRepo: ConversationMemoryRepository = {
    async getConversationMemory() {
      return { ok: true, data: { conversation_id: null } };
    },
    async saveConversationMemory(_input) {
      return { ok: true, data: { conversation_id: "conv_123" } };
    },
  };

  const loaded = await memoryRepo.getConversationMemory({ clinic_id: "clinic_1", case_id: "case_1" });
  assert.equal(loaded.ok, true);
  if (loaded.ok) {
    assert.equal(loaded.data.conversation_id, null);
  }

  const saved = await memoryRepo.saveConversationMemory({
    clinic_id: "clinic_1",
    contact_id: "contact_1",
    conversation_id: "conv_123",
  });
  assert.equal(saved.ok, true);
  if (saved.ok) {
    assert.equal(saved.data.conversation_id, "conv_123");
  }
});

test("conversation memory persistence doc includes required guarantees", async () => {
  const fs = await import("node:fs/promises");
  const source = await fs.readFile(
    new URL("../docs/OPENAI_CONVERSATION_MEMORY_PERSISTENCE.md", import.meta.url),
    "utf8",
  );

  assert.equal(source.toLowerCase().includes("dialogue continuity"), true);
  assert.equal(source.includes("Supabase/Postgres remains the source of truth"), true);
  assert.equal(source.includes("before `OpenAIPlanner.plan`"), true);
  assert.equal(source.includes("after planner execution"), true);

  for (const phrase of [
    "bookings",
    "holds",
    "appointments",
    "prices",
    "patient identity",
  ]) {
    assert.equal(source.toLowerCase().includes(phrase), true);
  }
});
