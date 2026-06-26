import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

import { loadClinicCardConfig } from "../src/integrations/cliniccard/clinicCardConfig.ts";

const BASE_ENV = {
  CLINICCARD_API_BASE_URL: "https://demo.cliniccard.app",
  CLINICCARD_API_TOKEN: "test-token-placeholder",
  CLINICCARD_DEFAULT_DOCTOR_ID: "42",
  CLINICCARD_DEFAULT_CABINET_ID: "7",
  CLINICCARD_TIMEZONE: "Europe/Prague",
  CLINICCARD_BOOKING_MODE: "disabled",
};

test("returns error when CLINICCARD_API_BASE_URL is missing", () => {
  const { CLINICCARD_API_BASE_URL: _omit, ...env } = BASE_ENV;
  const result = loadClinicCardConfig(env);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "cliniccard_config_missing_field");
    assert.match(result.error.message, /CLINICCARD_API_BASE_URL/);
  }
});

test("returns error when CLINICCARD_API_TOKEN is missing", () => {
  const { CLINICCARD_API_TOKEN: _omit, ...env } = BASE_ENV;
  const result = loadClinicCardConfig(env);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "cliniccard_config_missing_field");
    assert.match(result.error.message, /CLINICCARD_API_TOKEN/);
  }
});

test("booking_mode defaults to 'disabled' when CLINICCARD_BOOKING_MODE is not set", () => {
  const { CLINICCARD_BOOKING_MODE: _omit, ...env } = BASE_ENV;
  const result = loadClinicCardConfig(env);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.data.booking_mode, "disabled");
  }
});

test("returns error when CLINICCARD_BOOKING_MODE is invalid", () => {
  const result = loadClinicCardConfig({ ...BASE_ENV, CLINICCARD_BOOKING_MODE: "live_force" });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "cliniccard_config_invalid_booking_mode");
  }
});

test("loads full config successfully with all fields", () => {
  const result = loadClinicCardConfig(BASE_ENV);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.data.api_base_url, "https://demo.cliniccard.app");
    assert.equal(result.data.api_token, "test-token-placeholder");
    assert.equal(result.data.default_doctor_id, "42");
    assert.equal(result.data.default_cabinet_id, "7");
    assert.equal(result.data.timezone, "Europe/Prague");
    assert.equal(result.data.booking_mode, "disabled");
  }
});

test("accepts 'shadow' and 'live' as valid booking modes", () => {
  for (const mode of ["shadow", "live"] as const) {
    const result = loadClinicCardConfig({ ...BASE_ENV, CLINICCARD_BOOKING_MODE: mode });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.data.booking_mode, mode);
    }
  }
});

test("missing config returns typed error object, not a thrown exception", () => {
  assert.doesNotThrow(() => {
    loadClinicCardConfig({});
  });
  const result = loadClinicCardConfig({});
  assert.equal(result.ok, false);
  assert.equal(typeof result.error?.code, "string");
  assert.equal(typeof result.error?.message, "string");
});

test(".env.example contains placeholder values only — no real token", () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  const envExample = readFileSync(resolve(dir, "../.env.example"), "utf8");
  // Base URL must be the official ClinicCard API root (paths appended by adapter)
  assert.match(envExample, /CLINICCARD_API_BASE_URL=https:\/\/cliniccards\.com/);
  assert.match(envExample, /CLINICCARD_API_TOKEN=/);
  assert.match(envExample, /CLINICCARD_BOOKING_MODE=disabled/);
  // Token line must be empty (placeholder only — real token must never be committed)
  const tokenLine = envExample.split("\n").find((l) => l.startsWith("CLINICCARD_API_TOKEN="));
  assert.ok(tokenLine !== undefined, ".env.example must contain CLINICCARD_API_TOKEN line");
  assert.equal(tokenLine, "CLINICCARD_API_TOKEN=", ".env.example must not contain a real token");
});
