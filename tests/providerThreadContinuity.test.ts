import assert from "node:assert/strict";
import test from "node:test";

import {
  runRuntimeTurnOrchestrated,
  type RuntimeTurnOrchestratorDeps,
} from "../src/runtime/runtimeTurnOrchestrator.ts";
import type { RuntimeTurnInput, RuntimeTurnService } from "../src/runtime/runtimeTurnService.ts";
import type { OpenAIConversationMemoryRepository } from "../src/runtime/supabaseOpenAIConversationMemoryRepository.ts";
import type { RuntimeContext, RuntimeContextRepository } from "../src/runtime/supabaseRuntimeContextRepository.ts";
import type { TurnPersistenceRepository } from "../src/runtime/supabaseTurnPersistenceRepository.ts";
import type { BookingSubjectsState } from "../src/runtime/bookingSubjectsState.ts";

const CLINIC_ID = "11111111-1111-4111-8111-111111111111";
const CONTACT_ID = "22222222-2222-4222-8222-222222222222";

const bookingSubjects: BookingSubjectsState = {
  version: 3,
  status: "active",
  active_subject_id: "subject_1",
  subjects: [{
    id: "subject_1",
    role: "sender",
    label: "я",
    patient_name: "Иван Петров",
    service: "профессиональная чистка",
    slot: "2026-08-24T10:00:00+02:00",
    booking_contact: {
      phone_number: "+420600111222",
      source: "telegram_contact_button",
      trust: "trusted",
      owner_subject_id: null,
      collected_at: "2026-08-21T12:00:00.000Z",
    },
    status: "ready_for_booking",
    missing: [],
  }],
  pending_typed_phone: null,
  max_subjects: 4,
};

function makeRuntimeContext(prior: boolean): RuntimeContext {
  return {
    known_contact: {
      contact_id: CONTACT_ID,
      clinic_id: CLINIC_ID,
      first_name: "Иван",
      last_name: "Петров",
      language_code: "ru",
    },
    conversation_state: {
      turn_count: prior ? 4 : 0,
      collected: prior
        ? {
            name: "Иван Петров",
            first_name: "Иван",
            last_name: "Петров",
            service_interest: "профессиональная чистка",
            service: "профессиональная чистка",
            problem: "хочу снять налёт",
            preferred_time: "утром",
          }
        : {},
      missing_fields: [],
      intent: prior ? "booking" : "unknown",
    },
    topic_memory: prior
      ? { last_service_interest: "профессиональная чистка", source: "runtime", confidence: "high" }
      : null,
    channel_contact: prior
      ? {
          phone_number: "+420600111222",
          phone_source: "telegram_contact_button",
          phone_consent: true,
          phone_collected_at: "2026-08-21T12:00:00.000Z",
        }
      : null,
    provided_phone: null,
    booking_subjects: prior ? bookingSubjects : null,
    selected_slot_starts_at: prior ? "2026-08-24T10:00:00+02:00" : null,
    case_context_lite: null,
    runtime_flags: {
      has_durable_context: true,
      context_source: "supabase",
      context_loaded_at: "2026-08-21T14:00:00.000Z",
      available_recent_history_count: prior ? 3 : 1,
    },
    recent_history: prior
      ? [
          { role: "user", text: "Хочу профессиональную чистку." },
          { role: "assistant", text: "На понедельник есть 10:00." },
          { role: "user", text: "Подтверждаю." },
        ]
      : [{ role: "user", text: "Здравствуйте" }],
  };
}

function makeMemoryRepo(initial: string | null): {
  repo: OpenAIConversationMemoryRepository;
  saveCalls: Array<{ conversation_id: string }>;
} {
  let stored = initial;
  const saveCalls: Array<{ conversation_id: string }> = [];
  const repo: OpenAIConversationMemoryRepository = {
    async getConversationMemory() {
      return { ok: true, data: { conversation_id: stored } };
    },
    async saveConversationMemory(input) {
      saveCalls.push({ conversation_id: input.conversation_id });
      stored = input.conversation_id || null;
      return { ok: true, data: { conversation_id: input.conversation_id } };
    },
  };
  return { repo, saveCalls };
}

function makeTurnPersistence(): TurnPersistenceRepository {
  let messageSequence = 0;
  return {
    async getOrCreateContact() {
      return { ok: true, data: { contact_id: CONTACT_ID, clinic_id: CLINIC_ID } };
    },
    async registerInboundEvent() {
      return { ok: true, data: { inbound_event_id: `inbound-${++messageSequence}`, is_duplicate: false, accepted: true } };
    },
    async saveMessage() {
      return { ok: true, data: { message_id: `message-${++messageSequence}` } };
    },
    async mergeConversationState() {
      return { ok: true, data: { ok: true } };
    },
  };
}

