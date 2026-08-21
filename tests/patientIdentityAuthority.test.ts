import assert from "node:assert/strict";
import test from "node:test";

import { createClinicCardPatientIdentityAuthority } from "../src/integrations/cliniccard/clinicCardPatientIdentityAuthority.ts";
import type { ClinicCardAdapter } from "../src/integrations/cliniccard/clinicCardAdapter.ts";
import type { ClinicCardPatient } from "../src/integrations/cliniccard/clinicCardTypes.ts";

function makeAdapter(params: {
  patients?: ClinicCardPatient[];
  findFailure?: { code: string; message: string } | null;
  onWriteAttempt?: (method: "createPatient" | "createVisit") => void;
} = {}): ClinicCardAdapter {
  return {
    findPatientByPhone: async () => {
      if (params.findFailure) return { ok: false, error: params.findFailure };
      return { ok: true, data: params.patients ?? [] };
    },
    createPatient: async () => {
      params.onWriteAttempt?.("createPatient");
      throw new Error("identity authority must not create patients");
    },
    listVisits: async () => ({ ok: true, data: [] }),
    createVisit: async () => {
      params.onWriteAttempt?.("createVisit");
      throw new Error("identity authority must not create visits");
    },
    listPayments: async () => ({ ok: true, data: [] }),
  };
}

const BASE_INPUT = {
  first_name: "Anna",
  last_name: "Koval",
  phone_number: "+420111222333",
} as const;

test("R1-ID-1: unique target-name match resolves the existing patient", async () => {
  const authority = createClinicCardPatientIdentityAuthority(makeAdapter({
    patients: [{ id: 33, name: "Koval Anna", phone: BASE_INPUT.phone_number }],
  }));

  const result = await authority.resolve({ ...BASE_INPUT, phone_belongs_to_patient: true });

  assert.deepEqual(result, {
    ok: true,
    patient_id: 33,
    resolution: "existing_patient",
  });
});

test("R1-ID-2: patient-owned phone mapped to multiple records fails closed before name tiebreaking", async () => {
  let writeAttempts = 0;
  const authority = createClinicCardPatientIdentityAuthority(makeAdapter({
    patients: [
      { id: 33, name: "Anna Koval", phone: BASE_INPUT.phone_number },
      { id: 34, name: "Other Person", phone: BASE_INPUT.phone_number },
    ],
    onWriteAttempt: () => { writeAttempts += 1; },
  }));

  const result = await authority.resolve({ ...BASE_INPUT, phone_belongs_to_patient: true });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failure, "identity_ambiguous");
  assert.match(result.reason, /shared phone is an identity conflict/);
  assert.equal(writeAttempts, 0);
});

test("R1-ID-3: another person's phone with no target match requests target creation without writing", async () => {
  let writeAttempts = 0;
  const authority = createClinicCardPatientIdentityAuthority(makeAdapter({
    patients: [{ id: 10, name: "Olena Koval", phone: BASE_INPUT.phone_number }],
    onWriteAttempt: () => { writeAttempts += 1; },
  }));

  const result = await authority.resolve({ ...BASE_INPUT, phone_belongs_to_patient: false });

  assert.deepEqual(result, {
    ok: true,
    resolution: "create_patient_required",
  });
  assert.equal(writeAttempts, 0);
});

test("R1-ID-4: multiple target-name matches on another person's phone remain ambiguous", async () => {
  const authority = createClinicCardPatientIdentityAuthority(makeAdapter({
    patients: [
      { id: 44, name: "Anna Koval", phone: BASE_INPUT.phone_number },
      { id: 45, name: "Koval Anna", phone: BASE_INPUT.phone_number },
    ],
  }));

  const result = await authority.resolve({ ...BASE_INPUT, phone_belongs_to_patient: false });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failure, "identity_ambiguous");
});

test("R1-ID-5: ClinicCard lookup failure stays an external failure with the legacy reason prefix", async () => {
  const authority = createClinicCardPatientIdentityAuthority(makeAdapter({
    findFailure: { code: "cliniccard_timeout", message: "timeout" },
  }));

  const result = await authority.resolve({ ...BASE_INPUT, phone_belongs_to_patient: true });

  assert.deepEqual(result, {
    ok: false,
    failure: "external_failure",
    reason: "Patient lookup failed: timeout",
  });
});

test("R1-ID-6: no existing candidate returns create_patient_required and authority performs zero writes", async () => {
  let writeAttempts = 0;
  const authority = createClinicCardPatientIdentityAuthority(makeAdapter({
    patients: [],
    onWriteAttempt: () => { writeAttempts += 1; },
  }));

  const result = await authority.resolve({ ...BASE_INPUT, phone_belongs_to_patient: true });

  assert.deepEqual(result, {
    ok: true,
    resolution: "create_patient_required",
  });
  assert.equal(writeAttempts, 0);
});

test("R1-ID-7: another person's contact may reuse one uniquely matched target patient", async () => {
  const authority = createClinicCardPatientIdentityAuthority(makeAdapter({
    patients: [
      { id: 10, name: "Olena Koval", phone: BASE_INPUT.phone_number },
      { id: 55, name: "Koval Anna", phone: BASE_INPUT.phone_number },
    ],
  }));

  const result = await authority.resolve({ ...BASE_INPUT, phone_belongs_to_patient: false });

  assert.deepEqual(result, {
    ok: true,
    patient_id: 55,
    resolution: "existing_patient",
  });
});
