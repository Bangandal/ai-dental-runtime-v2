export type CaseRelation = "same_case" | "new_case" | "follow_up" | "reopen_case" | "no_case" | "unknown";
export type CaseAction = "open_case" | "reuse_case" | "no_case";
export type CaseType = "faq" | "booking_request" | "availability_request" | "admin_request" | "urgent" | "follow_up" | "reschedule" | "cancel" | "other";
export type CaseStatus = "open" | "collecting" | "waiting_patient" | "resolved" | "cancelled" | "closed" | null;
export type CasePriority = "low" | "normal" | "high" | "urgent";
export type CaseConfidence = "low" | "medium" | "high";

export interface CaseRouterDecision {
  case_relation: CaseRelation;
  case_action: CaseAction;
  case_type: CaseType;
  topic: string | null;
  status: CaseStatus;
  priority: CasePriority;
  confidence: CaseConfidence;
  reason: string;
  should_apply: false;
}

export interface CaseRouterDebug {
  enabled: true;
  mode: "shadow";
  classifier: "openai" | "fallback";
  decision: CaseRouterDecision;
  applied: false;
  error: Record<string, unknown> | null;
}
export interface CaseRouterClassifierInput {
  user_message: string;
  runtime_context: Record<string, unknown>;
}
export interface CaseRouterClassifier {
  classifyCaseTurn(input: CaseRouterClassifierInput): Promise<unknown>;
}

const RELATIONS: readonly CaseRelation[] = ["same_case", "new_case", "follow_up", "reopen_case", "no_case", "unknown"];
const ACTIONS: readonly CaseAction[] = ["open_case", "reuse_case", "no_case"];
const TYPES: readonly CaseType[] = ["faq", "booking_request", "availability_request", "admin_request", "urgent", "follow_up", "reschedule", "cancel", "other"];
const STATUSES: readonly Exclude<CaseStatus, null>[] = ["open", "collecting", "waiting_patient", "resolved", "cancelled", "closed"];
const PRIORITIES: readonly CasePriority[] = ["low", "normal", "high", "urgent"];
const CONFIDENCES: readonly CaseConfidence[] = ["low", "medium", "high"];

const FALLBACK_REASON = "shadow router fallback; classifier not connected";

export function buildFallbackCaseRouterDecision(reason = FALLBACK_REASON): CaseRouterDecision {
  return {
    case_relation: "unknown",
    case_action: "no_case",
    case_type: "other",
    topic: null,
    status: null,
    priority: "normal",
    confidence: "low",
    reason,
    should_apply: false,
  };
}

export function normalizeCaseRouterDecision(raw: unknown): CaseRouterDecision {
  const value = asRecord(raw);
  const fallback = buildFallbackCaseRouterDecision();
  return {
    case_relation: pickOne(RELATIONS, value.case_relation, fallback.case_relation),
    case_action: pickOne(ACTIONS, value.case_action, fallback.case_action),
    case_type: pickOne(TYPES, value.case_type, fallback.case_type),
    topic: normalizeTopic(value.topic),
    status: pickStatus(value.status),
    priority: pickOne(PRIORITIES, value.priority, fallback.priority),
    confidence: pickOne(CONFIDENCES, value.confidence, fallback.confidence),
    reason: typeof value.reason === "string" && value.reason.trim() ? value.reason.trim() : fallback.reason,
    should_apply: false,
  };
}

export async function runCaseRouterShadow(input: {
  user_message: string;
  runtime_context: Record<string, unknown>;
  classifier?: CaseRouterClassifier;
}): Promise<CaseRouterDebug> {
  const fallback = buildFallbackCaseRouterDecision();
  if (!input.classifier) {
    return { enabled: true, mode: "shadow", classifier: "fallback", decision: fallback, applied: false, error: null };
  }
  try {
    const raw = await input.classifier.classifyCaseTurn({ user_message: input.user_message, runtime_context: input.runtime_context });
    if (!isValidClassifierDecision(raw)) {
      return {
        enabled: true,
        mode: "shadow",
        classifier: "fallback",
        decision: fallback,
        applied: false,
        error: { code: "classifier_invalid_output", message: "Classifier returned invalid decision schema" },
      };
    }
    return {
      enabled: true,
      mode: "shadow",
      classifier: "openai",
      decision: normalizeCaseRouterDecision(raw),
      applied: false,
      error: null,
    };
  } catch (error) {
    return {
      enabled: true,
      mode: "shadow",
      classifier: "fallback",
      decision: fallback,
      applied: false,
      error: { code: "classifier_exception", message: error instanceof Error ? error.message : String(error) },
    };
  }
}

export function sanitizeCaseRouterContext(rawRuntimeContext: unknown): Record<string, unknown> {
  const root = asRecord(rawRuntimeContext);
  const pick = (key: string) => asRecord(root[key]);
  return {
    patient_context: pick("patient_context"),
    task_state: pick("task_state"),
    case_context: pick("case_context"),
    booking_context: pick("booking_context"),
  };
}

function pickStatus(raw: unknown): CaseStatus {
  if (raw === null) return null;
  return pickOne(STATUSES, raw, null);
}

function normalizeTopic(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length ? trimmed : null;
}

function pickOne<T extends string | null>(allowed: readonly T[], raw: unknown, fallback: T): T {
  if (allowed.some((item) => item === raw)) {
    return raw as T;
  }
  return fallback;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function isValidClassifierDecision(raw: unknown): boolean {
  const value = asRecord(raw);
  return typeof value.reason === "string" && value.reason.trim().length > 0;
}
