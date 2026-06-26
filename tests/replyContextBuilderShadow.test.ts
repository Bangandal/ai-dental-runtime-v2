import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildReplyContextShadow } from "../src/runtime/replyContextBuilderShadow.ts";
import type { RuntimeGateDebug } from "../src/runtime/runtimeGateShadow.ts";
import { buildFallbackTurnUnderstandingDecision, type TurnUnderstandingDebug, type TurnUnderstandingDecision } from "../src/runtime/turnUnderstandingShadow.ts";

const operationalGate: RuntimeGateDebug = {
  enabled: true,
  mode: "shadow",
  route: "operational_candidate",
  turn_shape: "booking",
  confidence: "high",
  reason: "booking signal",
  should_apply: false,
};

const nonOperationalGate: RuntimeGateDebug = {
  enabled: true,
  mode: "shadow",
  route: "non_operational",
  turn_shape: "faq",
  confidence: "high",
  reason: "faq only",
  should_apply: false,
};

function debugForDecision(overrides: Partial<TurnUnderstandingDecision> = {}): TurnUnderstandingDebug {
  return {
    enabled: true,
    mode: "shadow",
    skipped: false,
    skip_reason: null,
    decision: {
      ...buildFallbackTurnUnderstandingDecision("mocked"),
      turn_type: "booking_request",
      service_interest: null,
      subject: { kind: "self", display_name: null },
      reply_objective: "ask_missing_field",
      case_decision: { action: "open_new", case_kind: "booking", target_case_id: null },
      slot_updates: { service_interest: null, preferred_date: null, preferred_time: null, first_name: null, last_name: null, offered_slot_id: null, confirmation_target: null },
      missing_fields: [],
      confidence: "high",
      reason: "mocked",
      ...overrides,
      should_apply: false,
    },
    error: null,
  };
}

test("non_operational / skipped turn_understanding emits skipped reply context", () => {
  const debug = buildReplyContextShadow({
    runtime_gate: nonOperationalGate,
    turn_understanding: {
      enabled: true,
      mode: "shadow",
      skipped: true,
      skip_reason: "runtime_gate_non_operational",
      decision: null,
      error: null,
    },
  });

  assert.equal(debug.enabled, true);
  assert.equal(debug.mode, "shadow");
  assert.equal(debug.skipped, true);
  assert.equal(debug.skip_reason, "turn_understanding_skipped");
  assert.equal(debug.context, null);
  assert.equal(debug.error, null);
});

test("booking_request with service known and missing preferred_time asks missing fields", () => {
  const debug = buildReplyContextShadow({
    runtime_gate: operationalGate,
    turn_understanding: debugForDecision({
      turn_type: "booking_request",
      service_interest: "cleaning",
      slot_updates: { service_interest: "cleaning", preferred_date: "2026-06-05", preferred_time: null, first_name: null, last_name: null, offered_slot_id: null, confirmation_target: null },
      missing_fields: ["preferred_time"],
    }),
  });

  assert.equal(debug.skipped, false);
  assert.equal(debug.context?.what_to_do, "ask_missing_fields");
  assert.equal(debug.context?.what_is_known.service_interest, "cleaning");
  assert.deepEqual(debug.context?.what_is_missing, ["preferred_time"]);
  assert.ok(debug.context?.do_not_ask.includes("phone"));
  assert.ok(debug.context?.do_not_ask.includes("service_interest"));
  assert.equal(debug.context?.safe_reply_frame, "Ask only for missing fields. Do not ask for phone.");
});

test("slot_fill with date/time known suppresses asking for preferred_date/preferred_time", () => {
  const debug = buildReplyContextShadow({
    runtime_gate: operationalGate,
    turn_understanding: debugForDecision({
      turn_type: "slot_fill",
      slot_updates: { service_interest: null, preferred_date: "2026-06-05", preferred_time: "14:00", first_name: null, last_name: null, offered_slot_id: null, confirmation_target: null },
      missing_fields: ["service_interest"],
    }),
  });

  assert.equal(debug.context?.what_to_do, "ask_missing_fields");
  assert.ok(debug.context?.do_not_ask.includes("preferred_date"));
  assert.ok(debug.context?.do_not_ask.includes("preferred_time"));
});

test("admin_request maps to handoff", () => {
  const debug = buildReplyContextShadow({
    runtime_gate: operationalGate,
    turn_understanding: debugForDecision({ turn_type: "admin_request", case_decision: { action: "handoff", case_kind: "admin", target_case_id: null } }),
  });

  assert.equal(debug.context?.what_to_do, "handoff");
});

test("urgent maps to handoff and includes no_medical_diagnosis", () => {
  const debug = buildReplyContextShadow({
    runtime_gate: operationalGate,
    turn_understanding: debugForDecision({ turn_type: "urgent", case_decision: { action: "handoff", case_kind: "urgent", target_case_id: null } }),
  });

  assert.equal(debug.context?.what_to_do, "handoff");
  assert.ok(debug.context?.safety_constraints.includes("no_medical_diagnosis"));
});

