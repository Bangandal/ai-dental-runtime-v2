/**
 * Context Assembler Lite v0 — tests.
 *
 * Goal: verify that recent_history from DB flows into model-visible context
 * independent of OpenAI conversation_id, is correctly capped, never exposes
 * null persistence flags as business truth, and adds zero extra LLM calls.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { assembleRecentHistory, buildModelVisibleRuntimeContext } from "../src/runtime/modelVisibleRuntimeContext.ts";
import {
  createRuntimeAgentLoop,
  type RuntimeAgentCaller,
  type RuntimeAgentCallerOutput,
} from "../src/runtime/runtimeAgentLoop.ts";

// ── helper: raw message fixture ───────────────────────────────────────────────

function makeMessages(texts: string[], roles?: string[]): Array<{ role: string; text: string }> {
  return texts.map((text, i) => ({ role: roles?.[i] ?? (i % 2 === 0 ? "user" : "assistant"), text }));
}

// ── 1. recent_history flows through independent of conversation_id ────────────

test("CA-1: recent_history from DB is included in model-visible context regardless of conversation_id", () => {
  const context = {
    known_contact: {},
    conversation_state: { collected: {} },
    recent_history: [
      { role: "user", text: "Привет, хочу записаться" },
      { role: "assistant", text: "Здравствуйте! На какую дату?" },
    ],
  };

  // context has no conversation_id at all — assembler is independent
  const result = buildModelVisibleRuntimeContext(context);
  const history = result.recent_history as Array<{ role: string; text: string }>;

  assert.ok(Array.isArray(history), "recent_history must be an array");
  assert.equal(history.length, 2, "both messages must be present");
  assert.equal(history[0].role, "user");
  assert.equal(history[0].text, "Привет, хочу записаться");
  assert.equal(history[1].role, "assistant");
});

// ── 2. patient name visible in recent_history ─────────────────────────────────

test("CA-2: patient-stated name is accessible from recent_history even when task_state.collected.name is null", () => {
  const context = {
    known_contact: {},
    conversation_state: {
      collected: { name: null },           // not yet persisted via booking.apply
      missing_fields: [],
    },
    recent_history: [
      { role: "user", text: "Меня зовут Иван Петров, хочу на чистку" },
      { role: "assistant", text: "Хорошо, Иван! На какое число?" },
    ],
  };

  const result = buildModelVisibleRuntimeContext(context);

  // Null name must NOT appear in task_state.collected
  const taskState = result.task_state as Record<string, unknown>;
  const collected = taskState.collected as Record<string, unknown>;
  assert.equal("name" in collected, false, "null name must not appear in collected");

  // But the name IS available in recent_history
  const history = result.recent_history as Array<{ role: string; text: string }>;
  const hasName = history.some((m) => m.text.includes("Иван Петров"));
  assert.ok(hasName, "patient name from conversation must be in recent_history");
});

// ── 3. message-count cap ──────────────────────────────────────────────────────

test("CA-3a: recent_history is capped at 8 messages", () => {
  const raw = Array.from({ length: 15 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", text: `message ${i}` }));
  const result = assembleRecentHistory(raw);

  assert.ok(result.length <= 8, `must have ≤ 8 messages, got ${result.length}`);
  // Must be the LAST 8
  assert.equal(result[0].text, "message 7", "must start from message index 7 (8th-from-end)");
  assert.equal(result[result.length - 1].text, "message 14");
});

test("CA-3b: recent_history is capped by 2000-char total budget", () => {
  // 5 messages × 600 chars each = 3000 chars > budget; expect oldest dropped
  const longText = "х".repeat(600);
  const raw = Array.from({ length: 5 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", text: longText }));
  const result = assembleRecentHistory(raw);

  const totalChars = result.reduce((sum, m) => sum + m.text.length, 0);
  assert.ok(totalChars <= 2000, `total chars ${totalChars} must be ≤ 2000`);
  assert.ok(result.length < 5, "some messages must have been dropped to meet char budget");
  // Most recent messages must be kept (oldest dropped)
  assert.equal(result[result.length - 1].text, longText);
});

// ── 4. no false/null persistence flags in model-visible context ───────────────

test("CA-4: null and undefined collected fields are not present in model-visible task_state.collected", () => {
  const context = {
    known_contact: {},
    conversation_state: {
      collected: {
        name: null,
        service_interest: null,
        preferred_time: "утром",
        problem: undefined,
      },
    },
    recent_history: [],
  };

  const result = buildModelVisibleRuntimeContext(context);
  const collected = (result.task_state as Record<string, unknown>).collected as Record<string, unknown>;

  assert.equal("name" in collected, false, "null name must not appear");
  assert.equal("service_interest" in collected, false, "null service_interest must not appear");
  assert.equal("problem" in collected, false, "undefined problem must not appear");
  assert.equal(collected.preferred_time, "утром", "non-null preferred_time must be kept");
});

test("CA-4b: empty recent_history from context produces empty array in output (not null/undefined)", () => {
  const result = buildModelVisibleRuntimeContext({ known_contact: {}, conversation_state: {} });
  assert.ok(Array.isArray(result.recent_history), "recent_history must always be an array");
  assert.equal((result.recent_history as unknown[]).length, 0);
});

// ── 5. existing guards unaffected by recent_history in context ────────────────

test("CA-5: phone guard still intercepts booking.apply when channel_contact absent, even with recent_history present", async () => {
  const caller: RuntimeAgentCaller = async (input): Promise<RuntimeAgentCallerOutput> => {
    if (!input.input.tool_results?.length) {
      return {
        type: "tool_requests",
        tool_requests: [{ tool: "booking.apply", call_id: "b1", arguments: { subject_id: "subject_1", first_name: "Иван", last_name: "Петров", service: "чистка", requested_date: "2099-01-15", requested_time: "10:00" } }],
      };
    }
    return { type: "final_response", final_response: { final_patient_reply: "Нам нужен номер телефона." } };
  };
  const agent = createRuntimeAgentLoop({
    model: "gpt-test",
    caller,
    executors: {},
    bookingProcessStateRepository: {
      async loadState() { return { selected_slot: { starts_at: "2099-01-15T10:00:00" } }; },
      async saveState() {},
    },
  });

  // Input has recent_history injected into business_context.runtime_context — but no channel_contact
  const result = await agent.runTurn({
    clinic_id: "clinic_1",
    contact_id: "contact_1",
    case_id: "case_1",
    user_message: "Записываюсь",
    locale: "ru",
    truth_snapshot: { scheduling_intent_present: true },
    business_context: {
      runtime_context: buildModelVisibleRuntimeContext({
        known_contact: {},
        conversation_state: { collected: {} },
        recent_history: [
          { role: "user", text: "Меня зовут Иван Петров, хочу на чистку 15 января в 10:00" },
        ],
      }),
    },
    // channel_contact deliberately absent — phone guard must fire
  });

  // booking.apply must have been intercepted with missing_trusted_phone
  const bookingResult = result.tool_results.find((r) => r.tool === "booking.apply");
  assert.ok(bookingResult, "booking.apply tool result must exist");
  const data = bookingResult.data as Record<string, unknown>;
  assert.equal(data.booking_status, "missing_trusted_phone",
    "phone guard must fire even when recent_history is present");
});

// ── 6. no extra LLM call ──────────────────────────────────────────────────────

test("CA-6: context assembly adds zero extra LLM/caller invocations per turn", async () => {
  let callCount = 0;
  const caller: RuntimeAgentCaller = async (): Promise<RuntimeAgentCallerOutput> => {
    callCount++;
    return { type: "final_response", final_response: { final_patient_reply: "Здравствуйте!" } };
  };
  const agent = createRuntimeAgentLoop({ model: "gpt-test", caller, executors: {} });

  await agent.runTurn({
    clinic_id: "clinic_1",
    contact_id: "contact_1",
    case_id: "case_1",
    user_message: "Привет",
    locale: "ru",
    business_context: {
      runtime_context: buildModelVisibleRuntimeContext({
        known_contact: {},
        conversation_state: { collected: {} },
        recent_history: [
          { role: "user", text: "Предыдущее сообщение 1" },
          { role: "assistant", text: "Предыдущий ответ 1" },
          { role: "user", text: "Предыдущее сообщение 2" },
        ],
      }),
    },
  });

  assert.equal(callCount, 1, "assembling recent_history must add exactly 0 extra LLM calls");
});
