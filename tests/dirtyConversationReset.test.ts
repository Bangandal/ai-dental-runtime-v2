/**
 * PR #121 — prevent persisting/resuming a dirty OpenAI conversation_id after
 * forced-finalization / multi-round fallback.
 *
 * Root cause: when a turn enters the multi-round / forced-finalization path,
 * the OpenAI conversation used for rounds 1-2 ends up with a pending
 * function_call that never gets a function_call_output (the actual reply is
 * produced from an unrelated, throwaway conversation instead). Persisting or
 * resuming that conversation_id on a later turn makes OpenAI reject the
 * request with 400 "No tool output found for function call ...".
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  createRuntimeAgentLoop,
  buildMultiRoundFallbackReply,
  type RuntimeAgentCaller,
} from "../src/runtime/runtimeAgentLoop.ts";
import { buildBookingApplyEmergencyFallback, buildBookingApplyActionTruth } from "../src/runtime/bookingApplyGuard.ts";
import { resolveAdminNotifyReason } from "../src/integrations/adminNotify/adminNotifyTrigger.ts";
import { runRuntimeTurnOrchestrated } from "../src/runtime/runtimeTurnOrchestrator.ts";
import type { ClinicIdentityResolver } from "../src/runtime/supabaseClinicIdentityResolver.ts";
import type { RuntimeTurnService, RuntimeTurnResult } from "../src/runtime/runtimeTurnService.ts";
import type { OpenAIConversationMemoryRepository } from "../src/runtime/supabaseOpenAIConversationMemoryRepository.ts";
import type { ToolExecutorRegistry } from "../src/runtime/toolExecutor.ts";
import type { ConversationMemoryRepository } from "../src/runtime/runtimeRepositories.ts";

function makeSlotStateRepo(starts_at: string) {
  const date = starts_at.slice(0, 10);
  const hhmm = starts_at.slice(11, 16);
  const slotKey = `${date}T${hhmm}`;
  const callId = "legacy_test_call";
  return {
    async loadState() {
      return {
        selected_slot: { starts_at },
        last_available_slots: [{ starts_at }],
        active_availability_evidence: { availability_call_id: callId, requested_date: date, requested_time: null, allowed_slot_keys: [slotKey] },
        selected_slot_proof: { subject_id: "subject_1" as const, availability_call_id: callId, slot_key: slotKey },
      };
    },
    async saveState() {},
  };
}

process.env.LEGACY_CASE_ROUTER_ENABLED = "false";

const CLINIC_UUID = "11111111-1111-4111-8111-111111111111";
const CLINIC_CODE = "clinic_1";

const clinicIdentityResolver: ClinicIdentityResolver = {
  async resolveClinicIdentity(input) {
    if (input.clinic_identifier === CLINIC_UUID || input.clinic_identifier === CLINIC_CODE) {
      return { ok: true, data: { clinic_id: CLINIC_UUID, clinic_code: CLINIC_CODE } };
    }
    return { ok: false, error: { code: "clinic_not_found", message: "missing", retryable: false } };
  },
};

function baseBody() {
  return {
    clinic_code: CLINIC_CODE,
    channel: "telegram",
    external_user_id: "user_dirty_1",
    chat_id: "chat_dirty_1",
    text: "Подтверждаю",
  };
}

// ── a/b/c: runtimeAgentLoop reproduces the dirty-conversation scenario ──────

test("a-c: multi-round fallback (no forced finalization) marks conversation non-resumable, keeps existing fallback text", async () => {
  let round = 0;
  const caller: RuntimeAgentCaller = async () => {
    round += 1;
    if (round === 1) return { type: "tool_requests", tool_requests: [{ tool: "kb.search", call_id: "c1", arguments: { query: "q1" } }], conversation_id: "conv_r1" };
    return { type: "tool_requests", tool_requests: [{ tool: "kb.search", call_id: "c2", arguments: { query: "q2" } }], conversation_id: "conv_r2" };
  };
  // kb.search with empty chunks -> hasUsefulToolResults=false -> no forced finalization attempted.
  const executors: ToolExecutorRegistry = {
    "kb.search": async () => ({ tool: "kb.search", status: "success", data: { chunks: [] } }),
  };
  const result = await createRuntimeAgentLoop({ model: "m", caller, executors }).runTurn({
    clinic_id: "clinic_1", contact_id: "contact_1", case_id: "case_1", user_message: "test", locale: "ru",
    truth_snapshot: { scheduling_intent_present: true, date_or_time_present: true },
  } as any);

  assert.equal(result.debug?.reason, "bounded_tool_batch_budget_exhausted");
  assert.equal(result.final_patient_reply, buildMultiRoundFallbackReply("ru"));
  assert.equal(result.conversation_id, null);
  assert.equal(result.conversation_id_resumable, false);
  assert.equal((result.debug as any).openai_conversation_resumable, false);
});

test("bounded continuation success keeps the fully resolved conversation resumable", async () => {
  let round = 0;
  const caller: RuntimeAgentCaller = async () => {
    round += 1;
    if (round === 1) return { type: "tool_requests", tool_requests: [{ tool: "kb.search", call_id: "c1", arguments: { query: "q1" } }], conversation_id: "conv_r1" };
    if (round === 2) return { type: "tool_requests", tool_requests: [{ tool: "kb.search", call_id: "c2", arguments: { query: "q2" } }], conversation_id: "conv_r2" };
    return { type: "final_response", final_response: { final_patient_reply: "Fresh answer." }, conversation_id: "conv_r2" };
  };
  const executors: ToolExecutorRegistry = {
    "kb.search": async () => ({ tool: "kb.search", status: "success", data: { chunks: [{ chunk_id: "1", text: "info" }] } }),
  };
  const result = await createRuntimeAgentLoop({ model: "m", caller, executors }).runTurn({
    clinic_id: "clinic_1", contact_id: "contact_1", case_id: "case_1", user_message: "test", locale: "ru",
    truth_snapshot: { scheduling_intent_present: true, date_or_time_present: true },
  } as any);

  assert.equal(result.debug?.reason, "bounded_tool_batch_final_response");
  assert.equal(result.final_patient_reply, "Fresh answer.");
  assert.equal(result.conversation_id, "conv_r2");
  assert.notEqual(result.conversation_id_resumable, false);
});

test("multi-round fallback with a prior booking.apply result still uses the booking emergency fallback, not the generic one", async () => {
  let round = 0;
  const caller: RuntimeAgentCaller = async () => {
    round += 1;
    if (round === 1) {
      return {
        type: "tool_requests",
        tool_requests: [{ tool: "booking.apply", call_id: "c1", arguments: { subject_id: "subject_1", first_name: "Ivan", last_name: "Petrov", service: "чистка", requested_date: "2027-08-15", requested_time: "10:00" } }],
        conversation_id: "conv_r1",
      };
    }
    if (round === 2) {
      return { type: "tool_requests", tool_requests: [{ tool: "kb.search", call_id: "c2", arguments: { query: "more" } }], conversation_id: "conv_r2" };
    }
    // Round 3 (forced finalization) reproduces the exact malformed response Codex/prod smoke found.
    return { type: "final_response", final_response: { final_patient_reply: "placeholder", safety_notes: ["malformed_openai_response"] } };
  };
  const executors: ToolExecutorRegistry = {
    "booking.apply": async () => ({
      tool: "booking.apply",
      status: "success",
      data: { booking_action: "booking_apply", booking_status: "booking_write_disabled", created_visit: false, may_claim_booked: false, cliniccard_visit_id: null, reason: "booking_write_disabled", proof: null },
    }),
  };
  const result = await createRuntimeAgentLoop({ model: "m", caller, executors, bookingProcessStateRepository: makeSlotStateRepo("2027-08-15T10:00:00"), now: new Date("2027-08-15T07:00:00Z") }).runTurn({
    clinic_id: "clinic_1", contact_id: "contact_1", case_id: "case_1", user_message: "test", locale: "ru",
    truth_snapshot: { scheduling_intent_present: true, date_or_time_present: true },
    // Trusted phone required so the round-1 global phone preflight (PR #133) does not
    // intercept before booking.apply executes.  This test verifies post-execution behavior.
    channel_contact: { phone_number: "+420600111222", phone_source: "telegram_contact_button" },
  } as any);

  assert.equal(result.conversation_id_resumable, false);
  assert.equal(result.final_patient_reply, buildBookingApplyEmergencyFallback(result.tool_results, "ru"));
  // Admin-notify derivation (PR #117) must still work off the preserved tool_results.
  const actionTruth = buildBookingApplyActionTruth(result.tool_results);
  assert.equal(resolveAdminNotifyReason(actionTruth), "booking_write_disabled");
});

// ── Codex P2: agent-level ConversationMemoryRepository must also be cleared ──
// (saveConversationMemory(...) alone no-ops on a falsy conversationId — passing
// null there silently leaves any previously stored value in place.)

function makeAgentMemoryRepo(initialConversationId: string | null): { repo: ConversationMemoryRepository; saveCalls: unknown[] } {
  let stored = initialConversationId;
  const saveCalls: unknown[] = [];
  const repo: ConversationMemoryRepository = {
    async getConversationMemory() {
      return { ok: true, data: { conversation_id: stored } };
    },
    async saveConversationMemory(input) {
      saveCalls.push({ ...input });
      stored = input.conversation_id || null;
      return { ok: true, data: { conversation_id: input.conversation_id } };
    },
  };
  return { repo, saveCalls };
}

test("Codex-P2-1: dirty multi-round branch clears agent-level memory when a prior conversation_id existed", async () => {
  const { repo, saveCalls } = makeAgentMemoryRepo(null);
  let round = 0;
  const caller: RuntimeAgentCaller = async () => {
    round += 1;
    if (round === 1) return { type: "tool_requests", tool_requests: [{ tool: "kb.search", call_id: "c1", arguments: { query: "q1" } }], conversation_id: "conv_r1_agent" };
    return { type: "tool_requests", tool_requests: [{ tool: "kb.search", call_id: "c2", arguments: { query: "q2" } }], conversation_id: "conv_r2_agent" };
  };
  const executors: ToolExecutorRegistry = {
    "kb.search": async () => ({ tool: "kb.search", status: "success", data: { chunks: [] } }),
  };
  const result = await createRuntimeAgentLoop({ model: "m", caller, executors, conversationMemoryRepository: repo }).runTurn({
    clinic_id: "clinic_1", contact_id: "contact_1", case_id: "case_1", user_message: "test", locale: "ru",
    conversation_id: "conv_prior_agent",
    truth_snapshot: { scheduling_intent_present: true, date_or_time_present: true },
  } as any);

  assert.equal(result.conversation_id_resumable, false);
  assert.equal(saveCalls.length, 1, "must actively clear, not just skip");
  assert.equal((saveCalls[0] as any).conversation_id, "");
  assert.equal((result.debug as any).memory_cleared, true);
});

test("Codex-P2-2: no save/clear call when no prior conversation_id existed at the agent level", async () => {
  const { repo, saveCalls } = makeAgentMemoryRepo(null);
  let round = 0;
  const caller: RuntimeAgentCaller = async () => {
    round += 1;
    if (round === 1) return { type: "tool_requests", tool_requests: [{ tool: "kb.search", call_id: "c1", arguments: { query: "q1" } }] };
    return { type: "tool_requests", tool_requests: [{ tool: "kb.search", call_id: "c2", arguments: { query: "q2" } }] };
  };
  const executors: ToolExecutorRegistry = {
    "kb.search": async () => ({ tool: "kb.search", status: "success", data: { chunks: [] } }),
  };
  const result = await createRuntimeAgentLoop({ model: "m", caller, executors, conversationMemoryRepository: repo }).runTurn({
    clinic_id: "clinic_1", contact_id: "contact_1", case_id: "case_1", user_message: "test", locale: "ru",
    truth_snapshot: { scheduling_intent_present: true, date_or_time_present: true },
  } as any);

  assert.equal(result.conversation_id_resumable, false);
  assert.equal(saveCalls.length, 0, "nothing to clear — no conversation_id was ever known at the agent level");
});

test("Codex-P2-3: normal resumable path still saves the real conversation_id at the agent level", async () => {
  const { repo, saveCalls } = makeAgentMemoryRepo(null);
  const caller: RuntimeAgentCaller = async () => ({
    type: "final_response",
    final_response: { final_patient_reply: "Здравствуйте!" },
    conversation_id: "conv_good_agent",
  });
  const result = await createRuntimeAgentLoop({ model: "m", caller, executors: {}, conversationMemoryRepository: repo }).runTurn({
    clinic_id: "clinic_1", contact_id: "contact_1", case_id: "case_1", user_message: "test", locale: "ru",
    truth_snapshot: { scheduling_intent_present: true, date_or_time_present: true },
  } as any);

  assert.notEqual(result.conversation_id_resumable, false);
  assert.equal(saveCalls.length, 1);
  assert.equal((saveCalls[0] as any).conversation_id, "conv_good_agent");
  assert.equal((result.debug as any).memory_saved, true);
});

test("Codex-P2-4: orchestrator-level clear behavior (PR #121) remains unchanged after this fix", async () => {
  const { repo, saveCalls } = makeMemoryRepo("conv_previous_good_orch");
  const { service } = serviceReturning({
    final_patient_reply: buildMultiRoundFallbackReply("ru"),
    conversation_id: null,
    conversation_id_resumable: false,
  });

  await runRuntimeTurnOrchestrated(baseBody(), {
    runtimeTurnService: service,
    clinicIdentityResolver,
    openAIConversationMemoryRepository: repo,
  });

  assert.equal(saveCalls.length, 1);
  assert.equal((saveCalls[0] as any).conversation_id, "");
});

// ── d/e: orchestrator must not persist/resume the dirty conversation_id ─────

function makeMemoryRepo(initialConversationId: string | null): { repo: OpenAIConversationMemoryRepository; saveCalls: unknown[] } {
  let stored = initialConversationId;
  const saveCalls: unknown[] = [];
  const repo: OpenAIConversationMemoryRepository = {
    async getConversationMemory() {
      return { ok: true, data: { conversation_id: stored } };
    },
    async saveConversationMemory(input) {
      saveCalls.push({ ...input });
      stored = input.conversation_id || null;
      return { ok: true, data: { conversation_id: input.conversation_id } };
    },
  };
  return { repo, saveCalls };
}

function serviceReturning(result: Partial<RuntimeTurnResult>): { service: RuntimeTurnService; seenInputs: unknown[] } {
  const seenInputs: unknown[] = [];
  const service: RuntimeTurnService = {
    async runTurn(input) {
      seenInputs.push(input);
      return {
        final_patient_reply: "reply",
        tool_requests: [],
        tool_results: [],
        ...result,
      };
    },
  };
  return { service, seenInputs };
}

test("d: memory save clears a previously-stored conversation_id when this turn goes dirty", async () => {
  const { repo, saveCalls } = makeMemoryRepo("conv_previous_good");
  const { service } = serviceReturning({
    final_patient_reply: buildMultiRoundFallbackReply("ru"),
    conversation_id: null,
    conversation_id_resumable: false,
  });

  const result = await runRuntimeTurnOrchestrated(baseBody(), {
    runtimeTurnService: service,
    clinicIdentityResolver,
    openAIConversationMemoryRepository: repo,
  });

  assert.equal(result.outcome, "success");
  assert.equal(saveCalls.length, 1);
  assert.equal((saveCalls[0] as any).conversation_id, "", "must explicitly clear the stale value, not skip the save");
});

test("d: no save call at all when there was nothing to clear (first turn, dirty)", async () => {
  const { repo, saveCalls } = makeMemoryRepo(null);
  const { service } = serviceReturning({
    final_patient_reply: buildMultiRoundFallbackReply("ru"),
    conversation_id: null,
    conversation_id_resumable: false,
  });

  await runRuntimeTurnOrchestrated(baseBody(), {
    runtimeTurnService: service,
    clinicIdentityResolver,
    openAIConversationMemoryRepository: repo,
  });

  assert.equal(saveCalls.length, 0);
});

test("e: next turn does not resume the dirty conversation_id — starts clean", async () => {
  const { repo } = makeMemoryRepo("conv_previous_good");

  const turn1 = serviceReturning({
    final_patient_reply: buildMultiRoundFallbackReply("ru"),
    conversation_id: null,
    conversation_id_resumable: false,
  });
  await runRuntimeTurnOrchestrated(baseBody(), {
    runtimeTurnService: turn1.service,
    clinicIdentityResolver,
    openAIConversationMemoryRepository: repo,
  });

  const turn2 = serviceReturning({ final_patient_reply: "Здравствуйте!" });
  await runRuntimeTurnOrchestrated(baseBody(), {
    runtimeTurnService: turn2.service,
    clinicIdentityResolver,
    openAIConversationMemoryRepository: repo,
  });

  const secondInput = turn2.seenInputs[0] as { conversation_id?: string | null };
  assert.notEqual(secondInput.conversation_id, "conv_previous_good");
  assert.ok(secondInput.conversation_id === null || secondInput.conversation_id === undefined);
});

// ── regression: normal successful path still persists/resumes conversation_id ──

test("regression: normal (resumable) conversation_id is still persisted and resumed on the next turn", async () => {
  const { repo, saveCalls } = makeMemoryRepo(null);

  const turn1 = serviceReturning({ final_patient_reply: "Здравствуйте!", conversation_id: "conv_good_new" });
  await runRuntimeTurnOrchestrated(baseBody(), {
    runtimeTurnService: turn1.service,
    clinicIdentityResolver,
    openAIConversationMemoryRepository: repo,
  });
  assert.equal(saveCalls.length, 1);
  assert.equal((saveCalls[0] as any).conversation_id, "conv_good_new");

  const turn2 = serviceReturning({ final_patient_reply: "Продолжаем." });
  await runRuntimeTurnOrchestrated(baseBody(), {
    runtimeTurnService: turn2.service,
    clinicIdentityResolver,
    openAIConversationMemoryRepository: repo,
  });
  const secondInput = turn2.seenInputs[0] as { conversation_id?: string | null };
  assert.equal(secondInput.conversation_id, "conv_good_new");
});

// ── no ClinicCard / live-write involvement (trivially true — no cliniccard executor wired) ──

test("no ClinicCard executor is ever invoked by this test suite", () => {
  // Sanity guard: every runTurn/executor fake above is a plain stub — no real ClinicCard
  // adapter or CLINICCARD_BOOKING_MODE is touched anywhere in this file.
  assert.equal(process.env.CLINICCARD_BOOKING_MODE, undefined);
});
