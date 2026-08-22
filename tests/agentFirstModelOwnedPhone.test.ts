import test from "node:test";
import assert from "node:assert/strict";

import {
  attachAgentFirstPhoneToExecutionSubject,
  bootstrapAgentFirstSelfSubjectForPhone,
  deriveAgentFirstProvidedPhone,
} from "../src/runtime/agentFirstProvidedPhone.ts";
import { extractTypedPhone } from "../src/runtime/typedPhoneExtractor.ts";
import { buildOpenAIToolDefinitions } from "../src/runtime/openaiRuntimeAgentCaller.ts";
import type { RuntimeAgentCallerInput } from "../src/runtime/runtimeAgentLoop.ts";
import type { RuntimeAgentToolRequest } from "../src/runtime/openaiRuntimeAgent.ts";
import type { BookingSubjectsState } from "../src/runtime/bookingSubjectsState.ts";

function withMode<T>(mode: "legacy" | "agent_first", fn: () => T): T {
  const previous = process.env.RUNTIME_AGENT_MODE;
  process.env.RUNTIME_AGENT_MODE = mode;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.RUNTIME_AGENT_MODE;
    else process.env.RUNTIME_AGENT_MODE = previous;
  }
}

function bookingApply(phone?: string): RuntimeAgentToolRequest {
  return {
    tool: "booking.apply",
    call_id: "book_1",
    arguments: {
      subject_id: "subject_1",
      first_name: "Ivan",
      last_name: "Petrov",
      service: "cleaning",
      requested_date: "2026-08-24",
      requested_time: "15:00",
      ...(phone !== undefined ? { phone_number: phone } : {}),
    },
  };
}

function callerInput(): RuntimeAgentCallerInput {
  return {
    model: "test-model",
    system_instruction: "test",
    conversation_id: null,
    input: {
      message: "test",
      context: {},
      tool_definitions: {
        "booking.select_slot": {
          description: "legacy selection",
          required_args: ["patient_target", "requested_date", "requested_time"],
          optional_args: [],
        },
        "booking.apply": {
          description: "book",
          required_args: [
            "patient_target",
            "first_name",
            "last_name",
            "service",
            "requested_date",
            "requested_time",
          ],
          optional_args: [],
        },
      },
    },
  };
}

function twoSubjectState(): BookingSubjectsState {
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
        label: "self",
        patient_name: "Ivan Petrov",
        service: "cleaning",
        slot: "2026-08-24T15:00",
        booking_contact: null,
        status: "collecting",
        missing: [],
      },
      {
        id: "subject_2",
        role: "mentioned_person",
        label: "daughter",
        patient_name: "Anna Petrova",
        service: "cleaning",
        slot: "2026-08-24T15:30",
        booking_contact: null,
        status: "collecting",
        missing: [],
      },
    ],
  };
}

test("agent-first accepts only an already-normalized model phone", () => {
  withMode("agent_first", () => {
    const now = new Date("2026-08-22T15:00:00.000Z");
    assert.equal(
      deriveAgentFirstProvidedPhone(bookingApply("+420777123456"), now)?.phone_number,
      "+420777123456",
    );
    assert.equal(
      deriveAgentFirstProvidedPhone(bookingApply("420777123456"), now)?.phone_number,
      "420777123456",
    );

    // Runtime must not become a second natural-language parser in agent-first mode.
    assert.equal(deriveAgentFirstProvidedPhone(bookingApply("+420 777 123 456"), now), null);
    assert.equal(deriveAgentFirstProvidedPhone(bookingApply("+420-777-123-456"), now), null);
    assert.equal(deriveAgentFirstProvidedPhone(bookingApply("call me at +420777123456"), now), null);
    assert.equal(deriveAgentFirstProvidedPhone(bookingApply("12345"), now), null);
  });
});

test("legacy does not accept the model-owned phone path", () => {
  withMode("legacy", () => {
    assert.equal(
      deriveAgentFirstProvidedPhone(
        bookingApply("+420777123456"),
        new Date("2026-08-22T15:00:00.000Z"),
      ),
      null,
    );
  });
});

