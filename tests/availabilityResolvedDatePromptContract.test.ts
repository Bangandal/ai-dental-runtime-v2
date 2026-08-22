import assert from "node:assert/strict";
import test from "node:test";

import { buildRuntimeAgentSystemInstruction } from "../src/runtime/openaiRuntimeAgent.ts";

test("availability prompt contract requires resolved date/calendar for returned slots", () => {
  const instruction = buildRuntimeAgentSystemInstruction({
    now: new Date("2026-08-22T12:00:00Z"),
    timezone: "Europe/Prague",
  });

  assert.match(
    instruction,
    /Every presented or selected slot MUST use availability_presentation_truth\.resolved_date as its date/,
  );
  assert.match(instruction, /resolved_calendar for weekday\/date labels/);
  assert.match(
    instruction,
    /If requested_date differs from resolved_date, never combine returned times with requested_date/,
  );
  assert.match(instruction, /pass resolved_date, not requested_date, to booking\.select_slot/);
});
