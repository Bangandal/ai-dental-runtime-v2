import {
  createRuntimeTurnSerialQueue,
  runRuntimeTurnSerialized,
} from "./runtimeTurnSerialQueue.ts";
import { withDurableConversationContinuity } from "./runtimeConversationContinuity.ts";
import { withStaffRequestHandling } from "./staffRequestHandling.ts";
import type { RuntimeTurnResult } from "./runtimeTurnService.ts";
import {
  runRuntimeTurnOrchestrated as runRuntimeTurnOrchestratedLegacy,
} from "./runtimeTurnOrchestratorLegacy.ts";
import {
  mergeAgentQualification,
  parseStoredAgentQualification,
  type AgentQualificationState,
} from "./agentQualification.ts";
import { isAgentFirstRuntimeEnabled } from "./agentFirstRuntimePolicy.ts";
import {
  getSemanticSessionStartedAt,
  isStoredSemanticItemInCurrentSession,
} from "./modelVisibleRuntimeContext.ts";

export {
  applyMessengerPhonePolicy,
  getCaseLiteMode,
  type CaseLiteMode,
  type RuntimeTurnOrchestratorDeps,
  type RuntimeTurnOrchestratorResult,
} from "./runtimeTurnOrchestratorLegacy.ts";

const runtimeTurnSerialQueue = createRuntimeTurnSerialQueue();

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stableJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function stripLegacyAgentFirstSeedFields(
  conversationState: Record<string, unknown>,
): Record<string, unknown> {
  const collected = asRecord(conversationState.collected);
  const {
    first_name: _firstName,
    patient_first_name: _patientFirstName,
    last_name: _lastName,
    patient_last_name: _patientLastName,
    service: _service,
    service_reason: _serviceReason,
    ...safeCollected
  } = collected;
  return { ...conversationState, collected: safeCollected };
}

/**
 * Agent-first owns cross-turn dialogue continuity through Runtime/Supabase history.
 * Provider conversation ids are deliberately scoped to one patient turn only.
 *
 * The frozen legacy orchestrator still expects a conversation-memory repository to
 * determine first-turn routing and to persist provider ids. In agent-first we replace
 * that durable provider repository with an in-memory null boundary: every new patient
 * turn starts without an old provider thread, while createOpenAIConversation may still
 * create a fresh conversation that is reused by model -> tool -> model calls inside
 * the same turn. Saves are acknowledged but never leave the turn.
 *
 * Legacy mode is returned byte-for-byte unchanged for rollback compatibility.
 */
export function withAgentFirstTurnLocalConversationMemory(
  deps: Parameters<typeof runRuntimeTurnOrchestratedLegacy>[1],
): Parameters<typeof runRuntimeTurnOrchestratedLegacy>[1] {
  if (!isAgentFirstRuntimeEnabled()) return deps;

  return {
    ...deps,
    openAIConversationMemoryRepository: {
      async getConversationMemory() {
        return { ok: true, data: { conversation_id: null } };
      },
      async saveConversationMemory(input) {
        return { ok: true, data: { conversation_id: input.conversation_id } };
      },
    },
  };
}

/**
 * Agent-first semantic persistence adapter around the frozen legacy orchestrator.
 *
 * It reuses the RuntimeContext snapshot already loaded at turn start, so qualification
 * persistence does not perform a second Supabase read. Durable semantic objects receive
 * their own timestamps and are merged only inside the current message session. Stale
 * PEOPLE and unverified typed phones are also removed from the execution snapshot, so
 * hidden legacy state cannot bind a new patient turn to an old subject/contact owner.
 */
