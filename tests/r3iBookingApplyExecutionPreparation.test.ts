import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { prepareBookingApplyExecution } from "../src/runtime/bookingApplyExecutionPreparation.ts";
import type { BookingSubjectsState } from "../src/runtime/bookingSubjectsState.ts";
import type { RuntimeAgentToolRequest } from "../src/runtime/openaiRuntimeAgent.ts";

function bookingApply(subjectId: unknown, extra: Record<string, unknown> = {}): RuntimeAgentToolRequest {
  return {
    tool: "booking.apply",
    call_id: "apply_1",
    arguments: {
      subject_id: subjectId,
      first_name: "Eva",
      last_name: "Novak",
      service: "checkup",
      requested_date: "2099-08-22",
      requested_time: "14:00",
      ...extra,
    },
  };
}

function existingRegistry(): BookingSubjectsState {
  return {
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
        booking_contact: null,
        status: "collecting",
        missing: ["slot", "service", "booking_contact"],
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
        missing: ["slot", "service", "booking_contact"],
      },
    ],
  };
}

test("R3i: self booking without registry freezes subject_1 without bootstrap", () => {
  const result = prepareBookingApplyExecution({
    booking_apply: bookingApply("subject_1"),
    booking_subjects: null,
    channel_contact: null,
    current_turn_typed_phone: null,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.execution_subject_id, "subject_1");
  assert.equal(result.effective_booking_subjects, null);
  assert.equal(result.bootstrapped_registry, null);
});

test("R3i: other-person booking bootstraps registry and freezes target", () => {
  const result = prepareBookingApplyExecution({
    booking_apply: bookingApply("subject_2"),
    booking_subjects: null,
    channel_contact: {
      phone_number: "+420777111222",
      phone_source: "telegram_contact_button",
    } as never,
    current_turn_typed_phone: "+420777333444",
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.execution_subject_id, "subject_2");
  assert.equal(result.bootstrapped_registry?.active_subject_id, "subject_2");
  assert.equal(result.effective_booking_subjects, result.bootstrapped_registry);
  assert.equal(result.bootstrapped_registry?.pending_typed_phone, "+420777333444");
  assert.equal(result.bootstrapped_registry?.subjects[1]?.patient_name, "Eva Novak");
});

test("R3i: invalid technical subject fails at validation and never bootstraps", () => {
  const result = prepareBookingApplyExecution({
    booking_apply: bookingApply("subject_99"),
    booking_subjects: null,
    channel_contact: null,
    current_turn_typed_phone: null,
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.stage, "subject_validation");
  assert.equal(result.reason, "invalid_subject_id_format");
  assert.equal(result.effective_booking_subjects, null);
  assert.equal(result.bootstrapped_registry, null);
});

test("R3i: existing registry resolves the requested subject instead of active fallback", () => {
  const state = existingRegistry();
  const result = prepareBookingApplyExecution({
    booking_apply: bookingApply("subject_1"),
    booking_subjects: state,
    channel_contact: null,
    current_turn_typed_phone: null,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.execution_subject_id, "subject_1");
  assert.equal(result.effective_booking_subjects, state);
  assert.equal(result.bootstrapped_registry, null);
});

test("R3i: valid subject outside existing registry fails closed at resolution", () => {
  const state = existingRegistry();
  const result = prepareBookingApplyExecution({
    booking_apply: bookingApply("subject_3"),
    booking_subjects: state,
    channel_contact: null,
    current_turn_typed_phone: null,
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.stage, "subject_resolution");
  assert.equal(result.reason, "subject_not_in_registry");
  assert.equal(result.effective_booking_subjects, state);
  assert.equal(result.bootstrapped_registry, null);
});

test("R3i: completed registry blocks booking through the same preparation boundary", () => {
  const state = { ...existingRegistry(), status: "completed" as const };
  const result = prepareBookingApplyExecution({
    booking_apply: bookingApply("subject_2"),
    booking_subjects: state,
    channel_contact: null,
    current_turn_typed_phone: null,
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.stage, "subject_resolution");
  assert.equal(result.reason, "registry_completed");
});

test("R3u structure: complete turn-batch owner delegates booking target plumbing to one preparation boundary", async () => {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const loopSource = await readFile(resolve(thisDir, "../src/runtime/runtimeAgentLoopLegacy.ts"), "utf8");
  const batchSource = await readFile(resolve(thisDir, "../src/runtime/runtimeTurnToolBatch.ts"), "utf8");

  assert.match(loopSource, /from\s+["']\.\/runtimeTurnToolBatch\.ts["']/);
  assert.equal(
    loopSource.match(/executeRuntimeTurnToolBatch\(\{/g)?.length,
    2,
    "both current model tool batches must share the complete turn-batch owner",
  );
  assert.doesNotMatch(loopSource, /bookingApplyExecutionPreparation\.ts/);
  assert.doesNotMatch(loopSource, /prepareBookingApplyExecution\(/);
  assert.match(batchSource, /from\s+["']\.\/bookingApplyExecutionPreparation\.ts["']/);
  assert.equal(
    batchSource.match(/prepareBookingApplyExecution\(\{/g)?.length,
    1,
    "complete turn-batch owner must prepare the booking target through one boundary",
  );
  assert.doesNotMatch(loopSource, /from\s+["']\.\/bookingSubjectExecutionResolver\.ts["']/);
  assert.doesNotMatch(loopSource, /bootstrapRegistryFromBookingApplyArgs/);
  assert.doesNotMatch(loopSource, /parseSubjectTarget/);
  assert.doesNotMatch(loopSource, /resolveBookingExecutionSubject/);
});
