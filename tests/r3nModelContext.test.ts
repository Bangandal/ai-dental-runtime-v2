import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { composeRuntimeModelContext } from "../src/runtime/modelVisibleCallerContext.ts";

test("R3n: context composer keeps base immutable and adds deterministic runtime facts", () => {
  const base = {
    locale: "ru",
    channel_context: { channel: "telegram" },
    runtime_context: { people: [] },
  };
  const bookingState = { next_action: "ask_for_phone" };
  const availabilityTruth = { requested_date: "2026-08-23" };
  const context = composeRuntimeModelContext(base, {
    booking_process_state: bookingState,
    availability_action_truth: availabilityTruth,
  });

  assert.deepEqual(context, {
    ...base,
    booking_process_state: bookingState,
    availability_action_truth: availabilityTruth,
  });
  assert.equal("booking_process_state" in base, false);
  assert.equal("availability_action_truth" in base, false);
});

test("R3n: null optional truths are omitted exactly like historical conditional spreads", () => {
  const context = composeRuntimeModelContext({ locale: "ru" }, {
    booking_apply_action_truth: null,
    availability_action_truth: null,
    availability_presentation_truth: null,
    appointment_display_truth: null,
  });

  assert.deepEqual(context, { locale: "ru" });
});

test("R3n: resolved_context presence is explicit even when empty", () => {
  const context = composeRuntimeModelContext({ locale: "ru" }, { resolved_context: [] });
  assert.equal("resolved_context" in context, true);
  assert.deepEqual(context.resolved_context, []);
});

test("R3n: composer emits only the declared model-visible fact keys", () => {
  const context = composeRuntimeModelContext({ stable: true }, {
    booking_process_state: { active: true },
    booking_apply_action_truth: { booked: false },
    availability_action_truth: { slots: 2 },
    availability_presentation_truth: { display: true },
    appointment_display_truth: { appointment: null },
    resolved_context: [{ tool: "kb.search" }],
  });

  assert.deepEqual(Object.keys(context).sort(), [
    "appointment_display_truth",
    "availability_action_truth",
    "availability_presentation_truth",
    "booking_apply_action_truth",
    "booking_process_state",
    "resolved_context",
    "stable",
  ]);
});

test("R3n structure: legacy loop uses the shared model-context composer for every model call", async () => {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const loopSource = await readFile(resolve(thisDir, "../src/runtime/runtimeAgentLoopLegacy.ts"), "utf8");

  assert.equal(
    loopSource.match(/composeRuntimeModelContext\(/g)?.length,
    6,
    "all six model-call paths must compose context through one owner",
  );
  assert.doesNotMatch(loopSource, /const secondCallContext = \{\s*\.\.\.callerContext/);
  assert.doesNotMatch(loopSource, /context: \{ \.\.\.callerContext, booking_process_state:/);
});
