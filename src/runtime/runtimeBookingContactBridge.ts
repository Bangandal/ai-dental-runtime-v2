import type { RuntimeAgentTurnInput } from "./openaiRuntimeAgent.ts";
import type { SubjectId } from "./bookingSubjectsState.ts";
import {
  resolveLegacyBookingExecutionContact,
} from "./legacyBookingSubjectsAdapter.ts";

/**
 * Temporary runtime bridge while booking.apply still targets legacy subject ids.
 * All legacy contact selection and ownership rules live behind the adapter; callers
 * receive only execution fields understood by the booking kernel.
 */
export function buildRuntimeBookingContactFields(
  input: RuntimeAgentTurnInput,
  executionSubjectId?: SubjectId | null,
): {
  phone_number: string | undefined;
  phone_source: string | undefined;
  phone_trust: "unverified" | undefined;
  phone_belongs_to_patient: boolean | undefined;
} {
  return resolveLegacyBookingExecutionContact({
    booking_subjects: input.booking_subjects ?? null,
    target_subject_id: executionSubjectId ?? null,
    channel_contact: input.channel_contact ?? null,
    provided_phone: input.provided_phone ?? null,
    had_booking_subjects: input.had_booking_subjects,
    current_turn_typed_phone: input.current_turn_typed_phone ?? null,
  });
}

export function hasRuntimeBookingContact(
  input: RuntimeAgentTurnInput,
  executionSubjectId?: SubjectId | null,
): boolean {
  return buildRuntimeBookingContactFields(input, executionSubjectId).phone_number != null;
}
