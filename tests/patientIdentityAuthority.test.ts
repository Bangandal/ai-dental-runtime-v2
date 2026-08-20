import assert from "node:assert/strict";
import test from "node:test";

import { createClinicCardPatientIdentityAuthority } from "../src/integrations/cliniccard/clinicCardPatientIdentityAuthority.ts";
import type { ClinicCardAdapter } from "../src/integrations/cliniccard/clinicCardAdapter.ts";
import type {
  ClinicCardCreatePatientInput,
  ClinicCardPatient,
} from "../src/integrations/cliniccard/clinicCardTypes.ts";

function makeAdapter(params: {
  patients?: ClinicCardPatient[];
  findFailure?: { code: string; message: string } | null;
  createFailure?: { code: string; message: string } | null;
  newPatientId?: number;
  onCreatePatient?: (input: ClinicCardCreatePatientInput) => void;
} = {}): ClinicCardAdapter {
  return {
    findPatientByPhone: async () => {
      if (params.findFailure) return { ok: false, error: params.findFailure };
      return { ok: true, data: params.patients ?? [] };
    },
    createPatient: async (input) => {
      params.onCreatePatient?.(input);
      if (params.createFailure) return { ok: false, error: params.createFailure };
      return {
        ok: true,
        data: {
          id: params.newPatientId ?? 900,
          name: input.name,
          phone: input.phone ?? null,
        },
      };
    },
    listVisits: async () => ({ ok: true, data: [] }),
    createVisit: async () => ({
      ok: false,
      error: { code: "unused", message: "createVisit is not used by identity authority tests" },
    }),
    listPayments: async () => ({ ok: true, data: [] }),
  };
}

const BASE_INPUT = {
  first_name: "Anna",
  last_name: "Koval",
  phone_number: "+420111222333",
} as const;

test("R1-ID-1: unique target-name match reuses the existing patient", async () => {
  const authority = createClinicCardPatientIdentityAuthority(makeAdapter({
    patients: [{ id: 33, name: "Koval Anna", phone: BASE_INPUT.phone_number }],
  }));

  const result = await authority.resolveOrCreate({ ...BASE_INPUT, contact_role: "patient" });

  assert.deepEqual(result, {
    ok: true,
    patient_id: 33,
    resolution: "existing_patient",
  });
});

test("R1-ID-2: own phone mapped to multiple records fails closed before name tiebreaking", async () => {
  let createCalls = 0;
  const authority = createClinicCardPatientIdentityAuthority(makeAdapter({
    patients: [
      { id: 33, name: "Anna Koval", phone: BASE_INPUT.phone_number },
      { id: 34, name: "Other Person", phone: BASE_INPUT.phone_number },
    ],
    onCreatePatient: () => { createCalls += 1; },
  }));

  const result = await authority.resolveOrCreate({ ...BASE_INPUT, contact_role: "patient" });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failure, "identity_ambiguous");
  assert.match(result.reason, /shared phone is an identity conflict/);
  assert.equal(createCalls, 0);
});

test("R1-ID-3: responsible-party phone with no target match creates a separate target patient", async () => {
  let created: ClinicCardCreatePatientInput | null = null;
  const authority = createClinicCardPatientIdentityAuthority(makeAdapter({
    patients: [{ id: 10, name: "Olena Koval", phone: BASE_INPUT.phone_number }],
    newPatientId: 55,
    onCreatePatient: (input) => { created = input; },
  }));

  const result = await authority.resolveOrCreate({ ...BASE_INPUT, contact_role: "responsible_party" });

  assert.deepEqual(result, {
    ok: true,
    patient_id: 55,
    resolution: "created_patient",
  });
  assert.deepEqual(created, {
    name: "Anna Koval",
    phone: BASE_INPUT.phone_number,
  });
});

test("R1-ID-4: multiple target-name matches on responsible-party phone remain ambiguous", async () => {
  const authority = createClinicCardPatientIdentityAuthority(makeAdapter({
    patients: [
      { id: 44, name: "Anna Koval", phone: BASE_INPUT.phone_number },
      { id: 45, name: "Koval Anna", phone: BASE_INPUT.phone_number },
    ],
  }));

  const result = await authority.resolveOrCreate({ ...BASE_INPUT, contact_role: "responsible_party" });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failure, "identity_ambiguous");
});

test("R1-ID-5: ClinicCard lookup failure stays an external failure with the legacy reason prefix", async () => {
  const authority = createClinicCardPatientIdentityAuthority(makeAdapter({
    findFailure: { code: "cliniccard_timeout", message: "timeout" },
  }));

  const result = await authority.resolveOrCreate({ ...BASE_INPUT, contact_role: "patient" });

  assert.deepEqual(result, {
    ok: false,
    failure: "external_failure",
    reason: "Patient lookup failed: timeout",
  });
});

test("R1-ID-6: patient creation failure stays an external failure without changing the provider reason", async () => {
  const authority = createClinicCardPatientIdentityAuthority(makeAdapter({
    createFailure: { code: "cliniccard_write_failed", message: "duplicate phone" },
  }));

  const result = await authority.resolveOrCreate({ ...BASE_INPUT, contact_role: "responsible_party" });

  assert.deepEqual(result, {
    ok: false,
    failure: "external_failure",
    reason: "duplicate phone",
  });
});
