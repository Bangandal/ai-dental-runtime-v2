import assert from "node:assert/strict";
import test from "node:test";

import { buildAgentFirstSystemInstruction } from "../src/runtime/agentFirstSystemInstruction.ts";
import { projectModelFacingContext } from "../src/runtime/modelFacingContextProjection.ts";
import {
  runRuntimeTurnOrchestrated,
  withAgentFirstTurnLocalConversationMemory,
  type RuntimeTurnOrchestratorDeps,
} from "../src/runtime/runtimeTurnOrchestrator.ts";
import type { RuntimeTurnInput, RuntimeTurnService } from "../src/runtime/runtimeTurnService.ts";
import type { OpenAIConversationMemoryRepository } from "../src/runtime/supabaseOpenAIConversationMemoryRepository.ts";

const CLINIC_ID = "11111111-1111-4111-8111-111111111111";

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

function makeProviderMemorySpy(initial = "conv_durable_old") {
  let loadCalls = 0;
  let saveCalls = 0;
  const repo: OpenAIConversationMemoryRepository = {
    async getConversationMemory() {
      loadCalls += 1;
      return { ok: true, data: { conversation_id: initial } };
    },
    async saveConversationMemory(input) {
      saveCalls += 1;
      return { ok: true, data: { conversation_id: input.conversation_id } };
    },
  };
  return {
    repo,
    get loadCalls() { return loadCalls; },
    get saveCalls() { return saveCalls; },
  };
}

test("agent-first model projection treats locale as a weak hint and removes stale intake steering", async () => {
  await withAgentMode("agent_first", () => {
    const projected = projectModelFacingContext({
      locale: "ru",
      channel_context: { channel: "telegram" },
      runtime_context: {
        patient_context: {
          display_name: "Олена",
          preferred_language: "ru",
          reachable_in_current_channel: true,
        },
        task_state: {
          collected: { service_interest: "брекети" },
          missing_fields: ["preferred_time"],
          last_known_intent: "booking",
          intake_status: "collecting_time",
        },
        recent_history: [
          { role: "user", text: "Мені потрібні брекети" },
          { role: "assistant", text: "Добре. Що саме вас цікавить?" },
        ],
      },
    });

    assert.equal(projected.locale, undefined);
    const channel = projected.channel_context as Record<string, unknown>;
    assert.equal(channel.language_hint, "ru");

    const runtime = projected.runtime_context as Record<string, unknown>;
    const patient = runtime.patient_context as Record<string, unknown>;
    assert.equal(patient.preferred_language, undefined);
    assert.equal(patient.profile_language_hint, "ru");

    const task = runtime.task_state as Record<string, unknown>;
    assert.deepEqual(task.collected, { service_interest: "брекети" });
    assert.equal(task.missing_fields, undefined);
    assert.equal(task.last_known_intent, undefined);
    assert.equal(task.intake_status, undefined);
    assert.equal((runtime.recent_history as unknown[]).length, 2);
  });
});

test("legacy model projection preserves historical locale and intake context", async () => {
  await withAgentMode("legacy", () => {
    const original = {
      locale: "ru",
      channel_context: { channel: "telegram" },
      runtime_context: {
        patient_context: { preferred_language: "ru" },
        task_state: {
          collected: { service_interest: "cleaning" },
          missing_fields: ["preferred_time"],
          last_known_intent: "booking",
          intake_status: "collecting_time",
        },
      },
    };
    const projected = projectModelFacingContext(original);
    assert.equal(projected.locale, "ru");
    const runtime = projected.runtime_context as Record<string, any>;
    assert.equal(runtime.patient_context.preferred_language, "ru");
    assert.deepEqual(runtime.task_state.missing_fields, ["preferred_time"]);
    assert.equal(runtime.task_state.last_known_intent, "booking");
  });
});

test("agent-first prompt defines conversation language, referent grounding and current-intent priority", () => {
  const prompt = buildAgentFirstSystemInstruction(
    "Today is 2026-09-08 (timezone: Europe/Prague). Final patient reply must be in the patient's language.",
  );

  assert.match(prompt, /language established by the patient's messages across the conversation/i);
  assert.match(prompt, /Profile or channel language hints are fallback metadata only/i);
  assert.match(prompt, /Czechisms/i);
  assert.match(prompt, /current patient message has priority over older intent, intake or booking-process state/i);
  assert.match(prompt, /Never substitute a different person, procedure, appointment, document or other object/i);
  assert.match(prompt, /ask one precise clarification instead of guessing/i);
  assert.match(prompt, /Do not invent an individualized dentist recommendation/i);
});

test("agent-first provider conversation is fresh per patient turn and durable provider memory is not touched", async () => {
  await withAgentMode("agent_first", async () => {
    const durableMemory = makeProviderMemorySpy();
    const seenInputs: RuntimeTurnInput[] = [];
    let localConversationSequence = 0;

    const service: RuntimeTurnService = {
      async runTurn(input) {
        seenInputs.push(input);
        return {
          final_patient_reply: "ok",
          conversation_id: input.conversation_id ?? null,
          conversation_id_resumable: true,
          tool_requests: [],
          tool_results: [],
        };
      },
    };

    const deps: RuntimeTurnOrchestratorDeps = {
      runtimeTurnService: service,
      openAIConversationMemoryRepository: durableMemory.repo,
      createOpenAIConversation: async () => `conv_turn_${++localConversationSequence}`,
      clinicIdentityResolver: {
        async resolveClinicIdentity() {
          return { ok: true, data: { clinic_id: CLINIC_ID, clinic_code: "clinic_1" } };
        },
      },
    };

    const body = {
      clinic_code: "clinic_1",
      channel: "telegram",
      external_user_id: "patient-agent-first-memory",
      chat_id: "patient-agent-first-memory",
      text: "Привіт",
    };

    const first = await runRuntimeTurnOrchestrated(body, deps);
    const second = await runRuntimeTurnOrchestrated({ ...body, text: "Хотів би завтра" }, deps);

    assert.equal(first.outcome, "success");
    assert.equal(second.outcome, "success");
    assert.equal(durableMemory.loadCalls, 0, "agent-first must not load provider cross-turn memory");
    assert.equal(durableMemory.saveCalls, 0, "agent-first must not persist provider cross-turn memory");
    assert.equal(localConversationSequence, 2, "each patient turn receives a fresh provider conversation");
    assert.equal(seenInputs[0]?.conversation_id, "conv_turn_1");
    assert.equal(seenInputs[1]?.conversation_id, "conv_turn_2");
    assert.notEqual(seenInputs[0]?.conversation_id, seenInputs[1]?.conversation_id);
  });
});

test("legacy keeps the original durable provider memory dependency unchanged", async () => {
  await withAgentMode("legacy", () => {
    const durableMemory = makeProviderMemorySpy();
    const service: RuntimeTurnService = {
      async runTurn() {
        return { final_patient_reply: "ok", tool_requests: [], tool_results: [] };
      },
    };
    const deps: RuntimeTurnOrchestratorDeps = {
      runtimeTurnService: service,
      openAIConversationMemoryRepository: durableMemory.repo,
    };

    assert.equal(withAgentFirstTurnLocalConversationMemory(deps), deps);
  });
});
