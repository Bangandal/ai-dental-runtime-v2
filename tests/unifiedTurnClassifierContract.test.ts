import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";

const DOC_PATH = new URL("../docs/architecture/UNIFIED_TURN_CLASSIFIER_v1.md", import.meta.url);

const ROUTES = ["non_operational", "operational_candidate"] as const;
const TURN_SHAPES = [
  "greeting",
  "faq",
  "mixed",
  "booking",
  "availability",
  "slot_fragment",
  "reschedule",
  "cancel",
  "urgent",
  "admin_request",
  "follow_up",
  "process_status_inquiry",
  "postpone",
  "confirmation_response",
  "unclear",
  "other",
] as const;
const TURN_TYPES = [
  "booking_request",
  "availability_request",
  "slot_fill",
  "reschedule",
  "cancel",
  "urgent",
  "admin_request",
  "follow_up",
  "process_status_inquiry",
  "postpone",
  "confirmation_response",
  "mixed",
  "faq",
  "greeting",
  "other",
  "unknown",
] as const;
const SUBJECT_KINDS = ["self", "child", "family_member", "other", "unknown"] as const;
const REPLY_OBJECTIVES = ["answer", "ask_missing_field", "offer_next_step", "explain_status", "handoff", "clarify", "safe_fallback"] as const;
const CASE_ACTIONS = ["none", "continue_existing", "open_new", "update_existing", "close", "handoff"] as const;
const CASE_KINDS = ["booking", "reschedule", "cancel", "urgent", "admin", "follow_up", "process_status", "unknown"] as const;
const CONFIDENCES = ["low", "medium", "high"] as const;

type UnifiedTurnClassifierDecision = {
  route: (typeof ROUTES)[number];
  turn_shape: (typeof TURN_SHAPES)[number];
  turn_type: (typeof TURN_TYPES)[number];
  topic: string | null;
  service_interest: string | null;
  subject: {
    kind: (typeof SUBJECT_KINDS)[number];
    display_name: string | null;
  };
  reply_objective: (typeof REPLY_OBJECTIVES)[number];
  case_decision: {
    action: (typeof CASE_ACTIONS)[number];
    case_kind: (typeof CASE_KINDS)[number] | null;
    target_case_id: null;
  };
  slot_updates: {
    service_interest: string | null;
    preferred_date: string | null;
    preferred_time: string | null;
    first_name: string | null;
    last_name: string | null;
    offered_slot_id: string | null;
    confirmation_target: string | null;
  };
  missing_fields: string[];
  confidence: (typeof CONFIDENCES)[number];
  reason: string;
  should_apply: false;
};

type ValidationResult = { ok: true } | { ok: false; reason: string };

