import {
  ACTIVE_RUNTIME_AGENT_TOOLS,
  type RuntimeAgentToolRequest,
} from "./openaiRuntimeAgent.ts";

export type ActiveRuntimeToolName = (typeof ACTIVE_RUNTIME_AGENT_TOOLS)[number];

export interface InternalToolContract {
  description: string;
  required_args: readonly string[];
  optional_args: readonly string[];
  param_schemas?: Record<string, Record<string, unknown>>;
}

export interface ModelToolContract {
  description: string;
  required_args: string[];
  optional_args: string[];
  param_schemas?: Record<string, Record<string, unknown>>;
}

const VALID_INTERNAL_SUBJECT_RE = /^subject_[1-4]$/;
export const INVALID_SEMANTIC_SUBJECT_ID = "__patient_target_conflict__";

type PatientTarget = "self" | "other_person";

/**
 * The canonical runtime tool definitions are already business-semantic.
 * Keep this boundary as a detached copy so the OpenAI adapter does not own schemas,
 * while all semantic-to-legacy translation remains on the response path below.
 */
export function projectModelToolContract(
  _toolName: ActiveRuntimeToolName,
  definition: InternalToolContract,
): ModelToolContract {
  return {
    description: definition.description,
    required_args: [...definition.required_args],
    optional_args: [...definition.optional_args],
    ...(definition.param_schemas ? { param_schemas: definition.param_schemas } : {}),
  };
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Read the runtime-owned active legacy subject from the private runtime context.
 * Technical subject IDs never need to be present in the serialized model payload.
 */
export function resolveActiveInternalSubjectId(context: Record<string, unknown>): string | null {
  const runtimeContext = asObject(context.runtime_context);
  const bookingSubjects = asObject(runtimeContext?.booking_subjects);
  const candidate = bookingSubjects?.active_subject_id;
  return typeof candidate === "string" && VALID_INTERNAL_SUBJECT_RE.test(candidate)
    ? candidate
    : null;
}

function readPatientTarget(args: Record<string, unknown>): { present: boolean; value: PatientTarget | null } {
  if (!Object.prototype.hasOwnProperty.call(args, "patient_target")) {
    return { present: false, value: null };
  }
  const value = args.patient_target;
  return {
    present: true,
    value: value === "self" || value === "other_person" ? value : null,
  };
}

function resolveSemanticPatientSubjectId(
  args: Record<string, unknown>,
  activeSubjectId: string | null,
): string | null {
  const target = readPatientTarget(args);

  // Hidden legacy calls keep their old internal subject semantics. New model schemas
  // always contain patient_target, so this branch exists only for compatibility.
  if (!target.present) {
    return typeof args.subject_id === "string" ? args.subject_id : null;
  }

  // Malformed semantic input cannot fall back to a model-supplied legacy ID.
  if (!target.value) return INVALID_SEMANTIC_SUBJECT_ID;

  if (!activeSubjectId) {
    // subject_2 is a compatibility bootstrap token. booking.apply may create the first
    // other-person registry; appointment.lookup will reject it when no registry exists.
    return target.value === "self" ? "subject_1" : "subject_2";
  }

  const activeIsSelf = activeSubjectId === "subject_1";
  const targetMatchesActive = target.value === "self" ? activeIsSelf : !activeIsSelf;
  return targetMatchesActive ? activeSubjectId : INVALID_SEMANTIC_SUBJECT_ID;
}

function bindSemanticPatientTarget(
  request: RuntimeAgentToolRequest,
  activeSubjectId: string | null,
): RuntimeAgentToolRequest {
  if (request.tool !== "booking.apply" && request.tool !== "appointment.lookup") return request;

  const target = readPatientTarget(request.arguments);
  if (!target.present) return request;

  const subjectId = resolveSemanticPatientSubjectId(request.arguments, activeSubjectId);
  const { patient_target: _patientTarget, subject_id: _modelSubjectId, ...businessArgs } = request.arguments;
  return {
    ...request,
    arguments: {
      ...businessArgs,
      subject_id: subjectId ?? INVALID_SEMANTIC_SUBJECT_ID,
    },
  };
}

/**
 * Translate already-parsed model tool requests into the existing deterministic kernel
 * contract. This is the single quarantine seam for remaining legacy subject_N plumbing.
 */
export function bindModelToolRequestsToInternalContract(
  requests: RuntimeAgentToolRequest[],
  activeSubjectId: string | null,
): RuntimeAgentToolRequest[] {
  const boundRequests = requests.map((request) =>
    bindSemanticPatientTarget(request, activeSubjectId));

  const batchApplySubjects = Array.from(new Set(
    boundRequests
      .filter((request) => request.tool === "booking.apply")
      .map((request) => request.arguments.subject_id)
      .filter((value): value is string => typeof value === "string" && VALID_INTERNAL_SUBJECT_RE.test(value)),
  ));
  const legacySelectSubjects = Array.from(new Set(
    boundRequests
      .filter((request) => request.tool === "booking.select_slot")
      .map((request) => request.arguments.subject_id)
      .filter((value): value is string => typeof value === "string" && VALID_INTERNAL_SUBJECT_RE.test(value)),
  ));

  // Existing active patient owns the flow. Without one, a single same-batch apply target
  // preserves first other-person bootstrap. Hidden legacy select targets remain compatible.
  const selectSlotSubjectId = activeSubjectId
    ?? (batchApplySubjects.length === 1
      ? batchApplySubjects[0]
      : legacySelectSubjects.length === 1
        ? legacySelectSubjects[0]
        : "subject_1");

  return boundRequests.map((request) => request.tool === "booking.select_slot"
    ? {
        ...request,
        arguments: { ...request.arguments, subject_id: selectSlotSubjectId },
      }
    : request);
}
