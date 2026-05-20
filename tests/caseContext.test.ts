import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDefaultPatientSubject,
  deriveAuthorityDecision,
  type CaseContext,
} from "../src/runtime/caseContext.ts";

test("default patient subject is unknown", () => {
  assert.deepEqual(buildDefaultPatientSubject(), {
    type: "unknown",
    display_name: null,
    relation_text: null,
  });
});

test("CaseContext can represent self", () => {
  const context: CaseContext = {
    patient_subject: { type: "self" },
    case_type: "booking",
  };

  assert.equal(context.patient_subject.type, "self");
});

test("CaseContext can represent partner", () => {
  const context: CaseContext = {
    patient_subject: { type: "partner", relation_text: "boyfriend" },
    case_type: "faq",
  };

  assert.equal(context.patient_subject.type, "partner");
});

test("CaseContext can represent child with name", () => {
  const context: CaseContext = {
    patient_subject: { type: "child", display_name: "Sofia" },
    case_type: "booking",
  };

  assert.equal(context.patient_subject.type, "child");
  assert.equal(context.patient_subject.display_name, "Sofia");
});

test("doctor conclusion without doctor note escalates", () => {
  const decision = deriveAuthorityDecision({ requested_doctor_conclusion: true });

  assert.equal(decision.level, "needs_human_authority");
  assert.deepEqual(decision.reasons, ["doctor_note_required"]);
});

test("doctor conclusion with note requires business truth", () => {
  const decision = deriveAuthorityDecision({
    requested_doctor_conclusion: true,
    has_doctor_note: true,
  });

  assert.equal(decision.level, "needs_business_truth");
  assert.deepEqual(decision.reasons, ["missing_business_truth"]);
});

test("medical decision requires human authority", () => {
  const decision = deriveAuthorityDecision({ asks_medical_decision: true });

  assert.equal(decision.level, "needs_human_authority");
  assert.deepEqual(decision.reasons, ["medical_decision_required"]);
});

test("price dispute requires human authority", () => {
  const decision = deriveAuthorityDecision({ price_dispute: true });

  assert.equal(decision.level, "needs_human_authority");
  assert.deepEqual(decision.reasons, ["price_dispute"]);
});

test("user requested human requires human authority", () => {
  const decision = deriveAuthorityDecision({ user_requested_human: true });

  assert.equal(decision.level, "needs_human_authority");
  assert.deepEqual(decision.reasons, ["user_requested_human"]);
});

test("normal FAQ is system_can_answer", () => {
  const decision = deriveAuthorityDecision({});

  assert.equal(decision.level, "system_can_answer");
  assert.deepEqual(decision.reasons, []);
});
