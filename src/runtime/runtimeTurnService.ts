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
}

export interface RuntimeTurnService {
  runTurn(input: RuntimeTurnInput): Promise<RuntimeTurnResult>;
}

export interface CreateRuntimeTurnServiceDeps {
  agent: OpenAIRuntimeAgent;
}

export function createRuntimeTurnService(deps: CreateRuntimeTurnServiceDeps): RuntimeTurnService {
  return {
    async runTurn(input: RuntimeTurnInput): Promise<RuntimeTurnResult> {
      const result = await deps.agent.runTurn(input);
      return normalizeRuntimeTurnResult(result);
    },
  };
}

export function createDentalRuntimeTurnService(deps: CreateDentalRuntimeAgentDeps): RuntimeTurnService {
  const agent = createDentalRuntimeAgent(deps);
  return createRuntimeTurnService({ agent });
}

export function normalizeRuntimeTurnResult(result: RuntimeAgentTurnResult): RuntimeTurnResult {
  const finalPatientReply = result.final_patient_reply?.trim();
  if (!finalPatientReply) {
    throw new Error("runtime_turn_result_missing_final_patient_reply");
  }

  return {
    final_patient_reply: finalPatientReply,
    conversation_id: result.conversation_id,
    conversation_id_resumable: result.conversation_id_resumable,
    tool_requests: result.tool_requests,
    tool_results: result.tool_results,
    debug: result.debug,
    ...(result.ui !== undefined ? { ui: result.ui } : {}),
    ...(result.subject_intent !== undefined ? { subject_intent: result.subject_intent } : {}),
    ...(result.phone_ownership_intent !== undefined ? { phone_ownership_intent: result.phone_ownership_intent } : {}),
    ...(result.execution_subject_id !== undefined ? { execution_subject_id: result.execution_subject_id } : {}),
    ...(result.booking_subjects_after_resolution !== undefined ? { booking_subjects_after_resolution: result.booking_subjects_after_resolution } : {}),
    ...(result.booking_apply_resolution !== undefined ? { booking_apply_resolution: result.booking_apply_resolution } : {}),
  };
}