function includes<const T extends readonly string[]>(values: T, value: unknown): value is T[number] {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function isStringOrNull(value: unknown): value is string | null {
  return typeof value === "string" || value === null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateUnifiedTurnClassifierDecision(value: unknown): ValidationResult {
  if (!isRecord(value)) return { ok: false, reason: "decision must be an object" };
  if (!includes(ROUTES, value.route)) return { ok: false, reason: "invalid route" };
  if (!includes(TURN_SHAPES, value.turn_shape)) return { ok: false, reason: "invalid turn_shape" };
  if (!includes(TURN_TYPES, value.turn_type)) return { ok: false, reason: "invalid turn_type" };
  if (!isStringOrNull(value.topic)) return { ok: false, reason: "invalid topic" };
  if (!isStringOrNull(value.service_interest)) return { ok: false, reason: "invalid service_interest" };
  if (!isRecord(value.subject)) return { ok: false, reason: "invalid subject" };
  if (!includes(SUBJECT_KINDS, value.subject.kind)) return { ok: false, reason: "invalid subject.kind" };
  if (!isStringOrNull(value.subject.display_name)) return { ok: false, reason: "invalid subject.display_name" };
  if (!includes(REPLY_OBJECTIVES, value.reply_objective)) return { ok: false, reason: "invalid reply_objective" };
  if (!isRecord(value.case_decision)) return { ok: false, reason: "invalid case_decision" };
  if (!includes(CASE_ACTIONS, value.case_decision.action)) return { ok: false, reason: "invalid case_decision.action" };
  if (!(value.case_decision.case_kind === null || includes(CASE_KINDS, value.case_decision.case_kind))) return { ok: false, reason: "invalid case_decision.case_kind" };
  if (value.case_decision.target_case_id !== null) return { ok: false, reason: "target_case_id must be null" };
  if (!isRecord(value.slot_updates)) return { ok: false, reason: "invalid slot_updates" };

  for (const key of ["service_interest", "preferred_date", "preferred_time", "first_name", "last_name", "offered_slot_id", "confirmation_target"] as const) {
    if (!isStringOrNull(value.slot_updates[key])) return { ok: false, reason: `invalid slot_updates.${key}` };
  }

  if (!Array.isArray(value.missing_fields) || !value.missing_fields.every((field) => typeof field === "string")) {
    return { ok: false, reason: "invalid missing_fields" };
  }
  if (value.missing_fields.includes("phone")) return { ok: false, reason: "missing_fields must not include phone" };
  if (value.route === "non_operational" && (value.turn_shape === "faq" || value.turn_shape === "greeting")) {
    if (value.case_decision.action !== "none") return { ok: false, reason: "non_operational faq/greeting case action must be none" };
    if (value.missing_fields.length !== 0) return { ok: false, reason: "non_operational faq/greeting missing_fields must be empty" };
  }
  if (!includes(CONFIDENCES, value.confidence)) return { ok: false, reason: "invalid confidence" };
  if (typeof value.reason !== "string" || value.reason.trim() === "") return { ok: false, reason: "reason is required" };
  if (value.should_apply !== false) return { ok: false, reason: "should_apply must be false" };

  return { ok: true };
}

function assertValid(decision: UnifiedTurnClassifierDecision): void {
  const result = validateUnifiedTurnClassifierDecision(decision);
  assert.deepEqual(result, { ok: true });
}

function baseDecision(overrides: Partial<UnifiedTurnClassifierDecision> = {}): UnifiedTurnClassifierDecision {
  return {
    route: "operational_candidate",
    turn_shape: "booking",
    turn_type: "booking_request",
    topic: null,
    service_interest: "cleaning",
    subject: { kind: "self", display_name: null },
    reply_objective: "ask_missing_field",
    case_decision: { action: "open_new", case_kind: "booking", target_case_id: null },
    slot_updates: {
      service_interest: "cleaning",
      preferred_date: null,
      preferred_time: null,
      first_name: null,
      last_name: null,
      offered_slot_id: null,
      confirmation_target: null,
    },
    missing_fields: ["preferred_date", "preferred_time", "first_name", "last_name"],
    confidence: "high",
    reason: "The user asks to book a cleaning but has not provided date, time, or name details.",
    should_apply: false,
    ...overrides,
  };
}

test("schema allows FAQ non_operational", () => {
  assertValid(baseDecision({
    route: "non_operational",
    turn_shape: "faq",
    turn_type: "faq",
    topic: "cleaning price",
    service_interest: null,
    subject: { kind: "unknown", display_name: null },
    reply_objective: "answer",
    case_decision: { action: "none", case_kind: null, target_case_id: null },
    slot_updates: {
      service_interest: null,
      preferred_date: null,
      preferred_time: null,
      first_name: null,
      last_name: null,
      offered_slot_id: null,
      confirmation_target: null,
    },
    missing_fields: [],
  }));
});

test("schema allows booking operational", () => {
  assertValid(baseDecision());
});

test("phone rejected from missing_fields", () => {
  const result = validateUnifiedTurnClassifierDecision(baseDecision({ missing_fields: ["phone", "preferred_date"] }));
  assert.deepEqual(result, { ok: false, reason: "missing_fields must not include phone" });
});

test("should_apply must be false", () => {
  const result = validateUnifiedTurnClassifierDecision({ ...baseDecision(), should_apply: true });
  assert.deepEqual(result, { ok: false, reason: "should_apply must be false" });
});

test("non_operational cannot have missing_fields", () => {
  const result = validateUnifiedTurnClassifierDecision(baseDecision({
    route: "non_operational",
    turn_shape: "greeting",
    turn_type: "greeting",
    case_decision: { action: "none", case_kind: null, target_case_id: null },
    missing_fields: ["preferred_date"],
  }));

  assert.deepEqual(result, { ok: false, reason: "non_operational faq/greeting missing_fields must be empty" });
});

test("target_case_id must be null", () => {
  const result = validateUnifiedTurnClassifierDecision({
    ...baseDecision(),
    case_decision: { action: "continue_existing", case_kind: "booking", target_case_id: "case_123" },
  });

  assert.deepEqual(result, { ok: false, reason: "target_case_id must be null" });
});

test("topic_memory rule documented", async () => {
  const doc = await fs.readFile(DOC_PATH, "utf8");
  const required = [
    "Current explicit `service_interest` in the user turn beats `topic_memory`.",
    "`topic_memory` may be used only as a contextual hint for booking or availability turns when the user provides no explicit `service_interest` in the current turn.",
    "The current explicit `service_interest` is `whitening`; the classifier must not overwrite it with `cleaning`.",
  ];

  for (const phrase of required) {
    assert.equal(doc.includes(phrase), true, `Missing documented topic_memory rule: ${phrase}`);
  }
});
