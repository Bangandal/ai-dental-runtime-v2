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

export type RuntimeAgentLoopFactory = (
  deps: CreateRuntimeAgentLoopDeps,
) => OpenAIRuntimeAgent;

interface CapturedBookingTarget {
  execution_input: RuntimeAgentTurnInput;
  execution_subject_id: SubjectId | null;
}

function findSingleBookingApply(
  requests: RuntimeAgentToolRequest[],
): RuntimeAgentToolRequest | null {
  const bookingRequests = requests.filter((request) => request.tool === "booking.apply");
  return bookingRequests.length === 1 ? bookingRequests[0] : null;
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
 * The legacy loop may still calculate phone fields internally, but immediately
 * before booking.apply reaches its executor we replace those fields with the
 * semantic projection from runtimeBookingContactBridge. This makes explicit
 * ownership authoritative without sharing mutable state across concurrent turns.
 */
export function createRuntimeAgentWithBookingContactBridge(
  deps: CreateRuntimeAgentLoopDeps,
  loopFactory: RuntimeAgentLoopFactory = createRuntimeAgentLoop,
): OpenAIRuntimeAgent {
  return {
    async runTurn(input: RuntimeAgentTurnInput) {
      let captured: CapturedBookingTarget = {
        execution_input: input,
        execution_subject_id: null,
      };

      const caller: RuntimeAgentCaller = async (callerInput) => {
        const output = await deps.caller(callerInput);
        if (output.type === "tool_requests") {
          captured = captureBookingExecutionTarget(captured, input, output.tool_requests);
        }
        return output;
      };

      const originalBookingExecutor = deps.executors["booking.apply"];
      const executors = { ...deps.executors };

      if (originalBookingExecutor) {
        executors["booking.apply"] = async (context) => {
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
      return loop.runTurn(input);
    },
  };
}