export function withAgentQualificationPersistence(
  deps: Parameters<typeof runRuntimeTurnOrchestratedLegacy>[1],
): Parameters<typeof runRuntimeTurnOrchestratedLegacy>[1] {
  const agentFirst = isAgentFirstRuntimeEnabled();
  let capturedQualification: AgentQualificationState | null = null;
  let capturedStaffRequest: RuntimeTurnResult["staff_request_state"];
  let previousQualification: AgentQualificationState | null = null;
  let previousBookingSubjectsSignature = stableJson(null);
  let runtimeContextLoaded = deps.runtimeContextRepository == null;

  const runtimeContextRepository = deps.runtimeContextRepository
    ? {
        async loadRuntimeContext(
          input: Parameters<typeof deps.runtimeContextRepository.loadRuntimeContext>[0],
        ) {
          const result = await deps.runtimeContextRepository!.loadRuntimeContext(input);
          runtimeContextLoaded = result.ok;
          if (!result.ok) return result;

          const conversationState = asRecord(result.data.conversation_state);
          const collected = asRecord(conversationState.collected);
          const sessionStartedAt = getSemanticSessionStartedAt(result.data.recent_history);
          const previousQualificationIsCurrent = isStoredSemanticItemInCurrentSession(
            collected.agent_qualification_updated_at,
            sessionStartedAt,
          );
          previousQualification = previousQualificationIsCurrent
            ? parseStoredAgentQualification(collected.agent_qualification)
            : null;

          const bookingSubjectsAreCurrent = isStoredSemanticItemInCurrentSession(
            collected.booking_subjects_updated_at,
            sessionStartedAt,
          );
          // Compare future persistence against what is actually stored, even when that registry
          // is stale for execution. Otherwise an unchanged stale registry would receive a fresh
          // timestamp merely because we intentionally hid it from the current turn.
          previousBookingSubjectsSignature = stableJson(result.data.booking_subjects);

          if (!agentFirst) return result;

          const providedPhoneIsCurrent = result.data.provided_phone == null
            || isStoredSemanticItemInCurrentSession(
              result.data.provided_phone.phone_collected_at,
              sessionStartedAt,
            );

          return {
            ...result,
            data: {
              ...result.data,
              conversation_state: stripLegacyAgentFirstSeedFields(conversationState),
              booking_subjects: bookingSubjectsAreCurrent ? result.data.booking_subjects : null,
              provided_phone: providedPhoneIsCurrent ? result.data.provided_phone : null,
              // selected_slot_starts_at is only a legacy S1 bootstrap hint here. The actual
              // booking-process proof remains in its dedicated repository and stays authoritative.
              selected_slot_starts_at: bookingSubjectsAreCurrent
                ? result.data.selected_slot_starts_at
                : null,
            },
          };
        },
      }
    : undefined;

  const runtimeTurnService = {
    async runTurn(input: Parameters<typeof deps.runtimeTurnService.runTurn>[0]) {
      const result = await deps.runtimeTurnService.runTurn(input);
      capturedQualification = result.qualification ?? null;
      capturedStaffRequest = result.staff_request_state;
      return result;
    },
  };

  if (!deps.turnPersistenceRepository) {
    return {
      ...deps,
      runtimeTurnService,
      ...(runtimeContextRepository ? { runtimeContextRepository } : {}),
    };
  }

  const originalPersistence = deps.turnPersistenceRepository;
  const turnPersistenceRepository = {
    ...originalPersistence,
    async mergeConversationState(
      input: Parameters<typeof originalPersistence.mergeConversationState>[0],
    ) {
      const nowIso = new Date().toISOString();
      const controlFlags = asRecord(input.control_flags);
      const collectedPatch = { ...asRecord(controlFlags.collected) };
      let collectedChanged = false;

      if (capturedStaffRequest?.proof.request_saved) {
        collectedPatch.agent_staff_request = capturedStaffRequest;
        collectedPatch.agent_staff_request_updated_at = nowIso;
        collectedChanged = true;
      }

      if (capturedQualification && runtimeContextLoaded) {
        const mergedQualification = mergeAgentQualification(
          previousQualification,
          capturedQualification,
        );
        if (mergedQualification) {
          collectedPatch.agent_qualification = mergedQualification;
          collectedPatch.agent_qualification_updated_at = nowIso;
          collectedChanged = true;
        }
      }

      if (Object.prototype.hasOwnProperty.call(controlFlags, "booking_subjects")) {
        const incomingBookingSubjectsSignature = stableJson(controlFlags.booking_subjects);
        if (incomingBookingSubjectsSignature !== previousBookingSubjectsSignature) {
          collectedPatch.booking_subjects_updated_at = nowIso;
          collectedChanged = true;
        }
      }

      if (!collectedChanged) {
        return originalPersistence.mergeConversationState(input);
      }

      return originalPersistence.mergeConversationState({
        ...input,
        control_flags: {
          ...controlFlags,
          collected: collectedPatch,
        },
      });
    },
  };

  return {
    ...deps,
    runtimeTurnService,
    ...(runtimeContextRepository ? { runtimeContextRepository } : {}),
    turnPersistenceRepository,
  };
}

export function runRuntimeTurnOrchestrated(
  body: Parameters<typeof runRuntimeTurnOrchestratedLegacy>[0],
  deps: Parameters<typeof runRuntimeTurnOrchestratedLegacy>[1],
  opts?: Parameters<typeof runRuntimeTurnOrchestratedLegacy>[2],
): ReturnType<typeof runRuntimeTurnOrchestratedLegacy> {
  return runRuntimeTurnSerialized({
    body,
    queue: runtimeTurnSerialQueue,
    task: () => runRuntimeTurnOrchestratedLegacy(
      body,
      withAgentQualificationPersistence(
        withStaffRequestHandling(
          withDurableConversationContinuity(
            withAgentFirstTurnLocalConversationMemory(deps),
          ),
        ),
      ),
      opts,
    ),
  });
}
