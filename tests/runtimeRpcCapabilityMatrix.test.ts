import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import { execSync } from "node:child_process";

const DOC_PATH = new URL("../docs/EXISTING_RPC_CAPABILITY_MATRIX.md", import.meta.url);

test("Existing RPC capability matrix doc exists", async () => {
  const stat = await fs.stat(DOC_PATH);
  assert.equal(stat.isFile(), true);
});

test("Existing RPC capability matrix doc contains required guard phrases", async () => {
  const doc = await fs.readFile(DOC_PATH, "utf8");

  const requiredPhrases = [
    "rpc_check_availability_v1",
    "rpc_apply_booking_decision_v1",
    "rpc_get_or_create_contact",
    "rpc_get_contact_case_context_v1",
    "rpc_get_active_booking_context_v1",
    "kb.rpc_retrieve_context_json",
    "rpc_prepare_admin_notification",
    "admin.notify remains side effect",
    "returns available slots only (no mutation side effects)",
    "must not:",
    "create `slot_holds`",
    "update `cases`",
    "create `appointments`",
    "write `case_events` or `appointment_events`",
    "hold/create/confirm/cancel",
    "Runtime must not duplicate transactional booking logic",
  ];

  for (const phrase of requiredPhrases) {
    assert.equal(doc.includes(phrase), true, `Missing required phrase: ${phrase}`);
  }
});

test("PR scope guard: only docs/tests and targeted runtime repository files are modified", () => {
  const changedFiles = execSync("git diff --name-only HEAD", { encoding: "utf8" })
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean);

  const allowedNonDocTestFiles = new Set([
    "src/runtime/toolPolicy.ts",
    "src/runtime/toolExecutor.ts",
    "src/runtime/runtimeRepositories.ts",
    "src/runtime/supabaseAvailabilityRepository.ts",
    "src/runtime/availabilityCheckExecutor.ts",
    "src/runtime/openaiPlanner.ts",
    "sql/rpc/core.rpc_check_availability_v1.sql",
  ]);

  for (const file of changedFiles) {
    assert.equal(
      file.startsWith("docs/") ||
        file.startsWith("tests/") ||
        allowedNonDocTestFiles.has(file),
      true,
      `Unexpected file changed outside PR scope: ${file}`,
    );
  }
});
