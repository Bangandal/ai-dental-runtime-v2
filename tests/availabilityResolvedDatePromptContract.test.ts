import assert from "node:assert/strict";
import test from "node:test";

import { buildRuntimeAgentSystemInstruction } from "../src/runtime/openaiRuntimeAgent.ts";

test("availability prompt contract requires resolved date/calendar for returned slots", () => {
  const instruction = buildRuntimeAgentSystemInstruction({
    now: new Date("2026-08-22T12:00:00Z"),
    timezone: "Europe/Prague",
  });

  assert.match(instruction, /present\/select only allowed_slots\/allowed_slot_starts/);
  assert.match(instruction, /Slot date and booking\.select_slot date = resolved_date/);
  assert.match(instruction, /labels = resolved_calendar/);
  assert.match(
    instruction,
    /If requested_date != resolved_date, never pair its date with returned times/,
  );
});
