import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  bindModelToolRequestsToInternalContract,
  INVALID_SEMANTIC_SUBJECT_ID,
  projectModelToolContract,
  resolveActiveInternalSubjectId,
} from "../src/runtime/modelToolContractBridge.ts";

test("R2b boundary: booking tool projection is business-semantic", () => {
  const select = projectModelToolContract("booking.select_slot", {
    description: "legacy select",
    required_args: ["subject_id", "requested_date", "requested_time"],
    optional_args: [],
    param_schemas: { subject_id: { type: "string" } },
  });
  assert.deepEqual(select.required_args, ["requested_date", "requested_time"]);
  assert.equal("subject_id" in (select.param_schemas ?? {}), true, "unused legacy schema may remain internal but is not projected as a property by required/optional args");

  const apply = projectModelToolContract("booking.apply", {
    description: "legacy apply",
    required_args: ["subject_id", "first_name", "last_name", "service", "requested_date", "requested_time"],
    optional_args: [],
  });
  assert.deepEqual(apply.required_args, [
    "patient_target",
    "first_name",
    "last_name",
    "service",
    "requested_date",
    "requested_time",
  ]);
  assert.deepEqual(apply.param_schemas?.patient_target?.enum, ["self", "other_person"]);

  const lookup = projectModelToolContract("appointment.lookup", {
    description: "legacy lookup",
    required_args: ["subject_id"],
    optional_args: ["date_from", "date_to"],
  });
  assert.deepEqual(lookup.required_args, ["patient_target"]);
  assert.deepEqual(lookup.optional_args, ["date_from", "date_to"]);
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

test("R2b structure: OpenAI caller no longer owns booking-tool legacy translation", async () => {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const callerSource = await readFile(resolve(thisDir, "../src/runtime/openaiRuntimeAgentCaller.ts"), "utf8");
  const bridgeSource = await readFile(resolve(thisDir, "../src/runtime/modelToolContractBridge.ts"), "utf8");

  assert.match(callerSource, /from\s+["']\.\/modelToolContractBridge\.ts["']/);
  assert.doesNotMatch(callerSource, /patient_target/);
  assert.doesNotMatch(callerSource, /active_subject_id/);
  assert.doesNotMatch(callerSource, /INVALID_SEMANTIC_SUBJECT_ID/);
  assert.doesNotMatch(callerSource, /batchApplySubjects|legacySelectSubjects|selectSlotSubjectId/);

  assert.doesNotMatch(bridgeSource, /process\.env/);
  assert.doesNotMatch(bridgeSource, /from\s+["'][^"']*cliniccard[^"']*["']/i);
  assert.doesNotMatch(bridgeSource, /from\s+["'][^"']*supabase[^"']*["']/i);
  assert.doesNotMatch(bridgeSource, /from\s+["'][^"']*telegram[^"']*["']/i);
});
