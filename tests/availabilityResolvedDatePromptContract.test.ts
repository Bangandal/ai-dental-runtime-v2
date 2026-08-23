import assert from "node:assert/strict";
import test from "node:test";

import { buildRuntimeAgentSystemInstruction } from "../src/runtime/openaiRuntimeAgent.ts";

test("availability prompt contract requires resolved date/calendar for returned slots", () => {
  const instruction = buildRuntimeAgentSystemInstruction({
    now: new Date("2026-08-22T12:00:00Z"),
    timezone: "Europe/Prague",
  });

  assert.match(instruction, /only allowed_slot_starts from current availability_presentation_truth/);
  assert.match(instruction, /Slot\/booking\.select_slot date=resolved_date/);
  assert.match(instruction, /labels=resolved_calendar/);
  assert.match(
    instruction,
    /If requested_date!=resolved_date, never pair old date with returned times/,
  );
});
