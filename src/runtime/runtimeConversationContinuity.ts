import type { RuntimeContext } from "./supabaseRuntimeContextRepository.ts";

/**
 * Durable first-turn authority. The current inbound is persisted before context is loaded,
 * so one history item can still represent the genuine first patient turn.
 */
export function hasPriorDurablePatientTurn(context: RuntimeContext): boolean {
  const turnCount = context.conversation_state.turn_count;
  if (typeof turnCount === "number" && Number.isFinite(turnCount) && turnCount > 0) {
    return true;
  }

  const recentHistoryCount =
    context.runtime_flags.available_recent_history_count ?? context.recent_history.length;
  if (recentHistoryCount > 1) return true;

  if (context.booking_subjects !== null || context.selected_slot_starts_at !== null) {
    return true;
  }

  return false;
}
