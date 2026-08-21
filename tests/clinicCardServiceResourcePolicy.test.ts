import assert from "node:assert/strict";
import test from "node:test";

import {
  loadClinicCardServiceResourcePolicy,
  resolveClinicCardServiceResource,
} from "../src/integrations/cliniccard/clinicCardServiceResourcePolicy.ts";

const RULES = JSON.stringify([
  {
    service_key: "cleaning",
    aliases: ["Чистка зубов", "профгигиена"],
    doctor_id: 11,
    cabinet_id: 21,
    duration_minutes: 30,
  },
  {
    service_key: "orthodontics",
    aliases: ["Ортодонт", "брекеты"],
    doctor_id: 12,
    cabinet_id: 22,
    duration_minutes: 60,
  },
]);

const ENV = {
  CLINICCARD_SERVICE_RESOURCE_POLICY_CONFIRMED: "true",
  CLINICCARD_SERVICE_RESOURCE_RULES_JSON: RULES,
};

test("PF-011: exact normalized alias resolves authoritative doctor, cabinet and duration", () => {
  const result = resolveClinicCardServiceResource(ENV, "  ЧИСТКА   ЗУБОВ ");
  assert.deepEqual(result, {
    ok: true,
    source: "operator_confirmed_config",
    service_key: "cleaning",
    doctor_id: 11,
    cabinet_id: 21,
    duration_minutes: 30,
  });
});

test("PF-011: different services can resolve different resources and durations", () => {
  const cleaning = resolveClinicCardServiceResource(ENV, "профгигиена");
  const orthodontics = resolveClinicCardServiceResource(ENV, "брекеты");
  assert.equal(cleaning.ok, true);
  assert.equal(orthodontics.ok, true);
  if (cleaning.ok && orthodontics.ok) {
    assert.notEqual(cleaning.doctor_id, orthodontics.doctor_id);
    assert.notEqual(cleaning.cabinet_id, orthodontics.cabinet_id);
    assert.notEqual(cleaning.duration_minutes, orthodontics.duration_minutes);
  }
});

test("PF-011: missing service fails closed", () => {
  const result = resolveClinicCardServiceResource(ENV, null);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.failure, "service_missing");
});

test("PF-011: unknown explicit service never falls back to a default resource", () => {
  const result = resolveClinicCardServiceResource(ENV, "имплантация");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.failure, "service_unmapped");
});

test("PF-011: unconfirmed policy fails closed", () => {
  const result = resolveClinicCardServiceResource({
    ...ENV,
    CLINICCARD_SERVICE_RESOURCE_POLICY_CONFIRMED: "false",
  }, "Чистка зубов");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.failure, "policy_unavailable");
});

test("PF-011: duplicate normalized aliases are rejected at config load", () => {
  const policy = loadClinicCardServiceResourcePolicy({
    CLINICCARD_SERVICE_RESOURCE_POLICY_CONFIRMED: "true",
    CLINICCARD_SERVICE_RESOURCE_RULES_JSON: JSON.stringify([
      { service_key: "a", aliases: ["Осмотр"], doctor_id: 1, cabinet_id: 2, duration_minutes: 30 },
      { service_key: "b", aliases: [" осмотр "], doctor_id: 3, cabinet_id: 4, duration_minutes: 45 },
    ]),
  });
  assert.equal(policy.ok, false);
  if (!policy.ok) assert.equal(policy.error.code, "cliniccard_service_resource_policy_invalid");
});

test("PF-011: invalid resource IDs or duration are rejected", () => {
  const policy = loadClinicCardServiceResourcePolicy({
    CLINICCARD_SERVICE_RESOURCE_POLICY_CONFIRMED: "true",
    CLINICCARD_SERVICE_RESOURCE_RULES_JSON: JSON.stringify([
      { service_key: "cleaning", aliases: [], doctor_id: 0, cabinet_id: 2, duration_minutes: 30 },
    ]),
  });
  assert.equal(policy.ok, false);
});
