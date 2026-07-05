import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildRemoveKeyboardMarkup } from "../src/runtime/telegramSender.ts";

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

  describe("trusted phone suppresses request_contact (orchestrator logic snapshot)", () => {
    // Test the suppression logic directly by replicating it
    function applyContactSuppression(
      rawMergedUi: { telegram?: { request_contact?: boolean; button_text?: string } } | undefined,
      channelContact: { phone_source: string } | undefined,
    ) {
      const hasTrustedPhone =
        channelContact !== undefined &&
        channelContact !== null &&
        channelContact.phone_source !== "manual_input";
      return hasTrustedPhone && rawMergedUi?.telegram?.request_contact === true
        ? { ...rawMergedUi, telegram: { ...rawMergedUi.telegram, request_contact: false } }
        : rawMergedUi;
    }

    it("A: no trusted phone — request_contact passes through unchanged", () => {
      const ui = { telegram: { request_contact: true, button_text: "Share" } };
      const result = applyContactSuppression(ui, undefined);
      assert.strictEqual(result?.telegram?.request_contact, true);
    });

    it("B: trusted phone (telegram_contact_button) suppresses request_contact", () => {
      const ui = { telegram: { request_contact: true, button_text: "Share" } };
      const result = applyContactSuppression(ui, { phone_source: "telegram_contact_button" });
      assert.strictEqual(result?.telegram?.request_contact, false);
    });

    it("B2: trusted phone (whatsapp_sender) suppresses request_contact", () => {
      const ui = { telegram: { request_contact: true, button_text: "Share" } };
      const result = applyContactSuppression(ui, { phone_source: "whatsapp_sender" });
      assert.strictEqual(result?.telegram?.request_contact, false);
    });

    it("B3: manual_input is NOT trusted — request_contact passes through", () => {
      const ui = { telegram: { request_contact: true, button_text: "Share" } };
      const result = applyContactSuppression(ui, { phone_source: "manual_input" });
      assert.strictEqual(result?.telegram?.request_contact, true);
    });

    it("no UI at all — suppression returns undefined (no change)", () => {
      const result = applyContactSuppression(undefined, { phone_source: "telegram_contact_button" });
      assert.strictEqual(result, undefined);
    });
  });
});