test("process_status_inquiry maps to handoff and keeps promise guardrails", () => {
  const debug = buildReplyContextShadow({
    runtime_gate: operationalGate,
    turn_understanding: debugForDecision({ turn_type: "process_status_inquiry", case_decision: { action: "handoff", case_kind: "process_status", target_case_id: null } }),
  });

  assert.equal(debug.context?.what_to_do, "handoff");
  assert.ok(debug.context?.do_not_promise.includes("specific_slot_available"));
  assert.ok(debug.context?.do_not_promise.includes("appointment_confirmed"));
});

test("postpone maps to acknowledge_postpone", () => {
  const debug = buildReplyContextShadow({
    runtime_gate: operationalGate,
    turn_understanding: debugForDecision({ turn_type: "postpone" }),
  });

  assert.equal(debug.context?.what_to_do, "acknowledge_postpone");
});

test("mixed booking + FAQ prefers ask_missing_fields when missing fields exist", () => {
  const debug = buildReplyContextShadow({
    runtime_gate: operationalGate,
    turn_understanding: debugForDecision({
      turn_type: "mixed",
      case_decision: { action: "open_new", case_kind: "booking", target_case_id: null },
      missing_fields: ["preferred_date"],
    }),
  });

  assert.equal(debug.context?.what_to_do, "ask_missing_fields");
});

test("builder does not mutate runtime_gate or turn_understanding", () => {
  const turnUnderstanding = debugForDecision({
    turn_type: "slot_fill",
    slot_updates: { service_interest: "exam", preferred_date: "2026-06-05", preferred_time: "09:00", first_name: null, last_name: null, offered_slot_id: null, confirmation_target: null },
  });
  const gateBefore = JSON.stringify(operationalGate);
  const turnBefore = JSON.stringify(turnUnderstanding);

  buildReplyContextShadow({ runtime_gate: operationalGate, turn_understanding: turnUnderstanding });

  assert.equal(JSON.stringify(operationalGate), gateBefore);
  assert.equal(JSON.stringify(turnUnderstanding), turnBefore);
});


// CBM v1 safety hotfix — rc_action_conflict tests

test("CBM/bug6: rc_action_conflict=true when urgent turn has ask_missing_field reply_objective", () => {
  const debug = buildReplyContextShadow({
    runtime_gate: operationalGate,
    turn_understanding: debugForDecision({
      turn_type: "urgent",
      reply_objective: "ask_missing_field",
      missing_fields: ["service_interest", "preferred_time"],
      case_decision: { action: "open_new", case_kind: "urgent", target_case_id: null },
    }),
  });

  assert.equal(debug.context?.what_to_do, "handoff");
  assert.equal(debug.rc_action_conflict, true, "urgent + ask_missing_field must flag rc_action_conflict");
});

test("CBM/bug6: rc_action_conflict=true when urgent turn has answer reply_objective", () => {
  const debug = buildReplyContextShadow({
    runtime_gate: operationalGate,
    turn_understanding: debugForDecision({
      turn_type: "urgent",
      reply_objective: "answer",
      missing_fields: [],
      case_decision: { action: "none", case_kind: "urgent", target_case_id: null },
    }),
  });

  assert.equal(debug.context?.what_to_do, "handoff");
  assert.equal(debug.rc_action_conflict, true);
});

test("CBM/bug6: rc_action_conflict=false when urgent turn has handoff reply_objective", () => {
  const debug = buildReplyContextShadow({
    runtime_gate: operationalGate,
    turn_understanding: debugForDecision({
      turn_type: "urgent",
      reply_objective: "handoff",
      missing_fields: [],
      case_decision: { action: "handoff", case_kind: "urgent", target_case_id: null },
    }),
  });

  assert.equal(debug.context?.what_to_do, "handoff");
  assert.equal(debug.rc_action_conflict, false, "aligned urgent/handoff must not flag conflict");
});

test("CBM/bug6: rc_action_conflict=false for booking_request with ask_missing_field (no conflict)", () => {
  const debug = buildReplyContextShadow({
    runtime_gate: operationalGate,
    turn_understanding: debugForDecision({
      turn_type: "booking_request",
      reply_objective: "ask_missing_field",
      missing_fields: ["preferred_date"],
    }),
  });

  assert.equal(debug.context?.what_to_do, "ask_missing_fields");
  assert.equal(debug.rc_action_conflict, false);
});

test("CBM/bug6: rc_action_conflict=false when skipped (non_operational)", () => {
  const debug = buildReplyContextShadow({
    runtime_gate: nonOperationalGate,
    turn_understanding: {
      enabled: true,
      mode: "shadow",
      skipped: true,
      skip_reason: "runtime_gate_non_operational",
      decision: null,
      error: null,
    },
  });

  assert.equal(debug.skipped, true);
  assert.equal(debug.rc_action_conflict, false);
});

test("reply context builder module has no DB/OpenAI/tool/transport side-effect imports", async () => {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const modulePath = resolve(thisDir, "../src/runtime/replyContextBuilderShadow.ts");
  const source = await readFile(modulePath, "utf8");

  assert.doesNotMatch(source, /from\s+["'][^"']*(openai|supabase|calendar|telegram|n8n|toolExecutor|repositories)[^"']*["']/i);
  assert.doesNotMatch(source, /responses\.create|chat\.completions|saveMessage|mergeConversationState|registerInboundEvent/i);
});
