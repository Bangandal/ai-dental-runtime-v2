import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildModelVisiblePeopleContext } from "../src/runtime/modelPeopleContextBridge.ts";

function makeState() {
  return {
    version: 3 as const,
    status: "active" as const,
    active_subject_id: "subject_2" as const,
    pending_typed_phone: null,
    max_subjects: 4 as const,
    subjects: [
      {
        id: "subject_1" as const,
        role: "sender" as const,
        label: "я",
        patient_name: "Anna",
        service: null,
        slot: null,
        booking_contact: {
          phone_number: "+420111222333",
          source: "telegram_contact_button" as const,
          trust: "trusted" as const,
          owner_subject_id: "subject_1" as const,
          collected_at: "2099-08-01T00:00:00.000Z",
        },
        status: "collecting" as const,
        missing: ["service", "slot"],
      },
      {
        id: "subject_2" as const,
        role: "mentioned_person" as const,
        label: "дочь",
        patient_name: "Eva",
        service: "consultation",
        slot: "2099-08-21T14:00",
        booking_contact: null,
        status: "collecting" as const,
        missing: ["booking_contact"],
      },
    ],
  };
}

test("R2d behavior: projection preserves current subject payload", () => {
  const projected = buildModelVisiblePeopleContext(makeState());
  assert.equal(projected.version, 3);
  assert.equal(projected.status, "active");
  assert.equal(projected.active_subject_id, "subject_2");
  assert.equal(projected.max_subjects, 4);

  const subjects = projected.subjects as Array<Record<string, unknown>>;
  assert.equal(subjects[0]?.id, "subject_1");
  assert.equal(subjects[1]?.id, "subject_2");
  assert.equal(subjects[1]?.patient_name, "Eva");
});

test("R2d behavior: trusted sender contact remains effective responsible-party contact for active other person", () => {
  const projected = buildModelVisiblePeopleContext(makeState());
  const subjects = projected.subjects as Array<Record<string, unknown>>;
  const other = subjects[1]!;
  assert.equal(other.phone_status, "trusted_contact_owner");
  assert.equal(other.contact_owner, "subject_1");
  assert.deepEqual(other.missing, []);
});

test("R2d behavior: pending typed phone suppresses responsible-party fallback", () => {
  const state = { ...makeState(), pending_typed_phone: "+420999888777" };
  const projected = buildModelVisiblePeopleContext(state);
  const subjects = projected.subjects as Array<Record<string, unknown>>;
  const other = subjects[1]!;
  assert.equal(other.phone_status, null);
  assert.equal(other.contact_owner, null);
  assert.deepEqual(other.missing, ["booking_contact"]);
  assert.equal(projected.pending_typed_phone, "+420999888777");
});

test("R2d structure: caller-context composer no longer owns booking subject projection rules", async () => {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const composerSource = await readFile(resolve(thisDir, "../src/runtime/modelVisibleCallerContext.ts"), "utf8");
  const bridgeSource = await readFile(resolve(thisDir, "../src/runtime/modelPeopleContextBridge.ts"), "utf8");

  assert.match(composerSource, /buildModelVisiblePeopleContext/);
  assert.doesNotMatch(composerSource, /subject_1|active_subject_id|trusted_contact_owner|shared_from_subject/);
  assert.doesNotMatch(composerSource, /BookingContact|BookingSubject|BookingSubjectsState/);

  assert.doesNotMatch(bridgeSource, /process\.env/);
  assert.doesNotMatch(bridgeSource, /from\s+["'][^"']*cliniccard[^"']*["']/i);
  assert.doesNotMatch(bridgeSource, /from\s+["'][^"']*supabase[^"']*["']/i);
});
