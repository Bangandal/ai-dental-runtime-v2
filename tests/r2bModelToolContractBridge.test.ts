import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { RUNTIME_AGENT_TOOL_DEFINITIONS } from "../src/runtime/openaiRuntimeAgent.ts";
import {
  bindModelToolRequestsToInternalContract,
  INVALID_SEMANTIC_SUBJECT_ID,
  resolveActiveInternalSubjectId,
} from "../src/runtime/modelToolContractBridge.ts";

test("R3f boundary: canonical booking tool contracts are already business-semantic", () => {
  const select = RUNTIME_AGENT_TOOL_DEFINITIONS["booking.select_slot"];
  assert.deepEqual(select.required_args, ["requested_date", "requested_time"]);
  assert.equal("subject_id" in (select.param_schemas ?? {}), false);
  assert.doesNotMatch(select.description, /subject_[1-4]|subject_id/i);

  const apply = RUNTIME_AGENT_TOOL_DEFINITIONS["booking.apply"];
  assert.deepEqual(apply.required_args, [
    "patient_target",
    "first_name",
    "last_name",
    "service",
    "requested_date",
    "requested_time",
  ]);
  assert.deepEqual(apply.param_schemas?.patient_target?.enum, ["self", "other_person"]);
  assert.equal("subject_id" in (apply.param_schemas ?? {}), false);

  const lookup = RUNTIME_AGENT_TOOL_DEFINITIONS["appointment.lookup"];
  assert.deepEqual(lookup.required_args, ["patient_target"]);
  assert.deepEqual(lookup.optional_args, ["date_from", "date_to"]);
  assert.deepEqual(lookup.param_schemas?.patient_target?.enum, ["self", "other_person"]);
});

test("R2b boundary: active runtime patient beats model legacy IDs", () => {
  const bound = bindModelToolRequestsToInternalContract([
    {
      tool: "booking.apply",
      call_id: "apply",
      arguments: {
        patient_target: "other_person",
        subject_id: "subject_4",
        first_name: "Eva",
      },
    },
    {
      tool: "booking.select_slot",
      call_id: "select",
      arguments: {
        requested_date: "2099-08-21",
        requested_time: "14:00",
      },
    },
  ], "subject_3");

  const apply = bound.find((request) => request.tool === "booking.apply")!;
  const select = bound.find((request) => request.tool === "booking.select_slot")!;
  assert.equal(apply.arguments.subject_id, "subject_3");
  assert.equal(select.arguments.subject_id, "subject_3");
  assert.equal("patient_target" in apply.arguments, false);
});

test("R2b boundary: semantic/runtime disagreement remains fail-closed", () => {
  const [apply] = bindModelToolRequestsToInternalContract([
    {
      tool: "booking.apply",
      arguments: { patient_target: "self" },
    },
  ], "subject_2");
  assert.equal(apply?.arguments.subject_id, INVALID_SEMANTIC_SUBJECT_ID);
});

test("R2b boundary: first other-person bootstrap remains deterministic", () => {
  const bound = bindModelToolRequestsToInternalContract([
    {
      tool: "booking.select_slot",
      arguments: { requested_date: "2099-08-21", requested_time: "14:00" },
    },
    {
      tool: "booking.apply",
      arguments: { patient_target: "other_person" },
    },
  ], null);
  assert.equal(bound[0]?.arguments.subject_id, "subject_2");
  assert.equal(bound[1]?.arguments.subject_id, "subject_2");
});

test("R2b boundary: active subject is read from runtime context only when canonical", () => {
  assert.equal(resolveActiveInternalSubjectId({
    runtime_context: { booking_subjects: { active_subject_id: "subject_4" } },
  }), "subject_4");
  assert.equal(resolveActiveInternalSubjectId({
    runtime_context: { booking_subjects: { active_subject_id: "subject_99" } },
  }), null);
  assert.equal(resolveActiveInternalSubjectId({}), null);
});

test("R3h structure: OpenAI caller consumes canonical tool schemas directly while bridge owns only response binding", async () => {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const callerSource = await readFile(resolve(thisDir, "../src/runtime/openaiRuntimeAgentCaller.ts"), "utf8");
  const bridgeSource = await readFile(resolve(thisDir, "../src/runtime/modelToolContractBridge.ts"), "utf8");

  assert.match(callerSource, /from\s+["']\.\/modelToolContractBridge\.ts["']/);
  assert.doesNotMatch(callerSource, /projectModelToolContract/);
  // Canonical definitions remain the source of truth. Agent-first may project narrow
  // presentation-only schema differences (for example Runtime-owned Day+2), but those
  // differences must derive from the canonical description/required args rather than
  // replacing the canonical contract with an independently maintained duplicate.
  assert.match(callerSource, /let\s+description\s*=\s*def\.description;/);
  assert.match(callerSource, /def\.required_args\.filter\(/);
  assert.match(callerSource, /:\s*\[\.\.\.def\.required_args\]/);
  assert.match(callerSource, /description,/);
  assert.match(callerSource, /required:\s*requiredArgs/);
  assert.doesNotMatch(callerSource, /active_subject_id/);
  assert.doesNotMatch(callerSource, /INVALID_SEMANTIC_SUBJECT_ID/);
  assert.doesNotMatch(callerSource, /batchApplySubjects|legacySelectSubjects|selectSlotSubjectId/);

  assert.doesNotMatch(bridgeSource, /projectModelToolContract/);
  assert.doesNotMatch(bridgeSource, /InternalToolContract|ModelToolContract|ActiveRuntimeToolName/);
  assert.doesNotMatch(bridgeSource, /SELECT_SLOT_MODEL_DESCRIPTION|BOOKING_APPLY_MODEL_DESCRIPTION|APPOINTMENT_LOOKUP_MODEL_DESCRIPTION/);
  assert.doesNotMatch(bridgeSource, /PATIENT_TARGET_SCHEMA/);
  assert.doesNotMatch(bridgeSource, /process\.env/);
  assert.doesNotMatch(bridgeSource, /from\s+["'][^"']*cliniccard[^"']*["']/i);
  assert.doesNotMatch(bridgeSource, /from\s+["'][^"']*supabase[^"']*["']/i);
  assert.doesNotMatch(bridgeSource, /from\s+["'][^"']*telegram[^"']*["']/i);
});
