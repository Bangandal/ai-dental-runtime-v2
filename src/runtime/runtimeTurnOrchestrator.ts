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
 * Agent-first qualification persistence adapter around the frozen legacy orchestrator.
 *
 * The main agent produces a validated qualification update. The adapter captures the
 * qualification already present in the RuntimeContext snapshot loaded at turn start and
 * deterministically merges the model update into the legacy orchestrator's existing
 * rpc_merge_conversation_state write. It never performs a second RuntimeContext read.
 */
export function withAgentQualificationPersistence(
  deps: Parameters<typeof runRuntimeTurnOrchestratedLegacy>[1],
): Parameters<typeof runRuntimeTurnOrchestratedLegacy>[1] {
  let capturedQualification: AgentQualificationState | null = null;
  let capturedStaffRequest: RuntimeTurnResult["staff_request_state"];
  let previousQualification: AgentQualificationState | null = null;
  let runtimeContextLoaded = deps.runtimeContextRepository == null;

  const runtimeContextRepository = deps.runtimeContextRepository
    ? {
        async loadRuntimeContext(
          input: Parameters<typeof deps.runtimeContextRepository.loadRuntimeContext>[0],
        ) {
          const result = await deps.runtimeContextRepository!.loadRuntimeContext(input);
          runtimeContextLoaded = result.ok;
          if (result.ok) {
            const conversationState = asRecord(result.data.conversation_state);
            const collected = asRecord(conversationState.collected);
            previousQualification = parseStoredAgentQualification(collected.agent_qualification);
          }
          return result;
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
      if (capturedStaffRequest?.proof.request_saved) {
        const flags = asRecord(input.control_flags);
        input = {
          ...input,
          control_flags: { ...flags, collected: {
            ...asRecord(flags.collected),
            agent_staff_request: capturedStaffRequest,
          } },
        };
      }
      if (!capturedQualification || !runtimeContextLoaded) {
        return originalPersistence.mergeConversationState(input);
      }

      const mergedQualification = mergeAgentQualification(
        previousQualification,
        capturedQualification,
      );
      if (!mergedQualification) {
        return originalPersistence.mergeConversationState(input);
      }

      const controlFlags = asRecord(input.control_flags);
      const collectedPatch = asRecord(controlFlags.collected);

      return originalPersistence.mergeConversationState({
        ...input,
        control_flags: {
          ...controlFlags,
          collected: {
            ...collectedPatch,
            agent_qualification: mergedQualification,
          },
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
