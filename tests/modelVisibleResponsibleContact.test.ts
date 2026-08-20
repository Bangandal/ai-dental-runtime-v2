import assert from "node:assert/strict";
import test from "node:test";

import { buildModelVisibleCallerContext } from "../src/runtime/modelVisibleCallerContext.ts";
import type { RuntimeAgentTurnInput } from "../src/runtime/openaiRuntimeAgent.ts";
import type { BookingSubjectsState } from "../src/runtime/bookingSubjectsState.ts";

function makeState(opts?: { senderTrusted?: boolean; targetOwnPhone?: boolean }): BookingSubjectsState {
  const senderTrusted = opts?.senderTrusted ?? true;
  const targetOwnPhone = opts?.targetOwnPhone ?? false;
  return {
    version: 3,
    status: "active",
    active_subject_id: "subject_2",
    max_subjects: 4,
    pending_typed_phone: null,
    subjects: [
      {
        id: "subject_1",
        role: "sender",
        label: "я",
        patient_name: "Olena Koval",
        service: null,
        slot: null,
        booking_contact: {
          phone_number: "+420111222333",
          source: senderTrusted ? "telegram_contact_button" : "typed",
          trust: senderTrusted ? "trusted" : "unverified",
          owner_subject_id: "subject_1",
          collected_at: "2026-08-20T15:00:00Z",
        },
        status: "collecting",
        missing: ["slot", "service"],
      },
      {
        id: "subject_2",
        role: "mentioned_person",
        label: "дочь",
        patient_name: "Anna Koval",
        service: "consultation",
        slot: "2026-08-21T10:00",
        booking_contact: targetOwnPhone
          ? {
              phone_number: "+420999888777",
              source: "telegram_contact_button",
              trust: "trusted",
              owner_subject_id: "subject_2",
              collected_at: "2026-08-20T15:05:00Z",
            }
          : null,
        status: "collecting",
        missing: targetOwnPhone ? [] : ["booking_contact"],
      },
    ],
  };
}

function makeInput(state: BookingSubjectsState): RuntimeAgentTurnInput {
  return {
    clinic_id: "clinic_1",
    user_message: "[contact_shared]",
    booking_subjects: state,
    business_context: {
      channel: "telegram",
      runtime_context: {
        runtime_policy: { patient_reachable_in_current_channel: true },
        // Deliberately stale/raw projection from the orchestrator. The caller-context builder
        // must overwrite this with the effective responsible-party projection.
        booking_subjects: { stale: true },
      },
    },
  };
}

function getTargetProjection(input: RuntimeAgentTurnInput): Record<string, unknown> {
  const context = buildModelVisibleCallerContext(input);
  const runtimeContext = context.runtime_context as Record<string, unknown>;
  const bookingSubjects = runtimeContext.booking_subjects as Record<string, unknown>;
  const subjects = bookingSubjects.subjects as Array<Record<string, unknown>>;
  return subjects.find((subject) => subject.id === "subject_2")!;
}

test("RESP-CONTACT-1: trusted sender phone is exposed as responsible-party contact for active subject_2", () => {
  const context = buildModelVisibleCallerContext(makeInput(makeState()));
  const runtimeContext = context.runtime_context as Record<string, unknown>;
  const bookingSubjects = runtimeContext.booking_subjects as Record<string, unknown>;
  const subjects = bookingSubjects.subjects as Array<Record<string, unknown>>;
  const target = subjects.find((subject) => subject.id === "subject_2")!;

  assert.equal(target.phone_status, "trusted_contact_owner");
  assert.equal(target.contact_owner, "subject_1");
  assert.deepEqual(target.missing, []);
  assert.equal(JSON.stringify(context).includes("+420111222333"), false, "phone number must not leak to model-visible context");
});

test("RESP-CONTACT-2: unverified typed sender phone is not promoted to responsible-party contact", () => {
  const target = getTargetProjection(makeInput(makeState({ senderTrusted: false })));
  assert.equal(target.phone_status, null);
  assert.equal(target.contact_owner, null);
  assert.deepEqual(target.missing, ["booking_contact"]);
});

test("RESP-CONTACT-3: target's own contact remains authoritative and is not replaced", () => {
  const target = getTargetProjection(makeInput(makeState({ targetOwnPhone: true })));
  assert.equal(target.phone_status, "trusted");
  assert.equal(target.contact_owner, "self");
  assert.deepEqual(target.missing, []);
});
