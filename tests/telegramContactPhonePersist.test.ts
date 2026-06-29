import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeTelegramUpdate, type TelegramUpdate } from "../src/runtime/telegramWebhookAdapter.ts";
import { registerTelegramWebhookRoute, persistChannelContactPhone } from "../src/runtime/telegramWebhookRoute.ts";
import { createSupabaseRuntimeContextRepository } from "../src/runtime/supabaseRuntimeContextRepository.ts";
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

// ── test 5: SQL contract — RPC explicitly handles channel_contact ─────────────
// Proves that core.rpc_merge_conversation_state.sql has explicit channel_contact support,
// so p_control_flags->'channel_contact' is persisted into state_json.channel_contact
// by the real database function (same style as topic_memory).

test("SQL contract: core.rpc_merge_conversation_state.sql explicitly handles channel_contact", async () => {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const sqlPath = resolve(thisDir, "../sql/rpc/core.rpc_merge_conversation_state.sql");
  const sql = await readFile(sqlPath, "utf8");

  assert.ok(
    sql.includes("channel_contact"),
    "SQL must reference channel_contact",
  );
  assert.ok(
    sql.includes("v_control_flags->'channel_contact'"),
    "SQL must read channel_contact from v_control_flags",
  );
  assert.ok(
    sql.includes("'{channel_contact}'"),
    "SQL must write channel_contact into state via jsonb_set",
  );
  assert.ok(
    sql.includes("jsonb_typeof(v_control_flags->'channel_contact') = 'object'"),
    "SQL must guard channel_contact write with jsonb_typeof = object check",
  );
});

// ── test 5b: RuntimeContext.channel_contact is read from out_state_json ───────

test("RuntimeContext.channel_contact is read from out_state_json.channel_contact", async () => {
  const repo = createSupabaseRuntimeContextRepository({
    rpc: async () => ({
      data: [{
        out_state_version: 5,
        out_state_json: {
          channel_contact: {
            phone_number: "+380991234567",
            phone_source: "telegram_contact_button",
            phone_consent: true,
            phone_collected_at: "2026-06-29T10:00:00.000Z",
          },
        },
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

  const result = await repo.loadRuntimeContext({ clinic_id: CLINIC_UUID, contact_id: CONTACT_UUID });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.channel_contact?.phone_number, "+380991234567");
  assert.equal(result.data.channel_contact?.phone_source, "telegram_contact_button");
  assert.equal(result.data.channel_contact?.phone_consent, true);
  assert.equal(result.data.channel_contact?.phone_collected_at, "2026-06-29T10:00:00.000Z");
});

// ── test 5c: persist failure sends fallback, not success message ──────────────

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

// ── test 7: ACTIVE_RUNTIME_AGENT_TOOLS invariant ─────────────────────────────

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
