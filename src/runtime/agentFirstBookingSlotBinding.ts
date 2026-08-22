import { isAgentFirstRuntimeEnabled } from "./agentFirstRuntimePolicy.ts";
import {
  executeBookingSelectSlot,
  type BookingSelectSlotSuccessData,
} from "./bookingSelectSlot.ts";
import {
  isAvailabilityEvidenceFresh,
  type BookingProcessState,
} from "./bookingProcessState.ts";
import type { RuntimeAgentToolRequest } from "./openaiRuntimeAgent.ts";
import type { SubjectId } from "./bookingSubjectsState.ts";

/**
 * Agent-first compatibility seam for the old model-facing booking.select_slot ceremony.
 *
 * The model may call booking.apply directly after the patient chose an exact slot. Runtime
 * derives the same internal selection proof only when all old deterministic conditions are
 * still true: a frozen execution subject exists, availability evidence is fresh, and the
 * requested date/time exactly belongs to that evidence.
 *
 * This does not authorize a write by itself. The returned selection is fed back through the
 * existing BookingProcessState proof builder and then through the unchanged booking preflight.
 */
export function deriveAgentFirstBookingSelection(params: {
  booking_apply: RuntimeAgentToolRequest;
  execution_subject_id: SubjectId | null;
  booking_process_state: BookingProcessState;
  subjects?: Array<{ id: SubjectId }> | null;
  now: Date;
}): BookingSelectSlotSuccessData | null {
  if (!isAgentFirstRuntimeEnabled()) return null;
  if (params.booking_apply.tool !== "booking.apply") return null;
  if (!params.execution_subject_id) return null;

  const evidence = params.booking_process_state.active_availability_evidence;
  if (!isAvailabilityEvidenceFresh(evidence, params.now)) return null;

  const selection = executeBookingSelectSlot(
    {
      ...params.booking_apply.arguments,
      subject_id: params.execution_subject_id,
    },
    evidence,
    params.subjects ?? null,
  );

  return selection.ok ? selection.data : null;
}
