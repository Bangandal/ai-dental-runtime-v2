import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildRemoveKeyboardMarkup } from "../src/runtime/telegramSender.ts";
import { hasTrustedPhone } from "../src/runtime/bookingContactGuard.ts";

describe("telegramContactKeyboard", () => {
  describe("buildRemoveKeyboardMarkup", () => {
    it("D: returns { remove_keyboard: true }", () => {
      const markup = buildRemoveKeyboardMarkup();
      assert.strictEqual(markup.remove_keyboard, true);
      assert.strictEqual(markup.keyboard, undefined);
    });

    it("C: remove_keyboard is the only field set", () => {
      const markup = buildRemoveKeyboardMarkup();
      const keys = Object.keys(markup).filter((k) => (markup as Record<string, unknown>)[k] !== undefined);
      assert.deepStrictEqual(keys, ["remove_keyboard"]);
    });
  });

  describe("hasTrustedPhone — authoritative TRUSTED_PHONE_SOURCES check", () => {
    it("A: no channel_contact (undefined) — not trusted, request_contact must pass through", () => {
      assert.strictEqual(hasTrustedPhone(undefined), false);
    });

    it("B: telegram_contact_button is trusted — suppresses request_contact", () => {
      assert.strictEqual(hasTrustedPhone({ phone_number: "+380991234567", phone_source: "telegram_contact_button" }), true);
    });

    it("B2: whatsapp_sender is trusted — suppresses request_contact", () => {
      assert.strictEqual(hasTrustedPhone({ phone_number: "+380991234567", phone_source: "whatsapp_sender" }), true);
    });

    it("B3: existing_cliniccard_patient is trusted — suppresses request_contact", () => {
      assert.strictEqual(hasTrustedPhone({ phone_number: "+380991234567", phone_source: "existing_cliniccard_patient" }), true);
    });

    it("B4 (Codex P2 regression): manual_input is NOT trusted — request_contact must NOT be suppressed", () => {
      assert.strictEqual(hasTrustedPhone({ phone_number: "+380991234567", phone_source: "manual_input" }), false);
    });

    it("B5 (Codex P2 regression): unknown/future source is NOT trusted — request_contact must NOT be suppressed", () => {
      // Ensures negative comparison (!== 'manual_input') cannot accidentally suppress for unknown sources
      assert.strictEqual(hasTrustedPhone({ phone_number: "+380991234567", phone_source: "unknown_future_source" as never }), false);
    });
  });
});
