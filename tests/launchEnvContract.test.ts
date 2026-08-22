import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const envExample = readFileSync(resolve(here, "../.env.example"), "utf8");

const REQUIRED_LAUNCH_KEYS = [
  "RUNTIME_OPENAI_MODEL",
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

test("launch env recommends the agent-first primary model without changing rollout safety defaults", () => {
  assert.match(envExample, /^RUNTIME_OPENAI_MODEL=gpt-5\.4-mini$/m);
  assert.match(envExample, /^RUNTIME_AGENT_MODE=legacy$/m);
});

test("dangerous launch authority switches remain fail-closed in the example", () => {
  assert.match(envExample, /^RUNTIME_AGENT_MODE=legacy$/m);
  assert.match(envExample, /^CLINICCARD_BOOKING_MODE=disabled$/m);
  assert.match(envExample, /^CLINICCARD_LIVE_CLINIC_ALLOWLIST=$/m);
  assert.match(envExample, /^CLINICCARD_AVAILABILITY_POLICY_CONFIRMED=false$/m);
  assert.match(envExample, /^CLINICCARD_SERVICE_RESOURCE_POLICY_CONFIRMED=false$/m);
  assert.match(envExample, /^CLINICCARD_SERVICE_RESOURCE_RULES_JSON=$/m);
});

test("launch env documents provider schedule inside each live service mapping", () => {
  assert.match(envExample, /provider availability object/i);
  assert.match(envExample, /\"availability\":\{\"working_days\":\[1,2,3,4,5\]/);
  assert.match(envExample, /\"working_hours_start\":\"09:00\"/);
  assert.match(envExample, /\"working_hours_end\":\"17:00\"/);
  assert.match(envExample, /\"closed_dates\":\[\]/);
});