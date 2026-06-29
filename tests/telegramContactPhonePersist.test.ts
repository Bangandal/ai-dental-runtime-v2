import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeTelegramUpdate, type TelegramUpdate } from "../src/runtime/telegramWebhookAdapter.ts";
import { registerTelegramWebhookRoute, persistChannelContactPhone } from "../src/runtime/telegramWebhookRoute.ts";
import { createSupabaseRuntimeContextRepository } from "../src/runtime/supabaseRuntimeContextRepository.ts";
import { createSupabaseTurnPersistenceRepository } from "../src/runtime/supabaseTurnPersistenceRepository.ts";
import { ACTIVE_RUNTIME_AGENT_TOOLS } from "../src/runtime/openaiRuntimeAgent.ts";
import type { ClinicIdentityResolver } from "../src/runtime/supabaseClinicIdentityResolver.ts";
import type { TurnPersistenceRepository } from "../src/runtime/supabaseTurnPersistenceRepository.ts";
import type { RuntimeTurnService } from "../src/runtime/runtimeTurnService.ts";

const CLINIC = "clinic_1";
const CLINIC_UUID = "cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa";
const CONTACT_UUID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

const stubClinicResolver: ClinicIdentityResolver = {
  async resolveClinicIdentity(input) {
    if (input.clinic_identifier === CLINIC) {
      return { ok: true, data: { clinic_id: CLINIC_UUID, clinic_code: CLINIC } };
    }
    return { ok: false, error: { code: "clinic_not_found", message: "not found", retryable: false } };
  },
};

const stubService: RuntimeTurnService = {
  async runTurn() {
    return { final_patient_reply: "Чем могу помочь?", conversation_id: null, tool_requests: [], tool_results: [] };
  },
};

const OWN_CONTACT_UPDATE: TelegramUpdate = {
  update_id: 300,
  message: {
    message_id: 70,
    chat: { id: 555, type: "private" },
    from: { id: 111, first_name: "Anna" },
    contact: { phone_number: "+380991234567", first_name: "Anna", user_id: 111 },
  },
};

// ── test 1: contact update with phone_number persists phone identity ──────────

test("contact update with phone_number persists phone identity via mergeConversationState", async () => {
  const mergeStateCalls: unknown[] = [];

  const stubPersistence: TurnPersistenceRepository = {
    async getOrCreateContact() {
      return { ok: true, data: { contact_id: CONTACT_UUID, clinic_id: CLINIC_UUID } };
    },
    async registerInboundEvent() { return { ok: true, data: { inbound_event_id: "evt_1" } }; },
    async saveMessage() { return { ok: true, data: { message_id: "msg_1" } }; },
    async mergeConversationState(input) {
      mergeStateCalls.push(input);
      return { ok: true, data: { ok: true } };
    },
  };

  const contact = normalizeTelegramUpdate(OWN_CONTACT_UPDATE, CLINIC);
  assert.equal(contact.ok, true);
  if (!contact.ok || contact.type !== "contact") { assert.fail("expected contact"); return; }

  const result = await persistChannelContactPhone(contact, {
    clinicIdentityResolver: stubClinicResolver,
    turnPersistenceRepository: stubPersistence,
  });

  assert.equal(result, "persisted");
  assert.equal(mergeStateCalls.length, 1);
  const call = mergeStateCalls[0] as Record<string, unknown>;
  const flags = call.control_flags as Record<string, unknown>;
  const cc = flags.channel_contact as Record<string, unknown>;
  assert.equal(cc.phone_number, "+380991234567");
  assert.equal(cc.phone_source, "telegram_contact_button");
  assert.equal(cc.phone_consent, true);
  assert.equal(typeof cc.phone_collected_at, "string");
});

// ── test 2: contact with matching user_id is trusted ─────────────────────────

test("contact update with contact.user_id matching from.id is trusted (type=contact)", () => {
  const update: TelegramUpdate = {
    update_id: 301,
    message: {
      message_id: 71,
      chat: { id: 555, type: "private" },
      from: { id: 444 },
      contact: { phone_number: "+420777123456", user_id: 444 },
    },
  };
  const result = normalizeTelegramUpdate(update, CLINIC);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.type, "contact", "matching user_id should produce type=contact (trusted)");
});

// ── test 3: contact with mismatching user_id is rejected ─────────────────────

