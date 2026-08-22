import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const envExample = readFileSync(resolve(here, "../.env.example"), "utf8");

const REQUIRED_LAUNCH_KEYS = [
  "RUNTIME_AGENT_MODE",
  "RUNTIME_AGENT_MAX_MODEL_CALLS",
  "CLINICCARD_BOOKING_MODE",
  "CLINICCARD_LIVE_CLINIC_ALLOWLIST",
  "CLINICCARD_AVAILABILITY_POLICY_CONFIRMED",
  "CLINICCARD_WORKING_DAYS",
  "CLINICCARD_WORKING_HOURS_START",
  "CLINICCARD_WORKING_HOURS_END",
  "CLINICCARD_SLOT_DURATION_MINUTES",
  "CLINICCARD_CLOSED_DATES",
  "CLINICCARD_SERVICE_RESOURCE_POLICY_CONFIRMED",
  "CLINICCARD_SERVICE_RESOURCE_RULES_JSON",
] as const;

test("launch env example exposes every fail-closed ClinicCard authority prerequisite", () => {
  for (const key of REQUIRED_LAUNCH_KEYS) {
    assert.match(
      envExample,
      new RegExp(`^${key}=`, "m"),
      `.env.example must expose ${key}`,
    );
  }
});

test("dangerous launch authority switches remain fail-closed in the example", () => {
  assert.match(envExample, /^RUNTIME_AGENT_MODE=legacy$/m);
  assert.match(envExample, /^CLINICCARD_BOOKING_MODE=disabled$/m);
  assert.match(envExample, /^CLINICCARD_LIVE_CLINIC_ALLOWLIST=$/m);
  assert.match(envExample, /^CLINICCARD_AVAILABILITY_POLICY_CONFIRMED=false$/m);
  assert.match(envExample, /^CLINICCARD_SERVICE_RESOURCE_POLICY_CONFIRMED=false$/m);
  assert.match(envExample, /^CLINICCARD_SERVICE_RESOURCE_RULES_JSON=$/m);
});
