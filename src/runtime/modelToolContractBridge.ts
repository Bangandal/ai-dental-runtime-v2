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

const SELECT_SLOT_MODEL_DESCRIPTION =
  "Confirm the active patient's slot choice against active availability evidence. Call this with the exact date and time the patient affirmatively selected. Returns selection_status='selected' when the slot is in active evidence, or a failure reason otherwise. Does NOT create a visit or call ClinicCard. The runtime binds the selection to the active patient; do not provide an internal patient/subject identifier. Call booking.apply only after this tool returns selection_status='selected'.";

const BOOKING_APPLY_MODEL_DESCRIPTION =
  "Create a visit in ClinicCard for the intended patient when required booking details are present, slot selection is verified, and runtime has an acceptable booking contact. Set patient_target='self' when the sender is the patient, or patient_target='other_person' when booking for another person. Runtime owns the internal patient/subject identifier. Returns booking_status indicating whether the visit was created or why it could not be.";

const APPOINTMENT_LOOKUP_MODEL_DESCRIPTION =
  "Look up upcoming appointments for the intended patient. Set patient_target='self' for the sender's appointments, or patient_target='other_person' for another person's appointments. Runtime owns the internal patient/subject identifier. Read-only: does not create, cancel, or modify visits.";

const PATIENT_TARGET_SCHEMA: Record<string, unknown> = {
  type: "string",
  enum: ["self", "other_person"],
  description: "Business-semantic patient target: self for the sender/patient, other_person for another person. Runtime resolves the internal patient identity.",
};

const VALID_INTERNAL_SUBJECT_RE = /^subject_[1-4]$/;
export const INVALID_SEMANTIC_SUBJECT_ID = "__patient_target_conflict__";

type PatientTarget = "self" | "other_person";

function usesSemanticPatientTarget(toolName: ActiveRuntimeToolName): boolean {
  return toolName === "booking.apply" || toolName === "appointment.lookup";
}

/**
 * Project an internal runtime tool contract into the smaller business-semantic contract
 * exposed to the model. Technical subject IDs remain an internal compatibility detail.
 */
export function projectModelToolContract(
  toolName: ActiveRuntimeToolName,
  definition: InternalToolContract,
): ModelToolContract {
  const semanticPatientTarget = usesSemanticPatientTarget(toolName);
  const removesSubjectId = toolName === "booking.select_slot" || semanticPatientTarget;
  const requiredArgs = removesSubjectId
    ? definition.required_args.filter((arg) => arg !== "subject_id")
    : [...definition.required_args];
  const optionalArgs = removesSubjectId
    ? definition.optional_args.filter((arg) => arg !== "subject_id")
    : [...definition.optional_args];

  const projectedRequiredArgs = semanticPatientTarget
    ? ["patient_target", ...requiredArgs]
    : requiredArgs;

  const description = toolName === "booking.select_slot"
    ? SELECT_SLOT_MODEL_DESCRIPTION
    : toolName === "booking.apply"
      ? BOOKING_APPLY_MODEL_DESCRIPTION
      : toolName === "appointment.lookup"
        ? APPOINTMENT_LOOKUP_MODEL_DESCRIPTION
        : definition.description;

  const paramSchemas = semanticPatientTarget
    ? { ...(definition.param_schemas ?? {}), patient_target: PATIENT_TARGET_SCHEMA }
    : definition.param_schemas;

  return {
    description,
    required_args: projectedRequiredArgs,
    optional_args: optionalArgs,
    ...(paramSchemas ? { param_schemas: paramSchemas } : {}),
  };
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Read the runtime-owned active legacy subject from model-visible context.
 * This is deliberately the only place the OpenAI boundary needs to know that
 * booking_subjects still carries an internal subject_N identifier.
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
 * Translate already-parsed model tool requests back into the existing deterministic
 * runtime contract. This is the quarantine seam for legacy subject_N plumbing.
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
