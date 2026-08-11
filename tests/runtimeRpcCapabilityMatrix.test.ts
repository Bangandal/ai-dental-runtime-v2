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
    "src/runtime/runtimeTurnAssembly.ts",
    "src/runtime/openaiRuntimeAgentCaller.ts",
    "src/runtime/runtimeAgentLoop.ts",
    "src/runtime/runtimeTurnHttpRoute.ts",
    "src/runtime/runtimeGateShadow.ts",
    "src/runtime/turnUnderstandingShadow.ts",
    "src/runtime/topicMemoryCandidateShadow.ts",
    "src/runtime/caseRouterShadow.ts",
    "src/runtime/openaiCaseRouterClassifier.ts",
    "src/runtime/openaiRuntimeAgent.ts",
    "src/runtime/replyContextBuilderShadow.ts",
    "src/runtime/modelVisibleRuntimeContext.ts",
    "sql/rpc/core.rpc_check_availability_v1.sql",
    "package.json",
    "src/main.ts",
    "src/index.ts",
    "src/runtime/runtimeServerBootstrap.ts",
    "src/runtime/runtimeTurnLogger.ts",
    "src/runtime/supabaseRuntimeContextRepository.ts",
    "src/runtime/dentalRuntimeAgentFactory.ts",
    "src/runtime/supabaseKnowledgeRepository.ts",
    "src/runtime/supabaseOpenAIConversationMemoryRepository.ts",
    "src/runtime/supabaseTurnPersistenceRepository.ts",
    "src/runtime/supabaseCaseContextRepository.ts",
    "src/runtime/supabaseCaseRepository.ts",
    "src/runtime/case.ts",
    "src/runtime/telegramWebhookAdapter.ts",
    "src/runtime/telegramWebhookRoute.ts",
    "src/runtime/telegramSender.ts",
    "src/runtime/runtimeTurnOrchestrator.ts",
    "src/runtime/runtimeTurnService.ts",
    "src/runtime/toolResults.ts",
    "src/integrations/cliniccard/bookingApplyExecutor.ts",
    "src/integrations/cliniccard/bookingSlotMutex.ts",
    "src/integrations/cliniccard/clinicCardAdapter.ts",
    "src/integrations/cliniccard/clinicCardTypes.ts",
    "src/integrations/cliniccard/appointmentLookupExecutor.ts",
    "src/integrations/cliniccard/appointmentCancelExecutor.ts",
    "src/runtime/openaiClientTimeout.ts",
    "src/runtime/bookingApplyGuard.ts",
    "src/runtime/bookingContactGuard.ts",
    "src/runtime/bookingPreflight.ts",
    "src/integrations/cliniccard/clinicCardAvailabilityExecutor.ts",
    "src/integrations/cliniccard/clinicCardAvailability.ts",
    "src/integrations/cliniccard/availabilityDiagnostics.ts",
    "src/runtime/openaiRuntimeAgent.ts",
    "src/runtime/bookingSubjectsState.ts",
    "src/runtime/bookingSubjectExecutionResolver.ts",
    "src/runtime/availabilityActionTruth.ts",
    "src/runtime/availabilityPresentationTruth.ts",
    "src/runtime/appointmentDisplayTruth.ts",
    "src/runtime/runtimeCaseLite.ts",
    "src/runtime/openaiResponsesOutputText.ts",
    "src/runtime/openaiRuntimeCaseLiteExtractor.ts",
    "src/runtime/slotEvidence.ts",
    "src/runtime/bookingApplyPreflight.ts",
    "src/runtime/bookingProcessState.ts",
    "src/runtime/bookingSelectSlot.ts",
    "src/runtime/supabaseBookingProcessStateRepository.ts",
    "sql/rpc/core.booking_process_state.sql",
    "src/runtime/channelCapabilityPolicy.ts",
    "Dockerfile",
    ".env.example",
    "sql/rpc/public.rpc_kb_search_v1.sql",
    "sql/rpc/core.rpc_kb_search_v1.sql",
    "sql/rpc/public.rpc_check_availability_v1.sql",
    "sql/rpc/core.rpc_merge_conversation_state.sql",
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
