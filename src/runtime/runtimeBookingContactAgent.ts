import type {
  OpenAIRuntimeAgent,
  RuntimeAgentToolRequest,
  RuntimeAgentTurnInput,
} from "./openaiRuntimeAgent.ts";
import {
  createRuntimeAgentLoop,
  type CreateRuntimeAgentLoopDeps,
  type RuntimeAgentCaller,
} from "./runtimeAgentLoop.ts";
import {
  bootstrapRegistryFromBookingApplyArgs,
  parseStrictSubjectId,
  type SubjectId,
} from "./bookingSubjectsState.ts";
import {
  buildRuntimeBookingContactFields,
} from "./runtimeBookingContactBridge.ts";
import type { AgentQualificationState } from "./agentQualification.ts";

export type RuntimeAgentLoopFactory = (
  deps: CreateRuntimeAgentLoopDeps,
) => OpenAIRuntimeAgent;

export interface CapturedBookingTarget {
  execution_input: RuntimeAgentTurnInput;
  execution_subject_id: SubjectId | null;
}

export interface SameBatchBookingStage {
  booking_apply: RuntimeAgentToolRequest;
  select_slot_call_id: string;
  forwarded_requests: RuntimeAgentToolRequest[];
}

function findSingleBookingApply(
  requests: RuntimeAgentToolRequest[],
): RuntimeAgentToolRequest | null {
  const bookingRequests = requests.filter((request) => request.tool === "booking.apply");
  return bookingRequests.length === 1 ? bookingRequests[0] : null;
}

/**
 * Returns a deterministic staging plan only for the unambiguous same-person case:
 * exactly one booking.select_slot and exactly one booking.apply with matching strict
 * subject ids. Everything else stays on the legacy fail-closed path unchanged.
 *
 * The booking.apply request is not changed. It is only replayed to the legacy loop after
 * that exact select_slot call has produced a tool result, so the existing slot-proof,
 * identity, policy, lock and write guards remain authoritative.
 */
export function buildSameBatchBookingStage(
  requests: RuntimeAgentToolRequest[],
): SameBatchBookingStage | null {
  const selectRequests = requests.filter((request) => request.tool === "booking.select_slot");
  const bookingRequests = requests.filter((request) => request.tool === "booking.apply");

  if (selectRequests.length !== 1 || bookingRequests.length !== 1) return null;

  const selectRequest = selectRequests[0];
  const bookingRequest = bookingRequests[0];
  if (selectRequest.call_id === bookingRequest.call_id) return null;

  const selectSubjectId = parseStrictSubjectId(selectRequest.arguments.subject_id);
  const bookingSubjectId = parseStrictSubjectId(bookingRequest.arguments.subject_id);
  if (!selectSubjectId || !bookingSubjectId || selectSubjectId !== bookingSubjectId) return null;

  return {
    booking_apply: bookingRequest,
    select_slot_call_id: selectRequest.call_id,
    forwarded_requests: requests.filter((request) => request.call_id !== bookingRequest.call_id),
  };
}

/**
 * Mirror only the legacy bootstrap needed to know which person's contact is being
 * used for booking execution. The authoritative subject validation still remains
 * inside runtimeAgentLoop; this bridge never makes a booking legal by itself.
 */
export function captureBookingExecutionTarget(
  current: CapturedBookingTarget,
  input: RuntimeAgentTurnInput,
  requests: RuntimeAgentToolRequest[],
): CapturedBookingTarget {
  const bookingRequest = findSingleBookingApply(requests);
  if (!bookingRequest) {
    return requests.some((request) => request.tool === "booking.apply")
      ? { ...current, execution_subject_id: null }
      : current;
  }

  const subjectId = parseStrictSubjectId(bookingRequest.arguments.subject_id);
  if (!subjectId) {
    return { ...current, execution_subject_id: null };
  }

  let executionInput = current.execution_input;
  if (!executionInput.booking_subjects) {
    const bootstrapped = bootstrapRegistryFromBookingApplyArgs(
      bookingRequest.arguments,
      input.channel_contact ?? null,
      input.current_turn_typed_phone ?? null,
    );
    if (bootstrapped) {
      executionInput = { ...executionInput, booking_subjects: bootstrapped };
    }
  }

  return {
    execution_input: executionInput,
    execution_subject_id: subjectId,
  };
}