test("contact update with contact.user_id mismatch is rejected (type=contact_foreign)", () => {
  const update: TelegramUpdate = {
    update_id: 302,
    message: {
      message_id: 72,
      chat: { id: 555, type: "private" },
      from: { id: 100 },
      contact: { phone_number: "+420777000000", user_id: 999 },
    },
  };
  const result = normalizeTelegramUpdate(update, CLINIC);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.type, "contact_foreign", "mismatched user_id should produce contact_foreign");
});

// ── test 4: contact without phone_number does not persist ─────────────────────

test("contact update without phone_number does not persist phone (returns no_contact_phone)", () => {
  const update: TelegramUpdate = {
    update_id: 303,
    message: {
      message_id: 73,
      chat: { id: 555, type: "private" },
      from: { id: 111 },
      contact: { first_name: "Anna" },
    },
  };
  const result = normalizeTelegramUpdate(update, CLINIC);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "no_contact_phone");
});

// ── test 5: persistence round-trip contract ───────────────────────────────────
// Proves write shape (mergeConversationState control_flags.channel_contact) is consistent
// with read shape (RuntimeContext channel_contact from out_state_json.channel_contact).
// rpc_merge_conversation_state merges p_control_flags into the state JSON blob.
// rpc_get_runtime_context returns that blob as out_state_json.
// This is the same contract as topic_memory (also stored via control_flags, read via stateJson.topic_memory).

test("next runtime text turn receives channel_contact from persisted state — write/read path contract", async () => {
  // STEP 1: capture what mergeConversationState writes to p_control_flags
  let capturedControlFlags: Record<string, unknown> | undefined;
  const writeRepo = createSupabaseTurnPersistenceRepository({
    rpc: async (fn, args) => {
      if (fn === "rpc_merge_conversation_state") {
        capturedControlFlags = args.p_control_flags as Record<string, unknown>;
      }
      return { data: [{ ok: true }], error: null };
    },
  });

  await writeRepo.mergeConversationState({
    clinic_id: CLINIC_UUID,
    contact_id: CONTACT_UUID,
    user_text: "[contact_shared]",
    reply_text: "Спасибо, номер получен. Можем продолжить запись.",
    requested_action: "phone_captured",
    conversation_intent: "booking",
    handoff_recommended: false,
    confidence: "high",
    control_flags: {
      channel_contact: {
        phone_number: "+380991234567",
        phone_source: "telegram_contact_button",
        phone_consent: true,
        phone_collected_at: "2026-06-29T10:00:00.000Z",
      },
    },
  });

  assert.ok(capturedControlFlags, "rpc_merge_conversation_state must have been called");
  const writtenCc = capturedControlFlags.channel_contact as Record<string, unknown>;
  assert.equal(writtenCc.phone_number, "+380991234567", "write: phone_number must be in control_flags.channel_contact");
  assert.equal(writtenCc.phone_source, "telegram_contact_button", "write: phone_source must be in control_flags.channel_contact");

  // STEP 2: simulate DB round-trip — rpc_merge_conversation_state merges p_control_flags
  // into the state JSON; rpc_get_runtime_context returns that blob as out_state_json.
  // Read using exactly the captured write data to prove write key = read key = channel_contact.
  const readRepo = createSupabaseRuntimeContextRepository({
    rpc: async () => ({
      data: [{
        out_state_version: 1,
        out_state_json: capturedControlFlags, // DB merges control_flags into state_json
        out_contact_meta: null,
        out_collected: null,
        out_missing_fields: null,
        out_recent_messages: null,
        out_need_admin: false,
        out_last_intent: null,
      }],
      error: null,
    }),
  });

  const result = await readRepo.loadRuntimeContext({ clinic_id: CLINIC_UUID, contact_id: CONTACT_UUID });
  assert.equal(result.ok, true);
  if (!result.ok) return;

  // STEP 3: verify RuntimeContext.channel_contact is populated from the same key
  assert.equal(result.data.channel_contact?.phone_number, "+380991234567", "read: phone_number from channel_contact");
  assert.equal(result.data.channel_contact?.phone_source, "telegram_contact_button", "read: phone_source from channel_contact");
  assert.equal(result.data.channel_contact?.phone_consent, true, "read: phone_consent from channel_contact");
  assert.equal(result.data.channel_contact?.phone_collected_at, "2026-06-29T10:00:00.000Z", "read: phone_collected_at from channel_contact");
});

