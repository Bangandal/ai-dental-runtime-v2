import assert from "node:assert/strict";
import test from "node:test";

import { runRuntimeTurnModelToolOrchestration } from "../src/runtime/runtimeTurnModelToolOrchestrator.ts";
import { createRuntimeModelIterationState } from "../src/runtime/runtimeModelIteration.ts";
import type { RuntimeAgentCaller } from "../src/runtime/runtimeModelCall.ts";
import type { BookingProcessState } from "../src/runtime/bookingProcessState.ts";

function emptyBookingState(): BookingProcessState {
  return {
    proof: {
      service_known: false,
      name_known: false,
      slot_known: false,
      trusted_phone_known: false,
      ready_for_booking_apply: false,
    },
  };
}

async function withAgentMode<T>(mode: "legacy" | "agent_first", fn: () => Promise<T>): Promise<T> {
  const previous = process.env.RUNTIME_AGENT_MODE;
  process.env.RUNTIME_AGENT_MODE = mode;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.RUNTIME_AGENT_MODE;
    else process.env.RUNTIME_AGENT_MODE = previous;
  }
}

function makeCaller(): { caller: RuntimeAgentCaller; getCalls: () => number } {
  let calls = 0;
  const caller: RuntimeAgentCaller = async (input) => {
    calls += 1;
    if (calls === 1) {
      return {
        type: "tool_requests",
        conversation_id: "conv-past-time",
        tool_requests: [{
          tool: "availability.check",
          call_id: "availability-past",
          arguments: {
            requested_date: "2026-08-22",
            requested_time: "10:00",
            service_interest: "consultation",
          },
        }],
      };
    }

    assert.ok(input.input.tool_results?.length, "recovery call must receive the ordinary availability tool result");
    return {
      type: "final_response",
      conversation_id: "conv-past-time",
      final_response: { final_patient_reply: "Могу предложить более позднее время." },
    };
  };
  return { caller, getCalls: () => calls };
}

const now = new Date("2026-08-22T15:00:00.000Z"); // 17:00 Europe/Prague

const availabilityExecutor = async () => ({
  tool: "availability.check" as const,
  status: "success" as const,
  data: {
    slots: [{
      slot_id: "future-1800",
      starts_at: "2026-08-22T18:00:00",
      ends_at: "2026-08-22T18:30:00",
    }],
    timezone: "Europe/Prague",
    total_slots: 1,
    free_slots_count: 1,
  },
});

test("agent-first: an expired requested time goes through availability and returns control to the model", async () => {
  await withAgentMode("agent_first", async () => {
    const { caller, getCalls } = makeCaller();
    let executorCalls = 0;

    const outcome = await runRuntimeTurnModelToolOrchestration({
      model_state: createRuntimeModelIterationState(null, 4),
      caller,
      model: "test-model",
      system_instruction: "test",
      input: {
        clinic_id: "clinic_1",
        contact_id: "contact_1",
        case_id: "case_1",
        user_message: "Можно сегодня в 10:00?",
      },
      caller_context: {},
      executors: {
        "availability.check": async (context) => {
          executorCalls += 1;
          assert.equal(context.requested_date, "2026-08-22");
          assert.equal(context.requested_time, "10:00");
          return availabilityExecutor();
        },
      },
      prior_booking_process_state: null,
      initial_booking_process_state: emptyBookingState(),
      now,
      timezone: "Europe/Prague",
    });

    assert.equal(outcome.kind, "final_response");
    assert.equal(getCalls(), 2);
    assert.equal(executorCalls, 1, "agent-first must not abort before the ordinary availability executor");
    if (outcome.kind === "final_response") {
      assert.equal(outcome.output.final_response.final_patient_reply, "Могу предложить более позднее время.");
      assert.equal(outcome.domain_state.past_time_detail, null);
    }
  });
});

test("legacy: expired requested time keeps the historical pre-executor abort", async () => {
  await withAgentMode("legacy", async () => {
    const { caller, getCalls } = makeCaller();
    let executorCalls = 0;

    const outcome = await runRuntimeTurnModelToolOrchestration({
      model_state: createRuntimeModelIterationState(null, 4),
      caller,
      model: "test-model",
      system_instruction: "test",
      input: {
        clinic_id: "clinic_1",
        contact_id: "contact_1",
        case_id: "case_1",
        user_message: "Можно сегодня в 10:00?",
      },
      caller_context: {},
      executors: {
        "availability.check": async () => {
          executorCalls += 1;
          return availabilityExecutor();
        },
      },
      prior_booking_process_state: null,
      initial_booking_process_state: emptyBookingState(),
      now,
      timezone: "Europe/Prague",
    });

    assert.equal(outcome.kind, "batch_aborted");
    assert.equal(getCalls(), 1);
    assert.equal(executorCalls, 0);
    if (outcome.kind === "batch_aborted") {
      assert.equal(outcome.reason, "availability_preflight_past_time");
      assert.equal(outcome.domain_state.past_time_detail?.requestedTime, "10:00");
    }
  });
});