/**
 * PR #169 — typed phone support (patient texts a number instead of sharing contact button).
 *
 * Real incident: patient typed "728945521" to book for a third party; bot rejected
 * "нужен именно контакт в Telegram, а не номер текстом."
 *
 * Fix: extractTypedPhone detects phone-like digit sequences in inbound text.
 * The orchestrator injects it as channel_contact (phone_source="typed"),
 * which is now in TRUSTED_PHONE_SOURCES, so phone guards pass.
 *
 * Tests:
 * TP-1  extractTypedPhone: bare 9-digit number → extracted
 * TP-2  extractTypedPhone: number with country code → extracted
 * TP-3  extractTypedPhone: number in a sentence → extracted
 * TP-4  extractTypedPhone: number with spaces as separators → extracted
 * TP-5  extractTypedPhone: number with dashes → extracted
 * TP-6  extractTypedPhone: short number (8 digits) → null (not a phone)
 * TP-7  extractTypedPhone: date string "20.07.2026" → null (too few digits)
 * TP-8  extractTypedPhone: visit ID "58893937" (8 digits) → null
 * TP-9  TRUSTED_PHONE_SOURCES: "typed" is trusted
 * TP-10 TRUSTED_PHONE_SOURCES: "manual_input" is still NOT trusted
 */

import assert from "node:assert/strict";
import test from "node:test";

import { extractTypedPhone } from "../src/runtime/typedPhoneExtractor.ts";
import { TRUSTED_PHONE_SOURCES } from "../src/integrations/cliniccard/bookingApplyExecutor.ts";

// ── TP-1 ──────────────────────────────────────────────────────────────────────

test("TP-1: extractTypedPhone('728945521') → '728945521'", () => {
  assert.strictEqual(extractTypedPhone("728945521"), "728945521");
});

// ── TP-2 ──────────────────────────────────────────────────────────────────────

test("TP-2: extractTypedPhone('+420728945521') → '+420728945521'", () => {
  assert.strictEqual(extractTypedPhone("+420728945521"), "+420728945521");
});

// ── TP-3 ──────────────────────────────────────────────────────────────────────

test("TP-3: extractTypedPhone('Мой парень, телефон 728945521, консультация') → '728945521'", () => {
  assert.strictEqual(
    extractTypedPhone("Мой парень, телефон 728945521, консультация"),
    "728945521",
  );
});

// ── TP-4 ──────────────────────────────────────────────────────────────────────

test("TP-4: extractTypedPhone('728 945 521') → '728945521'", () => {
  assert.strictEqual(extractTypedPhone("728 945 521"), "728945521");
});

// ── TP-5 ──────────────────────────────────────────────────────────────────────

test("TP-5: extractTypedPhone('728-945-521') → '728945521'", () => {
  assert.strictEqual(extractTypedPhone("728-945-521"), "728945521");
});

// ── TP-6 ──────────────────────────────────────────────────────────────────────

test("TP-6: extractTypedPhone('12345678') → null (8 digits — too short)", () => {
  assert.strictEqual(extractTypedPhone("12345678"), null);
});

// ── TP-7 ──────────────────────────────────────────────────────────────────────

test("TP-7: extractTypedPhone('на 20.07.2026') → null (date, few digits per group)", () => {
  // "20.07.2026" stripped of dots → "20072026" → 8 digits → below 9 threshold
  assert.strictEqual(extractTypedPhone("на 20.07.2026"), null);
});

// ── TP-8 ──────────────────────────────────────────────────────────────────────

test("TP-8: extractTypedPhone('58893937') → null (8-digit visit ID)", () => {
  assert.strictEqual(extractTypedPhone("58893937"), null);
});

// ── TP-9 ──────────────────────────────────────────────────────────────────────

test("TP-9: TRUSTED_PHONE_SOURCES contains 'typed'", () => {
  assert.ok(
    TRUSTED_PHONE_SOURCES.has("typed"),
    "Expected 'typed' to be in TRUSTED_PHONE_SOURCES",
  );
});

// ── TP-10 ─────────────────────────────────────────────────────────────────────

test("TP-10: TRUSTED_PHONE_SOURCES does NOT contain 'manual_input'", () => {
  assert.ok(
    !TRUSTED_PHONE_SOURCES.has("manual_input"),
    "Expected 'manual_input' to remain excluded from TRUSTED_PHONE_SOURCES",
  );
});
