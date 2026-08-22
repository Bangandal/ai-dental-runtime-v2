from pathlib import Path
import re

path = Path("src/runtime/runtimeAgentLoopLegacy.ts")
source = path.read_text()

if 'import { prepareBookingApplyExecution } from "./bookingApplyExecutionPreparation.ts";' in source:
    raise SystemExit(0)

source, count = re.subn(
    r'import \{ resolveBookingExecutionSubject \} from "\.\/bookingSubjectExecutionResolver\.ts";\n'
    r'import \{ bootstrapRegistryFromBookingApplyArgs, parseSubjectTarget \} from "\.\/bookingSubjectsState\.ts";\n'
    r'import type \{ SubjectId, BookingSubjectsState \} from "\.\/bookingSubjectsState\.ts";',
    'import { prepareBookingApplyExecution } from "./bookingApplyExecutionPreparation.ts";\n'
    'import type { SubjectId, BookingSubjectsState } from "./bookingSubjectsState.ts";',
    source,
)
assert count == 1, f"import replacement count={count}"

round1_init = '''      // Prepare booking target independently of model-call round. Guard S below may still
      // intentionally ignore a target conflict while preserving a newly bootstrapped registry.
      const round1BookingPreparation = bookingApplyRound1
        ? prepareBookingApplyExecution({
            booking_apply: bookingApplyRound1,
            booking_subjects: input.booking_subjects ?? null,
            channel_contact: input.channel_contact ?? null,
            current_turn_typed_phone: input.current_turn_typed_phone ?? null,
          })
        : null;
      let effectiveBookingSubjects: BookingSubjectsState | null =
        round1BookingPreparation?.effective_booking_subjects ?? input.booking_subjects ?? null;
      let effectiveInput: RuntimeAgentTurnInput = effectiveBookingSubjects !== (input.booking_subjects ?? null)
        ? { ...input, booking_subjects: effectiveBookingSubjects }
        : input;
      // Non-null when preparation bootstrapped a new registry this turn; orchestrator persists it.
      // Updated again if a later tool batch bootstraps a registry.
      let bootstrappedRegistry: BookingSubjectsState | null =
        round1BookingPreparation?.bootstrapped_registry ?? null;

'''
source, count = re.subn(
    r'      // Bootstrap registry: when model targets subject_2\+ but no registry exists yet,\n.*?'
    r'      let bootstrappedRegistry: BookingSubjectsState \| null =\n'
    r'        effectiveInput !== input \? effectiveBookingSubjects : null;\n\n',
    round1_init,
    source,
    count=1,
    flags=re.S,
)
assert count == 1, f"round1 init replacement count={count}"

round1_guard = '''      // Guard J (first tool batch) — consume the shared preparation result only after
      // Guard S has had priority. This preserves historical same-batch select/apply behavior.
      let round1ExecutionSubjectId: SubjectId | null = null;
      if (!guardSFired && bookingApplyRound1 && round1BookingPreparation) {
        if (!round1BookingPreparation.ok) {
          debug.reason = round1BookingPreparation.stage === "subject_validation"
            ? "booking_apply_preflight_subject_id_invalid_round1"
            : "booking_apply_preflight_subject_resolution_conflict_round1";
          return await finalizeBlockedBookingApplyWithToolOutput({
            pendingBookingApply: bookingApplyRound1,
            guardedData: {
              booking_status: "subject_resolution_conflict",
              created_visit: false,
              may_claim_booked: false,
              required_next_action: "clarify_subject",
              reason: round1BookingPreparation.reason,
            },
            previousToolResults: [],
            toolRequests: processedToolRequests,
            conversationId,
            systemInstruction,
            callerContext,
            input,
            debug,
            deps,
            booking_subjects_after_resolution: bootstrappedRegistry,
          });
        }
        round1ExecutionSubjectId = round1BookingPreparation.execution_subject_id;
      }

'''
source, count = re.subn(
    r'      // Guard J \(round 1\).*?\n'
    r'      // Shared booking business preflight \(round 1\)',
    round1_guard + '      // Shared booking business preflight (round 1)',
    source,
    count=1,
    flags=re.S,
)
assert count == 1, f"round1 guard replacement count={count}"

round2_guard = '''        // 3. Prepare/freeze booking target through the same round-agnostic boundary used
        // by the first tool batch. Multiple-write guards above intentionally retain priority.
        let round2ExecutionSubjectId: SubjectId | null = null;
        if (pendingBookingApply) {
          const round2BookingPreparation = prepareBookingApplyExecution({
            booking_apply: pendingBookingApply,
            booking_subjects: effectiveBookingSubjects,
            channel_contact: input.channel_contact ?? null,
            current_turn_typed_phone: input.current_turn_typed_phone ?? null,
          });

          effectiveBookingSubjects = round2BookingPreparation.effective_booking_subjects;
          effectiveInput = effectiveBookingSubjects !== (input.booking_subjects ?? null)
            ? { ...input, booking_subjects: effectiveBookingSubjects }
            : input;
          if (round2BookingPreparation.bootstrapped_registry) {
            bootstrappedRegistry = round2BookingPreparation.bootstrapped_registry;
          }

          if (!round2BookingPreparation.ok) {
            debug.reason = round2BookingPreparation.stage === "subject_validation"
              ? "booking_apply_preflight_subject_id_invalid_round2"
              : "booking_apply_preflight_subject_resolution_conflict_round2";
            return await finalizeBlockedBookingApplyWithToolOutput({
              pendingBookingApply,
              guardedData: {
                booking_status: "subject_resolution_conflict",
                created_visit: false,
                may_claim_booked: false,
                required_next_action: "clarify_subject",
                reason: round2BookingPreparation.reason,
              },
              previousToolResults: toolResults,
              toolRequests: processedToolRequests,
              conversationId,
              systemInstruction,
              callerContext,
              input,
              debug,
              deps,
              booking_subjects_after_resolution: bootstrappedRegistry,
            });
          }

          round2ExecutionSubjectId = round2BookingPreparation.execution_subject_id;
        }

'''
source, count = re.subn(
    r'        // 3\. Guard J \(round 2\).*?\n'
    r'        // PF-004b:',
    round2_guard + '        // PF-004b:',
    source,
    count=1,
    flags=re.S,
)
assert count == 1, f"round2 guard replacement count={count}"

source = source.replace(
    'frozen subject id from resolveBookingExecutionSubject(); overrides active_subject_id',
    'frozen subject id from booking.apply preparation; overrides active_subject_id',
)

path.write_text(source)
