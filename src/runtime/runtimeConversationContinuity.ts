import type { RuntimeContext } from "./supabaseRuntimeContextRepository.ts";
import type { RuntimeTurnOrchestratorDeps } from "./runtimeTurnOrchestratorLegacy.ts";

export function hasPriorDurablePatientTurn(context: RuntimeContext): boolean {
  const turnCount = context.conversation_state.turn_count;
  if (typeof turnCount === "number" && Number.isFinite(turnCount) && turnCount > 0) {
    return true;
  }

  const recentHistoryCount =
    context.runtime_flags.available_recent_history_count ?? context.recent_history.length;
  // The current inbound message is persisted before RuntimeContext is loaded, so a
  // single recent-history item can still be the genuine first patient turn. More
  // than one item proves that dialogue existed before the current inbound message.
  if (recentHistoryCount > 1) {
    return true;
  }

  if (context.booking_subjects !== null || context.selected_slot_starts_at !== null) {
    return true;
  }

  return false;
}

export function withDurableConversationContinuity(
  deps: RuntimeTurnOrchestratorDeps,
): RuntimeTurnOrchestratorDeps {
  let priorDurablePatientTurn = false;

  const runtimeContextRepository = deps.runtimeContextRepository
    ? {
        async loadRuntimeContext(input: Parameters<NonNullable<RuntimeTurnOrchestratorDeps["runtimeContextRepository"]>["loadRuntimeContext"]>[0]) {
          const result = await deps.runtimeContextRepository!.loadRuntimeContext(input);
          if (result.ok) {
            priorDurablePatientTurn = hasPriorDurablePatientTurn(result.data);
          }
          return result;
        },
      }
    : undefined;

  return {
    ...deps,
    ...(runtimeContextRepository ? { runtimeContextRepository } : {}),
    runtimeTurnService: {
      async runTurn(input) {
        const correctedInput =
          input.is_first_patient_turn === true && priorDurablePatientTurn
            ? { ...input, is_first_patient_turn: false }
            : input;
        return deps.runtimeTurnService.runTurn(correctedInput);
      },
    },
  };
}
