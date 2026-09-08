import test from "node:test";
import assert from "node:assert/strict";

import {
  AGENT_FIRST_UNDATED_AVAILABILITY_OFFSET_DAYS,
  applyAgentFirstUndatedAvailabilityDefault,
} from "../src/runtime/agentFirstAvailabilityDefaults.ts";
import { buildAgentFirstSystemInstruction } from "../src/runtime/agentFirstSystemInstruction.ts";
import {
  RUNTIME_AGENT_TOOL_DEFINITIONS,
  type RuntimeAgentToolRequest,
} from "../src/runtime/openaiRuntimeAgent.ts";
import { buildOpenAIToolDefinitions } from "../src/runtime/openaiRuntimeAgentCaller.ts";
import { computeBookingProcessState } from "../src/runtime/bookingProcessState.ts";
import { executeRuntimeTurnToolBatch } from "../src/runtime/runtimeTurnToolBatch.ts";
import type { RuntimeAgentCallerInput } from "../src/runtime/runtimeModelCall.ts";
import type { ToolExecutionContext } from "../src/runtime/toolExecutor.ts";

function restoreRuntimeMode(previous: string | undefined): void {
  if (previous === undefined) delete process.env.RUNTIME_AGENT_MODE;
  else process.env.RUNTIME_AGENT_MODE = previous;
}

function withRuntimeMode<T>(mode: "agent_first" | "legacy", fn: () => T): T {
  const previous = process.env.RUNTIME_AGENT_MODE;
  process.env.RUNTIME_AGENT_MODE = mode;
  try {
    return fn();
  } finally {
    restoreRuntimeMode(previous);
  }
}

async function withRuntimeModeAsync<T>(
  mode: "agent_first" | "legacy",
  fn: () => Promise<T>,
): Promise<T> {
  const previous = process.env.RUNTIME_AGENT_MODE;
  process.env.RUNTIME_AGENT_MODE = mode;
  try {
    return await fn();
  } finally {
    restoreRuntimeMode(previous);
  }
}

function availabilityRequest(arguments_: Record<string, unknown> = {}): RuntimeAgentToolRequest {
  return {
    tool: "availability.check",
    call_id: "avail_1",
    arguments: arguments_,
  };
}

function callerInput(): RuntimeAgentCallerInput {
  return {
    model: "test-model",
    conversation_id: null,
    system_instruction: "test",
    input: {
      message: "test",
      context: {},
      tool_definitions: RUNTIME_AGENT_TOOL_DEFINITIONS,
    },
  };
}

test("agent-first undated availability defaults to today + 2 clinic-calendar days", () => {
  withRuntimeMode("agent_first", () => {
    assert.equal(AGENT_FIRST_UNDATED_AVAILABILITY_OFFSET_DAYS, 2);
    const requests = [availabilityRequest({ service_interest: "cleaning" })];
    const normalized = applyAgentFirstUndatedAvailabilityDefault({
      requests,
      now: new Date("2026-08-23T12:00:00.000Z"),
      timezone: "Europe/Prague",
    });

    assert.equal(normalized[0]?.arguments.requested_date, "2026-08-25");
    assert.equal(requests[0]?.arguments.requested_date, undefined, "normalization must not mutate model output");
  });
});

test("agent-first explicit patient date always wins over Day+2 default", () => {
  withRuntimeMode("agent_first", () => {
    const request = availabilityRequest({ requested_date: "2026-08-24" });
    const requests = [request];
    const normalized = applyAgentFirstUndatedAvailabilityDefault({
      requests,
      now: new Date("2026-08-23T12:00:00.000Z"),
      timezone: "Europe/Prague",
    });

    assert.equal(normalized, requests);
    assert.equal(normalized[0]?.arguments.requested_date, "2026-08-24");
  });
});

test("legacy mode keeps requested_date required and does not inject Day+2", () => {
  withRuntimeMode("legacy", () => {
    const requests = [availabilityRequest()];
    const normalized = applyAgentFirstUndatedAvailabilityDefault({
      requests,
      now: new Date("2026-08-23T12:00:00.000Z"),
      timezone: "Europe/Prague",
    });
    assert.equal(normalized, requests);
    assert.equal(normalized[0]?.arguments.requested_date, undefined);

    const availability = buildOpenAIToolDefinitions(callerInput()).find(
      (tool) => tool.name === "availability_check",
    ) as { parameters?: { required?: string[] } } | undefined;
    assert.ok(availability);
    assert.deepEqual(availability.parameters?.required, ["requested_date"]);
  });
});

test("agent-first availability tool lets model omit date and documents Runtime default", () => {
  withRuntimeMode("agent_first", () => {
    const availability = buildOpenAIToolDefinitions(callerInput()).find(
      (tool) => tool.name === "availability_check",
    ) as {
      description?: string;
      parameters?: { required?: string[]; properties?: Record<string, unknown> };
    } | undefined;

    assert.ok(availability);
    assert.deepEqual(availability.parameters?.required, []);
    assert.ok(availability.parameters?.properties?.requested_date);
    assert.match(availability.description ?? "", /Runtime applies the clinic Day\+2 default/i);
  });
});

test("Prompt 2.0 tells the model to omit an undated date and preserves explicit patient dates", () => {
  const instruction = buildAgentFirstSystemInstruction(
    "Today is 2026-08-23 (timezone: Europe/Prague). Final patient reply must be in the patient's language.",
  );

  assert.match(instruction, /without a patient-specified date, omit requested_date/i);
  assert.match(instruction, /Runtime applies the clinic Day\+2 default/i);
  assert.match(instruction, /Pass a date only when the patient links it to a desired appointment/i);
  assert.match(instruction, /Resolve relative dates against Runtime's clock/i);
});

test("Runtime normalizes Day+2 before availability execution and evidence creation", async () => {
  await withRuntimeModeAsync("agent_first", async () => {
    let seenContext: ToolExecutionContext | null = null;
    const now = new Date("2026-08-23T12:00:00.000Z");
    const initialState = computeBookingProcessState({ now });

    const result = await executeRuntimeTurnToolBatch({
      requests: [availabilityRequest({ service_interest: "cleaning" })],
      input: {
        clinic_id: "clinic_1",
        user_message: "Когда можно записаться?",
      },
      executors: {
        "availability.check": async (context) => {
          seenContext = context;
          return {
            tool: "availability.check",
            status: "success",
            data: {
              slots: [
                {
                  slot_id: "2026-08-25T10:00",
                  starts_at: "2026-08-25T10:00:00",
                  ends_at: "2026-08-25T10:30:00",
                },
              ],
              timezone: "Europe/Prague",
              total_slots: 1,
              free_slots_count: 1,
            },
          };
        },
      },
      booking_process_state: initialState,
      booking_subjects: null,
      now,
      timezone: "Europe/Prague",
    });

    assert.equal(seenContext?.requested_date, "2026-08-25");
    assert.equal(result.booking_process_state.active_availability_evidence?.requested_date, "2026-08-25");
    assert.deepEqual(
      result.booking_process_state.active_availability_evidence?.allowed_slot_keys,
      ["2026-08-25T10:00"],
    );
    assert.equal(result.decision, "no_booking_apply");
  });
});
