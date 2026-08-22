import {
  createRuntimeTurnSerialQueue,
  runRuntimeTurnSerialized,
} from "./runtimeTurnSerialQueue.ts";
import { withDurableConversationContinuity } from "./runtimeConversationContinuity.ts";
import {
  runRuntimeTurnOrchestrated as runRuntimeTurnOrchestratedLegacy,
} from "./runtimeTurnOrchestratorLegacy.ts";
import {
  mergeAgentQualification,
  parseStoredAgentQualification,
  type AgentQualificationState,
} from "./agentQualification.ts";

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
 * Agent-first qualification persistence adapter around the frozen legacy orchestrator.
 *
 * The main agent produces a validated qualification update. This adapter captures it from
 * runTurn, reads the previously persisted qualification only when a new update exists, merges
 * both deterministically, then injects the merged state into the legacy orchestrator's existing
 * single rpc_merge_conversation_state write under collected.agent_qualification.
 *
 * No second model, table, RPC or extra state-machine path is introduced.
 */
export function withAgentQualificationPersistence(
  deps: Parameters<typeof runRuntimeTurnOrchestratedLegacy>[1],
): Parameters<typeof runRuntimeTurnOrchestratedLegacy>[1] {
  let capturedQualification: AgentQualificationState | null = null;

  const runtimeTurnService = {
    async runTurn(input: Parameters<typeof deps.runtimeTurnService.runTurn>[0]) {
      const result = await deps.runtimeTurnService.runTurn(input);
      capturedQualification = result.qualification ?? null;
      return result;
    },
  };

  if (!deps.turnPersistenceRepository) {
    return { ...deps, runtimeTurnService };
  }

  const originalPersistence = deps.turnPersistenceRepository;
  const turnPersistenceRepository = {
    ...originalPersistence,
    async mergeConversationState(
      input: Parameters<typeof originalPersistence.mergeConversationState>[0],
    ) {
      if (!capturedQualification || !deps.runtimeContextRepository) {
        return originalPersistence.mergeConversationState(input);
      }

      let previousQualification: AgentQualificationState | null = null;
      try {
        const contextResult = await deps.runtimeContextRepository.loadRuntimeContext({
          clinic_id: input.clinic_id,
          contact_id: input.contact_id,
        });
        if (!contextResult.ok) {
          // Preserve the prior durable state rather than risking a partial overwrite.
          return originalPersistence.mergeConversationState(input);
        }
        const conversationState = asRecord(contextResult.data.conversation_state);
        const collected = asRecord(conversationState.collected);
        previousQualification = parseStoredAgentQualification(collected.agent_qualification);
      } catch {
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
      withAgentQualificationPersistence(withDurableConversationContinuity(deps)),
      opts,
    ),
  });
}
