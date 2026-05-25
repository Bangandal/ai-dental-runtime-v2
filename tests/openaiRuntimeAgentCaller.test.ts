import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createOpenAIRuntimeAgentCaller } from "../src/runtime/openaiRuntimeAgentCaller.ts";
import { createRuntimeAgentLoop } from "../src/runtime/runtimeAgentLoop.ts";
import { RUNTIME_AGENT_TOOL_DEFINITIONS } from "../src/runtime/openaiRuntimeAgent.ts";

function makeInput() {
  return {
    model: "gpt-test",
    conversation_id: "conv_1",
    system_instruction: "system",
    input: {
      message: "Need help",
      context: { clinic_id: "c1" },
      tool_definitions: RUNTIME_AGENT_TOOL_DEFINITIONS,
    },
  };
}

test("calls injected client.responses.create with expected payload and active tools", async () => {
  let captured: unknown;
  const caller = createOpenAIRuntimeAgentCaller({
    client: {
      responses: {
        create: async (input: unknown) => {
          captured = input;
          return { output_text: "hello", conversation_id: "conv_1" };
        },
      },
    },
  });

  const result = await caller(makeInput());
  const payload = captured as Record<string, any>;

  assert.equal(payload.model, "gpt-test");
  assert.equal(payload.instructions, "system");
  assert.equal(Array.isArray(payload.input), true);
  assert.equal(payload.input[0].role, "user");
  assert.equal(payload.input[0].content[0].type, "input_text");
  const parsedPayload = JSON.parse(payload.input[0].content[0].text);
  assert.equal(parsedPayload.message, "Need help");
  assert.equal(payload.tools.length, 2);
  const toolNames = payload.tools.map((t: Record<string, unknown>) => t.name);
  assert.deepEqual(toolNames.sort(), ["availability_check", "kb_search"]);
  assert.equal(result.type, "final_response");
});

test("does not include future or admin tools", async () => {
  let captured: unknown;
  const caller = createOpenAIRuntimeAgentCaller({
    client: { responses: { create: async (input) => ((captured = input), { output_text: "ok" }) } },
  });

  await caller(makeInput());
  const names = ((captured as any).tools as Array<Record<string, unknown>>).map((x) => x.name);
  assert.equal(names.includes("hold.create"), false);
  assert.equal(names.includes("booking.confirm"), false);
  assert.equal(names.includes("cancel_hold"), false);
  assert.equal(names.includes("appointment.lookup"), false);
  assert.equal(names.includes("admin.notify"), false);
});

test("openai tool definitions names do not contain dots and include expected tools", async () => {
  let captured: unknown;
  const caller = createOpenAIRuntimeAgentCaller({
    client: { responses: { create: async (input) => ((captured = input), { output_text: "ok" }) } },
  });

  await caller(makeInput());
  const names = ((captured as any).tools as Array<Record<string, string>>).map((x) => x.name);
  for (const name of names) assert.equal(name.includes("."), false);
  assert.equal(names.includes("kb_search"), true);
  assert.equal(names.includes("availability_check"), true);
});

test("maps tool call output to tool_requests", async () => {
  const caller = createOpenAIRuntimeAgentCaller({
    client: {
      responses: {
        create: async () => ({
          conversation_id: "conv_2",
          tool_calls: [{ name: "kb_search", arguments: JSON.stringify({ query: "insurance" }), call_id: "call_1" }],
        }),
      },
    },
  });

  const result = await caller(makeInput());
  assert.equal(result.type, "tool_requests");
  assert.equal(result.conversation_id, "conv_2");
  assert.equal(result.tool_requests[0]?.tool, "kb.search");
  assert.deepEqual(result.tool_requests[0]?.arguments, { query: "insurance" });
});

test("maps availability_check tool call output to internal availability.check", async () => {
  const caller = createOpenAIRuntimeAgentCaller({
    client: {
      responses: {
        create: async () => ({
          conversation_id: "conv_2",
          tool_calls: [{ name: "availability_check", arguments: JSON.stringify({ date: "tomorrow" }), call_id: "call_2" }],
        }),
      },
    },
  });

  const result = await caller(makeInput());
  assert.equal(result.type, "tool_requests");
  assert.equal(result.tool_requests[0]?.tool, "availability.check");
  assert.deepEqual(result.tool_requests[0]?.arguments, { date: "tomorrow" });
});

test("maps final output text and structured fields to final_response", async () => {
  const caller = createOpenAIRuntimeAgentCaller({
    client: {
      responses: {
        create: async () => ({
          conversation_id: "conv_3",
          final_response: {
            final_patient_reply: "Hola",
            language: "es",
            reply_reason: "clarity",
            safety_notes: ["note"],
          },
        }),
      },
    },
  });

  const result = await caller(makeInput());
  assert.equal(result.type, "final_response");
  assert.equal(result.final_response.final_patient_reply, "Hola");
  assert.equal(result.final_response.language, "es");
});


test("maps responses-style output message content output_text to final_response", async () => {
  const caller = createOpenAIRuntimeAgentCaller({
    client: {
      responses: {
        create: async () => ({
          conversation_id: "conv_4",
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "From output array" }],
            },
          ],
        }),
      },
    },
  });

  const result = await caller(makeInput());
  assert.equal(result.type, "final_response");
  assert.equal(result.final_response.final_patient_reply, "From output array");
});

