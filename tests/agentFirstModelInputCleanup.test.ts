import assert from "node:assert/strict";
import test from "node:test";

import { buildOpenAIInput } from "../src/runtime/openaiRuntimeAgentCaller.ts";
import { RUNTIME_AGENT_TOOL_DEFINITIONS } from "../src/runtime/openaiRuntimeAgent.ts";

async function withAgentMode<T>(
  mode: "legacy" | "agent_first",
  fn: () => Promise<T> | T,
): Promise<T> {
  const previous = process.env.RUNTIME_AGENT_MODE;
  process.env.RUNTIME_AGENT_MODE = mode;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.RUNTIME_AGENT_MODE;
    else process.env.RUNTIME_AGENT_MODE = previous;
  }
}

function baseInput() {
  return {
    model: "gpt-test",
    conversation_id: "conv_turn_1",
    system_instruction: "system",
    input: {
      message: "Хотів би завтра",
      context: {
        locale: "uk",
        truth_snapshot: null,
        recent_summary: null,
        channel_context: {
          channel: "telegram",
          patient_reachable_in_current_channel: true,
        },
        runtime_context: {
          patient_context: {
            display_name: "Михайло",
            preferred_language: "uk",
            reachable_in_current_channel: true,
          },
          runtime_policy: {
            phone_required: false,
            patient_reachable_in_current_channel: true,
          },
          recent_history: [
            { role: "assistant", text: "Добре, коли вам зручно?" },
            { role: "user", text: "Хотів би завтра" },
          ],
        },
      },
      tool_definitions: RUNTIME_AGENT_TOOL_DEFINITIONS,
    },
  } as any;
}

test("agent-first initial model input contains current patient message once", async () => {
  await withAgentMode("agent_first", () => {
    const built = buildOpenAIInput(baseInput()) as Record<string, any>;
    assert.equal(built.input.length, 1);
    assert.equal(built.input[0].role, "user");

    const payload = JSON.parse(built.input[0].content[0].text);
    assert.equal(payload.message, "Хотів би завтра");
    assert.deepEqual(payload.context.runtime_context.recent_history, [
      { role: "assistant", text: "Добре, коли вам зручно?" },
    ]);
    assert.equal(payload.context.truth_snapshot, undefined);
    assert.equal(payload.context.recent_summary, undefined);
    assert.equal(payload.context.channel_context.language_hint, "uk");
    assert.equal(payload.context.channel_context.patient_reachable_in_current_channel, undefined);
    assert.equal(payload.context.runtime_context.patient_context.preferred_language, undefined);
    assert.equal(payload.context.runtime_context.patient_context.reachable_in_current_channel, undefined);
    assert.equal(
      payload.context.runtime_context.runtime_policy.patient_reachable_in_current_channel,
      true,
    );

    const serialized = JSON.stringify(payload);
    assert.equal(serialized.split("Хотів би завтра").length - 1, 1);
  });
});

test("agent-first tool follow-up does not replay patient message or full stable context", async () => {
  await withAgentMode("agent_first", () => {
    const input = baseInput();
    input.input.context = {
      ...input.input.context,
      booking_process_state: {
        selected_slot: null,
        next_action_confidence: "high",
      },
      availability_action_truth: {
        checked: true,
        requested_date: "2026-09-09",
      },
      availability_presentation_truth: {
        allowed_slots: ["2026-09-09T10:00:00+02:00"],
        max_slots_to_present: 3,
      },
    } as any;
    input.input.tool_results = [
      {
        tool: "availability.check",
        call_id: "call_availability_1",
        status: "success",
        data: { slots: [{ starts_at: "2026-09-09T10:00:00+02:00" }] },
      },
    ] as any;

    const built = buildOpenAIInput(input) as Record<string, any>;
    assert.equal(built.input.length, 1);
    assert.equal(built.input[0].type, "function_call_output");
    assert.equal(built.input.some((item: any) => item.role === "user"), false);

    const output = JSON.parse(built.input[0].output);
    assert.equal(output.tool, "availability.check");
    assert.deepEqual(output.data, {
      slots: [{ starts_at: "2026-09-09T10:00:00+02:00" }],
    });
    assert.deepEqual(output.runtime_truth.availability_action_truth, {
      checked: true,
      requested_date: "2026-09-09",
    });
    assert.deepEqual(output.runtime_truth.availability_presentation_truth, {
      allowed_slots: ["2026-09-09T10:00:00+02:00"],
      max_slots_to_present: 3,
    });
    assert.equal(JSON.stringify(built.input).includes("Хотів би завтра"), false);
    assert.equal(JSON.stringify(built.input).includes("recent_history"), false);
    assert.equal(JSON.stringify(built.input).includes("patient_context"), false);
  });
});

test("legacy keeps historical replay payload shape", async () => {
  await withAgentMode("legacy", () => {
    const input = baseInput();
    input.input.tool_results = [
      {
        tool: "kb.search",
        call_id: "call_kb_1",
        status: "success",
        data: { answer: "ok" },
      },
    ] as any;

    const built = buildOpenAIInput(input) as Record<string, any>;
    assert.equal(built.input[0].role, "user");
    const payload = JSON.parse(built.input[0].content[0].text);
    assert.equal(payload.message, "Хотів би завтра");
    assert.equal(built.input[1].type, "function_call_output");
    const output = JSON.parse(built.input[1].output);
    assert.equal(output.runtime_truth, undefined);
  });
});
