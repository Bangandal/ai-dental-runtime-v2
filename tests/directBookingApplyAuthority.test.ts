import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRuntimeAgentSystemInstruction,
  RUNTIME_AGENT_TOOL_DEFINITIONS,
  type RuntimeAgentToolRequest,
} from "../src/runtime/openaiRuntimeAgent.ts";
import { buildOpenAIToolDefinitions } from "../src/runtime/openaiRuntimeAgentCaller.ts";
import {
  shouldInterceptInvalidSlotDateTime,
  shouldInterceptMissingSlotProof,
} from "../src/runtime/bookingApplyPreflight.ts";

function bookingApplyRequest(): RuntimeAgentToolRequest {
  return {
    tool: "booking.apply",
    call_id: "call_book",
    arguments: {
      subject_id: "subject_1",
      first_name: "Ivan",
      last_name: "Petrov",
      service: "Cleaning",
      requested_date: "2026-08-24",
      requested_time: "14:00",
    },
  };
}

test("PF-004: booking.select_slot is not exposed to the model", () => {
  const tools = buildOpenAIToolDefinitions({
    model: "gpt-test",
    conversation_id: null,
    system_instruction: "system",
    input: {
      message: "book me",
      context: { clinic_id: "clinic_1" },
      tool_definitions: RUNTIME_AGENT_TOOL_DEFINITIONS,
    },
  });

  const names = tools.map((tool) => tool.name);
  assert.equal(names.includes("booking_select_slot"), false);
  assert.equal(names.includes("booking_apply"), true);
});

test("PF-002/PF-003/PF-004: legacy slot evidence is not booking write authority", () => {
  const pendingToolRequests = [bookingApplyRequest()];

  assert.equal(
    shouldInterceptMissingSlotProof({
      pendingToolRequests,
      activeAvailabilityEvidence: null,
      selectedSlot: null,
      selectedSlotProof: null,
    }),
    false,
  );

  assert.equal(
    shouldInterceptInvalidSlotDateTime({
      pendingToolRequests,
      activeAvailabilityEvidence: {
        source: "availability.check",
        allowed_slot_keys: ["2026-08-24T13:00"],
      } as any,
      selectedSlot: null,
      selectedSlotProof: null,
    }),
    false,
  );
});

test("PF-004: prompt routes exact booking requests directly to booking.apply", () => {
  const prompt = buildRuntimeAgentSystemInstruction({
    now: new Date("2026-08-21T12:00:00Z"),
    timezone: "Europe/Prague",
  });

  assert.equal(prompt.includes("booking.select_slot is mandatory"), false);
  assert.equal(prompt.includes("booking.select_slot returns selection_status='selected'"), false);
  assert.match(prompt, /explicitly asks to book an exact date\/time[\s\S]*booking\.apply may be called directly/i);
  assert.match(prompt, /booking\.apply revalidates the requested slot against current clinic policy and fresh ClinicCard conflicts/i);
});