// ── test 5b: persist failure sends fallback, not success message ──────────────

test("contact persist failure sends fallback message (not success acknowledgement)", async () => {
  const sendCalls: Array<{ chatId: string; text: string }> = [];
  const failingPersistence: TurnPersistenceRepository = {
    async getOrCreateContact() { return { ok: false, error: { code: "db_error", message: "fail", retryable: false } }; },
    async registerInboundEvent() { return { ok: true, data: { inbound_event_id: "e" } }; },
    async saveMessage() { return { ok: true, data: { message_id: "m" } }; },
    async mergeConversationState() { return { ok: true, data: { ok: true } }; },
  };

  let handler: ((request: unknown, reply: unknown) => Promise<void>) | undefined;
  registerTelegramWebhookRoute(
    { post(_path, h) { handler = h; } },
    {
      runtimeTurnService: stubService,
      clinicIdentityResolver: stubClinicResolver,
      turnPersistenceRepository: failingPersistence,
      botToken: "bot123",
      webhookSecret: undefined,
      defaultClinicCode: CLINIC,
      isProduction: false,
      fetch: async (_url, init) => {
        const body = JSON.parse(init?.body as string);
        sendCalls.push({ chatId: String(body.chat_id), text: body.text });
        return new Response("{}", { status: 200 });
      },
    },
  );

  const reply = { code(_: number) { return reply; }, send(_: unknown) {} };
  await (handler as Function)({ body: OWN_CONTACT_UPDATE, headers: {}, ip: "127.0.0.1" }, reply);
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(sendCalls.length, 1);
  const sentText = sendCalls[0]!.text;
  assert.ok(!sentText.includes("Спасибо, номер получен"), "failure must not send success acknowledgement");
  assert.ok(sentText.length > 0, "must send some fallback reply");
});

// ── test 6: booking.apply remains inactive ────────────────────────────────────

test("booking.apply remains inactive — not in ACTIVE_RUNTIME_AGENT_TOOLS", () => {
  assert.equal(
    (ACTIVE_RUNTIME_AGENT_TOOLS as readonly string[]).includes("booking.apply"),
    false,
    "booking.apply must not be activated in this PR",
  );
});

// ── test 7: ACTIVE_RUNTIME_AGENT_TOOLS still equals ["kb.search", "availability.check"]

test('ACTIVE_RUNTIME_AGENT_TOOLS equals ["kb.search", "availability.check"]', () => {
  assert.deepEqual(
    [...ACTIVE_RUNTIME_AGENT_TOOLS].sort(),
    ["availability.check", "kb.search"],
  );
});

// ── test 8: no ClinicCard createPatient/createVisit calls added ───────────────

test("no ClinicCard createPatient or createVisit calls in telegramWebhookRoute scope", async () => {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const routeSrc = await readFile(resolve(thisDir, "../src/runtime/telegramWebhookRoute.ts"), "utf8");
  const adapterSrc = await readFile(resolve(thisDir, "../src/runtime/telegramWebhookAdapter.ts"), "utf8");

  for (const src of [routeSrc, adapterSrc]) {
    assert.doesNotMatch(src, /createPatient/, "createPatient must not appear in Telegram scope");
    assert.doesNotMatch(src, /createVisit/, "createVisit must not appear in Telegram scope");
    assert.doesNotMatch(src, /clinicCardAdapter/, "ClinicCard adapter must not be imported in Telegram scope");
    assert.doesNotMatch(src, /booking\.apply/, "booking.apply must not be called from Telegram scope");
  }
});

// ── test 9: patient-facing confirmation text does not claim booked/confirmed ──

test("patient-facing contact confirmation text does not claim booked or confirmed", async () => {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const routeSrc = await readFile(resolve(thisDir, "../src/runtime/telegramWebhookRoute.ts"), "utf8");

  // Extract the success confirmation message sent on contact capture
  const confirmMatch = routeSrc.match(/Спасибо, номер получен[^"']*/);
  assert.ok(confirmMatch, "Confirmation message must be present in route");
  const confirmText = confirmMatch[0];

  const forbidden = ["записан", "подтвержд", "забронирован", "booked", "confirmed", "reserved"];
  for (const word of forbidden) {
    assert.ok(
      !confirmText.toLowerCase().includes(word),
      `Confirmation text must not claim "${word}" — only phone receipt should be acknowledged`,
    );
  }
});
