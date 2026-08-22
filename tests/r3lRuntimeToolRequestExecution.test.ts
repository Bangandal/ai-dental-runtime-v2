import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildSubjectAwarePhoneFields,
  executeRuntimeToolRequest,
} from "../src/runtime/runtimeToolRequestExecution.ts";
import type {
  RuntimeAgentToolRequest,
  RuntimeAgentTurnInput,
} from "../src/runtime/openaiRuntimeAgent.ts";
import type { ToolExecutionContext } from "../src/runtime/toolExecutor.ts";

function turnInput(overrides: Partial<RuntimeAgentTurnInput> = {}): RuntimeAgentTurnInput {
  return {
    clinic_id: "clinic_r3l",
    contact_id: "contact_r3l",
    case_id: "case_r3l",
    user_message: "test",
    ...overrides,
  };
}

test("R3l: policy denial is normalized by the shared execution pipeline", async () => {
  const request: RuntimeAgentToolRequest = {
    tool: "availability.check",
    call_id: "avail_missing_date",
    arguments: {},
  };

  const result = await executeRuntimeToolRequest({
    input: turnInput(),
    request,
    executors: {},
    now: new Date("2026-08-22T07:00:00Z"),
  });

  assert.equal(result.tool_result.tool, "availability.check");
  assert.equal(result.tool_result.call_id, "avail_missing_date");
  assert.equal(result.tool_result.status, "denied");
  assert.equal(result.tool_result.error?.code, "date_or_time_missing");
  assert.equal(result.availability_diagnostic, undefined);
});

test("R3l: availability diagnostic stays server-side while result payload is normalized", async () => {
  const request: RuntimeAgentToolRequest = {
    tool: "availability.check",
    call_id: "avail_ok",
    arguments: { requested_date: "2099-08-22" },
  };

  const result = await executeRuntimeToolRequest({
    input: turnInput(),
    request,
    executors: {
      "availability.check": async () => ({
        tool: "availability.check",
        status: "success",
        data: { slots: [], timezone: "Europe/Prague" },
        _diagnostic: { source: "cliniccard", read_count: 1 },
      }),
    },
  });

  assert.equal(result.tool_result.status, "success");
  assert.deepEqual(result.tool_result.data, { slots: [], timezone: "Europe/Prague" });
  assert.deepEqual(result.availability_diagnostic, { source: "cliniccard", read_count: 1 });
  assert.equal("_diagnostic" in (result.tool_result as Record<string, unknown>), false);
});

test("R3l: booking execution preserves responsible-party phone provenance", async () => {
  let capturedContext: ToolExecutionContext | null = null;
  const input = turnInput({
    booking_subjects: {
      version: 3,
      status: "active",
      active_subject_id: "subject_2",
      pending_typed_phone: null,
      max_subjects: 4,
      subjects: [
        {
          id: "subject_1",
          role: "sender",
          label: "я",
          patient_name: "Mikhail",
          service: null,
          slot: null,
          booking_contact: {
            phone_number: "+420777111222",
            source: "telegram_contact_button",
            trust: "trusted",
            owner_subject_id: "subject_1",
            collected_at: null,
          },
          status: "collecting",
          missing: [],
        },
        {
          id: "subject_2",
          role: "mentioned_person",
          label: "дочь",
          patient_name: "Eva Novak",
          service: null,
          slot: null,
          booking_contact: null,
          status: "collecting",
          missing: [],
        },
      ],
    },
  });
  const request: RuntimeAgentToolRequest = {
    tool: "booking.apply",
    call_id: "book_other",
    arguments: {
      subject_id: "subject_2",
      first_name: "Eva",
      last_name: "Novak",
      service: "checkup",
      requested_date: "2099-08-22",
      requested_time: "14:00",
    },
  };

  const result = await executeRuntimeToolRequest({
    input,
    request,
    execution_subject_id: "subject_2",
    executors: {
      "booking.apply": async (context) => {
        capturedContext = context;
        return {
          tool: "booking.apply",
          status: "success",
          data: {
            booking_action: "booking_apply",
            booking_status: "visit_created",
            created_visit: true,
            may_claim_booked: true,
            cliniccard_visit_id: "visit_r3l",
            reason: "created",
            proof: { visit_id: "visit_r3l" },
          },
        };
      },
    },
  });

  assert.equal(result.tool_result.status, "success");
  assert.equal(capturedContext?.phone_number, "+420777111222");
  assert.equal(capturedContext?.phone_source, "telegram_contact_button");
  assert.equal(capturedContext?.phone_trust, "trusted");
  assert.equal(capturedContext?.contact_phone_owner_subject_id, "subject_1");
  assert.equal(capturedContext?.first_name, "Eva");
  assert.equal(capturedContext?.last_name, "Novak");
});

test("R3l: phone helper still suppresses stale typed phone after a multi-person episode", () => {
  const fields = buildSubjectAwarePhoneFields(turnInput({
    had_booking_subjects: true,
    provided_phone: {
      phone_number: "+420777999999",
      phone_source: "typed",
      phone_trust: "unverified",
      phone_consent: false,
      phone_collected_at: "2026-08-20T10:00:00Z",
    },
  }), "subject_1");

  assert.equal(fields.phone_number, undefined);
  assert.equal(fields.phone_source, undefined);
  assert.equal(fields.phone_trust, undefined);
});

test("R3l structure: legacy loop no longer owns policy-backed execution plumbing", async () => {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const loopSource = await readFile(resolve(thisDir, "../src/runtime/runtimeAgentLoopLegacy.ts"), "utf8");

  assert.equal(
    loopSource.match(/executeRuntimeToolRequest\(\{/g)?.length,
    2,
    "first normal path and later booking.apply path must share one execution pipeline",
  );
  assert.match(loopSource, /export \{ buildSubjectAwarePhoneFields, hasSubjectOrContactPhone \} from ["']\.\/runtimeToolRequestExecution\.ts["']/);
  assert.doesNotMatch(loopSource, /applyToolPolicy\(/);
  assert.doesNotMatch(loopSource, /executeAllowedTools\(/);
  assert.doesNotMatch(loopSource, /buildTruthSnapshot\(/);
  assert.doesNotMatch(loopSource, /buildPlannerFromAgentToolRequest\(/);
  assert.doesNotMatch(loopSource, /resolveTruthSnapshot\(/);
  assert.doesNotMatch(loopSource, /buildExecutionContext\(/);
  assert.doesNotMatch(loopSource, /convertToolExecutionResult\(/);
});
