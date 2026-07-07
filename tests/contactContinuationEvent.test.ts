/**
 * PR #165: Contact continuation event regression tests.
 *
 * Live regression: after patient shared Telegram contact button, the next turn
 * said "для записи не хватило подтверждённого номера телефона" — phone guard
 * fired even though trusted phone was present in convo_state.
 *
 * Root cause: contact event bypassed runtime → OpenAI thread not updated →
 * model replied from stale thread ("waiting for phone").
 *
 * Fix: after persistChannelContactPhone, runRuntimeTurnOrchestrated("[contact_shared]")
 * updates the OpenAI thread so the model has fresh context.
 *
 * Tests:
 * CCE-2  Integration: [contact_shared] + trusted phone → phone guard does NOT fire.
 *         Next guard is slot_not_verified (not missing_trusted_phone).
 * CCE-3  Integration: "Вы меня записали?" + trusted phone → phone guard does NOT fire.
 *         Reply must not contain phone-missing language.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createRuntimeAgentLoop } from "../src/runtime/runtimeAgentLoop.ts";
import type {
  RuntimeAgentCaller,
  RuntimeAgentCallerOutput,
} from "../src/runtime/runtimeAgentLoop.ts";
import type { ToolExecutorRegistry } from "../src/runtime/toolExecutor.ts";

const NOW = new Date("2026-07-07T13:00:00.000Z"); // 15:00 Europe/Prague
const TZ = "Europe/Prague";
const TOMORROW = "2026-07-08";

const TRUSTED_CONTACT = {
  phone_number: "+380991234567",
  phone_source: "telegram_contact_button" as const,
  phone_consent: true as const,
};

// ── CCE-2 ─────────────────────────────────────────────────────────────────────

describe("CCE-2: [contact_shared] + trusted phone — phone guard does NOT fire", () => {
  test("booking.apply after contact share: slot_not_verified (not missing_trusted_phone)", async () => {
    let callCount = 0;

    const caller: RuntimeAgentCaller = async () => {
      callCount++;
      if (callCount === 1) {
        // Model proceeds to booking.apply after receiving phone — no name yet, no slot proof
        return {
          type: "tool_requests",
          tool_requests: [{
            tool: "booking.apply",
            call_id: "cce2-c1",
            arguments: {
              requested_date: TOMORROW,
              requested_time: "12:00",
              service: "Консультация",
              // first_name and last_name deliberately absent
            },
          }],
        } as RuntimeAgentCallerOutput;
      }
      // Second call: model receives guarded result, asks to verify slot first
      return {
        type: "final_response",
        final_response: { final_patient_reply: "Сначала проверю доступное время на завтра в 12:00." },
      } as RuntimeAgentCallerOutput;
    };

    const loop = createRuntimeAgentLoop({
      model: "test",
      caller,
      executors: {} as ToolExecutorRegistry,
      now: NOW,
      timezone: TZ,
    });

    const result = await loop.runTurn({
      user_message: "[contact_shared]",
      clinic_id: "clinic_1",
      contact_id: "cce2-contact",
      locale: "ru",
      channel_contact: TRUSTED_CONTACT,
    });

    const debug = result.debug as Record<string, unknown>;

    // Phone guard must NOT fire
    assert.notStrictEqual(
      debug.reason,
      "booking_apply_preflight_missing_trusted_phone_round1",
      "phone guard must NOT fire when trusted phone is present",
    );

    // Flow must have reached the name guard (Guard E — comes after phone guard, before slot proof)
    // name guard fires because trusted phone is present but first_name/last_name are absent
    assert.strictEqual(
      debug.reason,
      "booking_apply_preflight_missing_name_round1",
      "name guard must fire — phone guard was passed, flow progressed to next guard",
    );

    // booking result must carry missing_patient_name (not missing_trusted_phone)
    const bookingResult = result.tool_results.find((r) => r.tool === "booking.apply");
    assert.ok(bookingResult, "guarded booking.apply result must be present");
    const data = bookingResult!.data as Record<string, unknown>;
    assert.strictEqual(data.booking_status, "missing_patient_name");
    assert.strictEqual(data.created_visit, false);
    assert.strictEqual(data.may_claim_booked, false);

    // Final reply must not contain phone-request language
    const reply = result.final_patient_reply.toLowerCase();
    const phoneMissingTerms = ["нажмите кнопку", "поделитесь контактом", "не хватило", "номер телефона", "contact button"];
    for (const term of phoneMissingTerms) {
      assert.ok(
        !reply.includes(term),
        `reply must not contain phone-missing language "${term}" — got: ${result.final_patient_reply}`,
      );
    }
  });
});

// ── CCE-3 ─────────────────────────────────────────────────────────────────────

describe("CCE-3: 'Вы меня записали?' + trusted phone — phone guard does NOT fire, reply does not claim phone missing", () => {
  test("query about booking status with trusted phone: slot_not_verified, no phone-missing reply", async () => {
    let callCount = 0;

    const caller: RuntimeAgentCaller = async () => {
      callCount++;
      if (callCount === 1) {
        // Model tries to check booking status via booking.apply
        return {
          type: "tool_requests",
          tool_requests: [{
            tool: "booking.apply",
            call_id: "cce3-c1",
            arguments: {
              requested_date: TOMORROW,
              requested_time: "12:00",
              service: "Консультация",
            },
          }],
        } as RuntimeAgentCallerOutput;
      }
      // Model replies honestly: not booked yet, needs name/slot verification
      return {
        type: "final_response",
        final_response: { final_patient_reply: "Запись ещё не создана — нужно сначала проверить слоты и уточнить ваше имя." },
      } as RuntimeAgentCallerOutput;
    };

    const loop = createRuntimeAgentLoop({
      model: "test",
      caller,
      executors: {} as ToolExecutorRegistry,
      now: NOW,
      timezone: TZ,
    });

    const result = await loop.runTurn({
      user_message: "Вы меня записали?",
      clinic_id: "clinic_1",
      contact_id: "cce3-contact",
      locale: "ru",
      channel_contact: TRUSTED_CONTACT,
    });

    const debug = result.debug as Record<string, unknown>;

    // Phone guard must NOT fire
    assert.notStrictEqual(
      debug.reason,
      "booking_apply_preflight_missing_trusted_phone_round1",
      "phone guard must NOT fire when trusted phone is present",
    );
    assert.notStrictEqual(
      debug.reason,
      "booking_apply_intercepted_missing_trusted_phone",
      "phone guard intercept must NOT fire when trusted phone is present",
    );

    // booking result must NOT carry missing_trusted_phone
    const bookingResult = result.tool_results.find((r) => r.tool === "booking.apply");
    if (bookingResult) {
      const data = bookingResult.data as Record<string, unknown>;
      assert.notStrictEqual(
        data.booking_status,
        "missing_trusted_phone",
        "booking_status must not be missing_trusted_phone",
      );
    }

    // Final reply must not contain the regression phrase
    const reply = result.final_patient_reply;
    const regressionPhrases = [
      "не хватило подтверждённого номера",
      "поделитесь контактом",
      "нажмите кнопку",
      "отправьте контакт",
    ];
    for (const phrase of regressionPhrases) {
      assert.ok(
        !reply.toLowerCase().includes(phrase.toLowerCase()),
        `reply must not contain regression phrase "${phrase}" — got: ${reply}`,
      );
    }

    // Reply must acknowledge booking not created
    const lowerReply = reply.toLowerCase();
    const notBookedTerms = ["не создан", "ещё не", "пока нет", "не записан", "not booked", "not created"];
    const hasNotBookedAck = notBookedTerms.some((t) => lowerReply.includes(t));
    assert.ok(
      hasNotBookedAck,
      `reply must acknowledge booking not yet created — got: ${reply}`,
    );
  });
});
