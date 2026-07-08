import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { TRUSTED_PHONE_SOURCES } from "../src/integrations/cliniccard/bookingApplyExecutor.ts";
import { hasTrustedPhone, hasBookingContactPhone } from "../src/runtime/bookingContactGuard.ts";
import { extractTypedPhone } from "../src/runtime/typedPhoneExtractor.ts";
import { applyMessengerPhonePolicy } from "../src/runtime/runtimeTurnOrchestrator.ts";
import type { ProvidedPhone } from "../src/runtime/openaiRuntimeAgent.ts";
import type { ChannelContact } from "../src/runtime/openaiRuntimeAgent.ts";

// A. typed is NOT in TRUSTED_PHONE_SOURCES
describe("typed phone — trust boundary", () => {
  it("A: 'typed' is not in TRUSTED_PHONE_SOURCES", () => {
    assert.equal(TRUSTED_PHONE_SOURCES.has("typed"), false);
  });

  it("B: hasTrustedPhone returns false for a typed ChannelContact", () => {
    const typed: ChannelContact = {
      phone_number: "+420724334616",
      phone_source: "typed",
      phone_captured: true,
    };
    assert.equal(hasTrustedPhone(typed), false);
  });

  it("C: hasTrustedPhone returns true for telegram_contact_button", () => {
    const trusted: ChannelContact = {
      phone_number: "+420724334616",
      phone_source: "telegram_contact_button",
      phone_captured: true,
    };
    assert.equal(hasTrustedPhone(trusted), true);
  });
});

// B. extractTypedPhone extracts phone numbers from free-form text
describe("extractTypedPhone", () => {
  it("D: extracts Czech number without +", () => {
    assert.equal(extractTypedPhone("мой номер 724334616"), "724334616");
  });

  it("E: extracts international number with +", () => {
    assert.equal(extractTypedPhone("запишите +420724334616"), "+420724334616");
  });

  it("F: extracts number with spaces", () => {
    const result = extractTypedPhone("номер 420 724 334 616");
    assert.notEqual(result, null);
    assert.ok(result?.replace(/\D/g, "").length >= 9);
  });

  it("G: returns null for text without a phone number", () => {
    assert.equal(extractTypedPhone("запишите меня на завтра в 15:00"), null);
  });

  it("H: returns null for short digit sequences (not a phone)", () => {
    assert.equal(extractTypedPhone("На 15 00"), null);
  });

  it("I: returns null for empty string", () => {
    assert.equal(extractTypedPhone(""), null);
  });
});

// C. ProvidedPhone has correct shape
describe("ProvidedPhone structure", () => {
  it("J: ProvidedPhone is phone_source=typed, phone_trust=unverified, phone_consent=false", () => {
    const p: ProvidedPhone = {
      phone_number: "+420724334616",
      phone_source: "typed",
      phone_trust: "unverified",
      phone_consent: false,
      phone_collected_at: new Date().toISOString(),
    };
    assert.equal(p.phone_source, "typed");
    assert.equal(p.phone_trust, "unverified");
    assert.equal(p.phone_consent, false);
  });
});

// D. hasBookingContactPhone — accepts trusted OR provided
describe("hasBookingContactPhone", () => {
  const trustedContact: ChannelContact = {
    phone_number: "+420724334616",
    phone_source: "telegram_contact_button",
    phone_captured: true,
  };
  const providedPhone: ProvidedPhone = {
    phone_number: "+420724334616",
    phone_source: "typed",
    phone_trust: "unverified",
    phone_consent: false,
    phone_collected_at: new Date().toISOString(),
  };

  it("K: true when trusted contact present (no providedPhone)", () => {
    assert.equal(hasBookingContactPhone({ channelContact: trustedContact }), true);
  });

  it("L: true when only providedPhone present (no trusted contact)", () => {
    assert.equal(hasBookingContactPhone({ channelContact: null, providedPhone }), true);
  });

  it("M: false when neither trusted contact nor providedPhone", () => {
    assert.equal(hasBookingContactPhone({ channelContact: null }), false);
  });

  it("N: false when channelContact has untrusted source and no providedPhone", () => {
    const untrusted: ChannelContact = {
      phone_number: "+420724334616",
      phone_source: "manual_input",
      phone_captured: true,
    };
    assert.equal(hasBookingContactPhone({ channelContact: untrusted }), false);
  });

  it("O: true when both trusted contact and providedPhone present", () => {
    assert.equal(hasBookingContactPhone({ channelContact: trustedContact, providedPhone }), true);
  });
});

// E. applyMessengerPhonePolicy — provided_phone takes priority over trusted channel_contact
describe("applyMessengerPhonePolicy — phone context priority", () => {
  const trustedContact: ChannelContact = {
    phone_number: "+420724334616",
    phone_source: "telegram_contact_button",
    phone_captured: true,
  };
  const providedPhone: ProvidedPhone = {
    phone_number: "+420728945521",
    phone_source: "typed",
    phone_trust: "unverified",
    phone_consent: false,
    phone_collected_at: new Date().toISOString(),
  };
  const baseCtx = { task_state: { missing_fields: ["phone"] }, runtime_policy: { phone_required: true } };

  it("P: trusted contact only → phone_captured=true in task_state", () => {
    const result = applyMessengerPhonePolicy(baseCtx, trustedContact, null);
    const ts = result.task_state as Record<string, unknown>;
    assert.equal(ts.phone_captured, true);
    assert.equal(ts.phone_source, "telegram_contact_button");
    assert.equal(ts.phone_received, undefined);
  });

  it("Q: provided_phone only → phone_received=true, phone_source=typed, phone_trust=unverified", () => {
    const result = applyMessengerPhonePolicy(baseCtx, null, providedPhone);
    const ts = result.task_state as Record<string, unknown>;
    assert.equal(ts.phone_received, true);
    assert.equal(ts.phone_source, "typed");
    assert.equal(ts.phone_trust, "unverified");
    assert.equal(ts.phone_captured, undefined);
  });

  it("R: trusted contact + provided_phone → provided_phone wins (phone_received, not phone_captured)", () => {
    const result = applyMessengerPhonePolicy(baseCtx, trustedContact, providedPhone);
    const ts = result.task_state as Record<string, unknown>;
    assert.equal(ts.phone_received, true);
    assert.equal(ts.phone_source, "typed");
    assert.equal(ts.phone_trust, "unverified");
    assert.equal(ts.phone_captured, undefined, "phone_captured must NOT appear when provided_phone is active booking phone");
  });

  it("S: neither → no phone patch, phone removed from missing_fields", () => {
    const result = applyMessengerPhonePolicy(baseCtx, null, null);
    const ts = result.task_state as Record<string, unknown>;
    assert.equal(ts.phone_captured, undefined);
    assert.equal(ts.phone_received, undefined);
    assert.deepEqual(ts.missing_fields, []);
  });
});