/**
 * Per-turn compatibility shell around the legacy Runtime loop.
 *
 * Responsibilities kept at this boundary:
 * 1. preserve semantic phone ownership immediately before booking.apply writes;
 * 2. collapse the safe same-batch select_slot + booking.apply case without asking the
 *    model to make the same booking decision again;
 * 3. carry validated agent-first qualification state around the frozen legacy loop.
 *
 * The shell never authorizes a booking itself. It only replays the exact already-issued
 * booking.apply after the matching select_slot result exists. The legacy Runtime still
 * owns subject validation, slot proof, schedule policy, identity checks, locking and writes.
 */
export function createRuntimeAgentWithBookingContactBridge(
  deps: CreateRuntimeAgentLoopDeps,
  loopFactory: RuntimeAgentLoopFactory = createRuntimeAgentLoop,
): OpenAIRuntimeAgent {
  return {
    async runTurn(input: RuntimeAgentTurnInput) {
      // This object is private to one runTurn. It may receive a legacy bootstrap after the
      // first model response so select_slot for subject_2+ sees the same registry that the
      // booking write boundary already uses. Nothing is shared across concurrent turns.
      const loopInput: RuntimeAgentTurnInput = { ...input };

      let captured: CapturedBookingTarget = {
        execution_input: loopInput,
        execution_subject_id: null,
      };
      let stagedBooking: SameBatchBookingStage | null = null;
      let capturedQualification: AgentQualificationState | null = null;

      const caller: RuntimeAgentCaller = async (callerInput) => {
        if (
          stagedBooking
          && Array.isArray(callerInput.input.tool_results)
          && callerInput.input.tool_results.some(
            (result) => result.tool === "booking.select_slot"
              && result.call_id === stagedBooking?.select_slot_call_id,
          )
        ) {
          const request = stagedBooking.booking_apply;
          stagedBooking = null;
          return {
            type: "tool_requests",
            conversation_id: callerInput.conversation_id,
            tool_requests: [request],
          };
        }

        const output = await deps.caller(callerInput);
        if (output.type === "tool_requests") {
          captured = captureBookingExecutionTarget(captured, loopInput, output.tool_requests);

          const nextStage = buildSameBatchBookingStage(output.tool_requests);
          if (nextStage) {
            stagedBooking = nextStage;

            // For subject_2+ the legacy loop normally bootstraps from booking.apply before
            // processing select_slot. Because booking.apply is staged here, mirror that exact
            // already-existing bootstrap into the private loop input before control returns.
            if (captured.execution_input.booking_subjects && !loopInput.booking_subjects) {
              loopInput.booking_subjects = captured.execution_input.booking_subjects;
            }

            return {
              ...output,
              tool_requests: nextStage.forwarded_requests,
            };
          }
        } else if (output.final_response.qualification != null) {
          capturedQualification = output.final_response.qualification;
        }
        return output;
      };

      const originalBookingExecutor = deps.executors["booking.apply"];
      const executors = { ...deps.executors };

      if (originalBookingExecutor) {
        executors["booking.apply"] = async (context) => {
          if (!captured.execution_subject_id) {
            return originalBookingExecutor({
              ...context,
              phone_number: undefined,
              phone_source: undefined,
              phone_trust: undefined,
              phone_belongs_to_patient: undefined,
              contact_phone_owner_subject_id: undefined,
            });
          }

          const contact = buildRuntimeBookingContactFields(
            captured.execution_input,
            captured.execution_subject_id,
          );

          return originalBookingExecutor({
            ...context,
            phone_number: contact.phone_number,
            phone_source: contact.phone_source,
            phone_trust: contact.phone_trust,
            phone_belongs_to_patient: contact.phone_belongs_to_patient,
            // Explicit semantic ownership is authoritative from this point forward.
            contact_phone_owner_subject_id: undefined,
          });
        };
      }

      const loop = loopFactory({
        ...deps,
        caller,
        executors,
      });
      const result = await loop.runTurn(loopInput);
      return capturedQualification
        ? { ...result, qualification: capturedQualification }
        : result;
    },
  };
}