test("malformed output returns safe final response", async () => {
  const caller = createOpenAIRuntimeAgentCaller({
    client: { responses: { create: async () => ({ bad: true }) } },
  });

  const result = await caller(makeInput());
  assert.equal(result.type, "final_response");
  assert.match(result.final_response.final_patient_reply, /having trouble processing/i);
  assert.deepEqual(result.final_response.safety_notes, ["malformed_openai_response"]);
});

test("passes conversation_id and supports continuation with tool_results", async () => {
  const seen: unknown[] = [];
  const caller = createOpenAIRuntimeAgentCaller({
    client: {
      responses: {
        create: async (input) => {
          seen.push(input);
          return { output_text: "done", conversation_id: "conv_r" };
        },
      },
    },
  });

  const input = makeInput();
  input.input.tool_results = [{ tool: "kb.search", status: "success", data: { chunks: [] } } as any];
  const result = await caller(input);

  assert.equal((seen[0] as any).conversation, "conv_1");
  const functionOutputs = ((seen[0] as any).input as Array<Record<string, unknown>>).filter((item) => item.type === "function_call_output");
  assert.equal(functionOutputs.length, 0);
  assert.equal(result.conversation_id, "conv_r");
});

test("adapter has no forbidden imports or env var reads", async () => {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const modulePath = resolve(thisDir, "../src/runtime/openaiRuntimeAgentCaller.ts");
  const source = await readFile(modulePath, "utf8");

  assert.doesNotMatch(source, /from\s+["'][^"']*n8n[^"']*["']/i);
  assert.doesNotMatch(source, /from\s+["'][^"']*telegram[^"']*["']/i);
  assert.doesNotMatch(source, /from\s+["'][^"']*calendar[^"']*["']/i);
  assert.doesNotMatch(source, /from\s+["'][^"']*supabase[^"']*["']/i);
  assert.doesNotMatch(source, /process\.env/i);
});


test("openai input includes runtime_context block when provided", async () => {
  let captured: unknown;
  const caller = createOpenAIRuntimeAgentCaller({
    client: { responses: { create: async (input) => ((captured = input), { output_text: "ok" }) } },
  });

  const input = makeInput();
  (input.input.context as Record<string, unknown>).runtime_context = {
    patient_context: { display_name: "Ada" },
    task_state: { collected: {}, missing_fields: [], last_known_intent: null, intake_status: null },
    runtime_policy: { phone_required: null, patient_reachable_in_current_channel: false },
    recent_history: [],
  };

  await caller(input as any);
  const payload = captured as Record<string, any>;
  const parsedPayload = JSON.parse(payload.input[0].content[0].text);
  assert.equal(parsedPayload.context.runtime_context.patient_context.display_name, "Ada");
  assert.deepEqual(parsedPayload.context.runtime_context.recent_history, []);
});

test("actual OpenAI payload excludes backend/transport/debug ids from context", async () => {
  let captured: Record<string, any> | undefined;
  const openAICaller = createOpenAIRuntimeAgentCaller({
    client: {
      responses: {
        create: async (input) => {
          captured = input as Record<string, any>;
          return { output_text: "ok", conversation_id: "conv_1" };
        },
      },
    },
  });

  const agent = createRuntimeAgentLoop({ model: "gpt-test", caller: openAICaller, executors: {} });
  await agent.runTurn({
    trace_id: "trace_1",
    clinic_id: "clinic_1",
    contact_id: "contact_1",
    case_id: "case_1",
    user_message: "hello",
    locale: "ru",
    business_context: {
      channel: "telegram",
      chat_id: "chat_1",
      external_user_id: "ext_1",
      meta: { username: "raw_u", message_id: "m1", update_id: "u1" },
      runtime_context: {
        patient_context: { display_name: "Ada", preferred_language: "ru", reachable_in_current_channel: true },
        task_state: { collected: { problem: "pain" }, missing_fields: ["phone"], last_known_intent: "faq", intake_status: "intake" },
        runtime_policy: { phone_required: true, patient_reachable_in_current_channel: true },
        recent_history: [],
      },
    },
    recent_summary: null,
  } as any);

  const parsedPayload = JSON.parse(captured?.input?.[0]?.content?.[0]?.text ?? "{}");
  const context = parsedPayload.context as Record<string, any>;

  const banned = ["trace_id", "clinic_id", "contact_id", "case_id", "chat_id", "external_user_id", "meta", "username", "message_id", "update_id", "state_version", "last_user_message_text", "last_bot_question", "last_bot_action"];
  const hasBannedKey = (obj: unknown): boolean => {
    if (!obj || typeof obj !== "object") return false;
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (banned.includes(key)) return true;
      if (hasBannedKey(value)) return true;
    }
    return false;
  };

  assert.equal(hasBannedKey(parsedPayload), false);
  assert.equal(context.locale, "ru");
  assert.equal(context.channel_context.channel, "telegram");
  assert.equal(context.channel_context.patient_reachable_in_current_channel, true);
  assert.equal(context.runtime_context.patient_context.display_name, "Ada");
  assert.deepEqual(context.runtime_context.recent_history, []);
});