function makeContextRepo(prior: boolean): RuntimeContextRepository {
  return {
    async loadRuntimeContext() {
      return { ok: true, data: makeRuntimeContext(prior) };
    },
  };
}

function baseDeps(input: {
  service: RuntimeTurnService;
  memory: OpenAIConversationMemoryRepository;
  prior: boolean;
}): RuntimeTurnOrchestratorDeps {
  return {
    runtimeTurnService: input.service,
    openAIConversationMemoryRepository: input.memory,
    turnPersistenceRepository: makeTurnPersistence(),
    runtimeContextRepository: makeContextRepo(input.prior),
    clinicIdentityResolver: {
      async resolveClinicIdentity() {
        return { ok: true, data: { clinic_id: CLINIC_ID, clinic_code: "clinic_1" } };
      },
    },
  };
}

function body(text: string, externalUserId = "patient-pf009") {
  return {
    clinic_code: "clinic_1",
    channel: "telegram",
    external_user_id: externalUserId,
    chat_id: externalUserId,
    text,
  };
}

test("PF-009: dirty provider thread resets while durable booking facts remain visible on the next turn", async () => {
  const memory = makeMemoryRepo("conv_dirty_old");
  const seenInputs: RuntimeTurnInput[] = [];
  let call = 0;
  const service: RuntimeTurnService = {
    async runTurn(input) {
      seenInputs.push(input);
      call += 1;
      if (call === 1) {
        return {
          final_patient_reply: "Технически продолжим с новым диалогом.",
          conversation_id: null,
          conversation_id_resumable: false,
          tool_requests: [],
          tool_results: [],
        };
      }
      return {
        final_patient_reply: "Продолжаем запись.",
        conversation_id: "conv_fresh_new",
        conversation_id_resumable: true,
        tool_requests: [],
        tool_results: [],
      };
    },
  };
  const deps = baseDeps({ service, memory: memory.repo, prior: true });

  const first = await runRuntimeTurnOrchestrated(body("Подтверждаю"), deps);
  assert.equal(first.outcome, "success");
  assert.equal(memory.saveCalls[0]?.conversation_id, "", "dirty provider conversation must be actively cleared");

  const second = await runRuntimeTurnOrchestrated(body("Да, продолжаем"), deps);
  assert.equal(second.outcome, "success");
  assert.equal(seenInputs.length, 2);

  const nextInput = seenInputs[1];
  assert.notEqual(nextInput.conversation_id, "conv_dirty_old");
  assert.equal(nextInput.is_first_patient_turn, false, "provider reset must not masquerade as the patient's first turn");

  const visible = nextInput.business_context?.runtime_context as Record<string, any>;
  assert.equal(visible.task_state.collected.name, "Иван Петров");
  assert.equal(visible.task_state.collected.service_interest, "профессиональная чистка");
  assert.equal(visible.task_state.collected.problem, "хочу снять налёт");
  assert.equal(visible.task_state.collected.preferred_time, "утром");
  assert.equal(visible.recent_history.length, 3);

  assert.equal(nextInput.booking_subjects?.subjects[0]?.patient_name, "Иван Петров");
  assert.equal(nextInput.booking_subjects?.subjects[0]?.service, "профессиональная чистка");
  assert.equal(nextInput.booking_subjects?.subjects[0]?.slot, "2026-08-24T10:00:00+02:00");
});

test("PF-009: genuine first patient turn still keeps first-turn routing", async () => {
  const memory = makeMemoryRepo(null);
  const seenInputs: RuntimeTurnInput[] = [];
  const service: RuntimeTurnService = {
    async runTurn(input) {
      seenInputs.push(input);
      return {
        final_patient_reply: "Здравствуйте! Чем могу помочь?",
        conversation_id: "conv_first",
        conversation_id_resumable: true,
        tool_requests: [],
        tool_results: [],
      };
    },
  };

  const result = await runRuntimeTurnOrchestrated(
    body("Здравствуйте", "brand-new-patient-pf009"),
    baseDeps({ service, memory: memory.repo, prior: false }),
  );

  assert.equal(result.outcome, "success");
  assert.equal(seenInputs[0]?.is_first_patient_turn, true);
});
