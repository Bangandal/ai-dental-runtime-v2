import type {
  AgentUiActions,
  BookingApplyResolution,
  OpenAIRuntimeAgent,
  RuntimeAgentToolRequest,
  RuntimeAgentToolResult,
  RuntimeAgentTurnInput,
  RuntimeAgentTurnResult,
} from "./openaiRuntimeAgent.ts";
import {
  createDentalRuntimeAgent,
  type CreateDentalRuntimeAgentDeps,
} from "./dentalRuntimeAgentFactory.ts";
import type {
  BookingSubjectsState,
  SubjectId,
  SubjectIntent,
  PhoneOwnershipIntent,
} from "./bookingSubjectsState.ts";
import type { AgentQualificationState } from "./agentQualification.ts";

export type RuntimeTurnInput = RuntimeAgentTurnInput;

export interface RuntimeTurnResult {
  final_patient_reply: string;
  conversation_id?: string | null;
  conversation_id_resumable?: boolean;
  tool_requests: RuntimeAgentToolRequest[];
  tool_results: RuntimeAgentToolResult[];
  debug?: Record<string, unknown>;
  ui?: AgentUiActions;
  subject_intent?: SubjectIntent | null;
  phone_ownership_intent?: PhoneOwnershipIntent | null;
  execution_subject_id?: SubjectId | null;
  booking_subjects_after_resolution?: BookingSubjectsState | null;
  booking_apply_resolution?: BookingApplyResolution | null;
  qualification?: AgentQualificationState | null;
}

export interface RuntimeTurnService {
  runTurn(input: RuntimeTurnInput): Promise<RuntimeTurnResult>;
}

export interface CreateRuntimeTurnServiceDeps {
  agent: OpenAIRuntimeAgent;
  /**
   * Opt in only when the model caller guarantees one HTTP attempt for the first
   * stateful conversation mutation. Generic Runtime agents fail closed by default.
   */
  single_attempt_first_call_rate_limit_safe?: boolean;
}

export interface RuntimeTurnNormalizationPolicy {
  single_attempt_first_call_rate_limit_safe?: boolean;
}

export function createRuntimeTurnService(deps: CreateRuntimeTurnServiceDeps): RuntimeTurnService {
  return {
    async runTurn(input: RuntimeTurnInput): Promise<RuntimeTurnResult> {
      const result = await deps.agent.runTurn(input);
      return normalizeRuntimeTurnResult(result, {
        single_attempt_first_call_rate_limit_safe:
          deps.single_attempt_first_call_rate_limit_safe === true,
      });
    },
  };
}

export function createDentalRuntimeTurnService(deps: CreateDentalRuntimeAgentDeps): RuntimeTurnService {
  const agent = createDentalRuntimeAgent(deps);
  // createDentalRuntimeAgent wires createStatefulAgentResponsesClient, which forces
  // maxRetries=0 on the stateful Responses call. That concrete guarantee is what
  // authorizes the narrow first-call 429 continuity exception below.
  return createRuntimeTurnService({
    agent,
    single_attempt_first_call_rate_limit_safe: true,
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isRateLimitMarker(value: unknown): boolean {
  if (value === 429) return true;
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "429" || normalized === "rate_limit_exceeded";
}

/**
 * Detects the narrow result shape that is eligible for first-call 429 continuity.
 * This function intentionally does not decide whether the caller was single-attempt;
 * that execution guarantee is supplied separately as RuntimeTurnNormalizationPolicy.
 *
 * Later-call failures are excluded: after a model-emitted tool request there may be
 * a pending function_call without its output, so those conversations must stay dirty.
 */
export function shouldPreserveConversationAfterFirstCallRateLimit(
  result: RuntimeAgentTurnResult,
): boolean {
  if (result.conversation_id_resumable !== false) return false;
  if (typeof result.conversation_id !== "string" || result.conversation_id.length === 0) return false;
  if (result.tool_requests.length > 0 || result.tool_results.length > 0) return false;

  const debug = asRecord(result.debug);
  if (debug?.reason !== "agent_first_call_exception") return false;

  const callerException = asRecord(debug.caller_exception);
  if (callerException?.stage !== "first_call") return false;

  // Provider/API error codes and HTTP status are independent facts. For example,
  // OpenAI can report code="insufficient_quota" with status=429.
  return isRateLimitMarker(callerException.error_code)
    || isRateLimitMarker(callerException.http_status);
}

export function normalizeRuntimeTurnResult(
  result: RuntimeAgentTurnResult,
  policy: RuntimeTurnNormalizationPolicy = {},
): RuntimeTurnResult {
  const finalPatientReply = result.final_patient_reply?.trim();
  if (!finalPatientReply) {
    throw new Error("runtime_turn_result_missing_final_patient_reply");
  }

  const preserveAfterRateLimit =
    policy.single_attempt_first_call_rate_limit_safe === true &&
    shouldPreserveConversationAfterFirstCallRateLimit(result);

  return {
    final_patient_reply: finalPatientReply,
    conversation_id: result.conversation_id,
    conversation_id_resumable: preserveAfterRateLimit
      ? true
      : result.conversation_id_resumable,
    tool_requests: result.tool_requests,
    tool_results: result.tool_results,
    debug: result.debug,
    ...(result.ui !== undefined ? { ui: result.ui } : {}),
    ...(result.subject_intent !== undefined ? { subject_intent: result.subject_intent } : {}),
    ...(result.phone_ownership_intent !== undefined ? { phone_ownership_intent: result.phone_ownership_intent } : {}),
    ...(result.execution_subject_id !== undefined ? { execution_subject_id: result.execution_subject_id } : {}),
    ...(result.booking_subjects_after_resolution !== undefined ? { booking_subjects_after_resolution: result.booking_subjects_after_resolution } : {}),
    ...(result.booking_apply_resolution !== undefined ? { booking_apply_resolution: result.booking_apply_resolution } : {}),
    ...(result.qualification !== undefined ? { qualification: result.qualification } : {}),
  };
}