test("free-text phone regex remains legacy-only", () => {
  withMode("legacy", () => {
    assert.equal(extractTypedPhone("мой номер +420 777 123 456"), "+420777123456");
  });
  withMode("agent_first", () => {
    assert.equal(extractTypedPhone("мой номер +420 777 123 456"), null);
  });
});

test("agent-first hides booking.select_slot and exposes optional phone_number on booking.apply", () => {
  withMode("agent_first", () => {
    const defs = buildOpenAIToolDefinitions(callerInput());
    const names = defs.map((def) => def.name);
    assert.equal(names.includes("booking_select_slot"), false);

    const booking = defs.find((def) => def.name === "booking_apply");
    assert.ok(booking);
    const parameters = booking.parameters as Record<string, unknown>;
    const properties = parameters.properties as Record<string, Record<string, unknown>>;
    assert.deepEqual(properties.phone_number, {
      type: "string",
      pattern: "^\\+?\\d{9,15}$",
      description: "Booking contact explicitly provided by the patient. Normalize it yourself to 9-15 digits with an optional leading +. Do not invent a number and omit this field when no booking contact is known.",
    });
  });
});

test("legacy keeps booking.select_slot and does not expose model-owned phone_number", () => {
  withMode("legacy", () => {
    const defs = buildOpenAIToolDefinitions(callerInput());
    const names = defs.map((def) => def.name);
    assert.equal(names.includes("booking_select_slot"), true);

    const booking = defs.find((def) => def.name === "booking_apply");
    assert.ok(booking);
    const parameters = booking.parameters as Record<string, unknown>;
    const properties = parameters.properties as Record<string, Record<string, unknown>>;
    assert.equal(Object.hasOwn(properties, "phone_number"), false);
  });
});

test("agent-first self booking persists model phone as typed/unverified subject contact", () => {
  withMode("agent_first", () => {
    const phone = deriveAgentFirstProvidedPhone(
      bookingApply("+420777123456"),
      new Date("2026-08-22T15:00:00.000Z"),
    );
    const state = bootstrapAgentFirstSelfSubjectForPhone({
      booking_apply: bookingApply("+420777123456"),
      existing_state: null,
      phone,
    });

    assert.ok(state);
    assert.equal(state.active_subject_id, "subject_1");
    assert.deepEqual(state.subjects[0].booking_contact, {
      phone_number: "+420777123456",
      source: "typed",
      trust: "unverified",
      owner_subject_id: "subject_1",
      collected_at: "2026-08-22T15:00:00.000Z",
    });
  });
});

test("model phone attaches only to the already-frozen execution subject", () => {
  withMode("agent_first", () => {
    const phone = deriveAgentFirstProvidedPhone(
      bookingApply("+420777123456"),
      new Date("2026-08-22T15:00:00.000Z"),
    );
    const state = attachAgentFirstPhoneToExecutionSubject({
      state: twoSubjectState(),
      execution_subject_id: "subject_2",
      phone,
    });

    assert.ok(state);
    assert.equal(state.subjects[0].booking_contact, null);
    assert.deepEqual(state.subjects[1].booking_contact, {
      phone_number: "+420777123456",
      source: "typed",
      trust: "unverified",
      owner_subject_id: "subject_2",
      collected_at: "2026-08-22T15:00:00.000Z",
    });
  });
});

test("different unresolved pending phone is never silently reassigned", () => {
  withMode("agent_first", () => {
    const initial = twoSubjectState();
    initial.pending_typed_phone = "+420111111111";
    const phone = deriveAgentFirstProvidedPhone(
      bookingApply("+420777123456"),
      new Date("2026-08-22T15:00:00.000Z"),
    );
    const state = attachAgentFirstPhoneToExecutionSubject({
      state: initial,
      execution_subject_id: "subject_2",
      phone,
    });

    assert.ok(state);
    assert.equal(state.pending_typed_phone, "+420111111111");
    assert.equal(state.subjects[1].booking_contact, null);
  });
});
