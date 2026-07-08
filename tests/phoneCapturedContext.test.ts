/**
 * PR #166: phone_captured context injection tests.
 *
 * Live regression (post-PR-#165): after patient shared Telegram contact button,
 * the bot continued asking for contact because the model-visible runtime context
 * did not contain any signal that the phone had been received. The guards were
 * correct (phone guard did not fire), but the model lacked explicit confirmation.
 *
 * Root cause: applyMessengerPhonePolicy removed phone from missing_fields and set
 * phone_required: false, but provided no POSITIVE signal. The model saw
 * "phone_required: false" with no explanation and re-asked for contact.
 *
 * Fix (PR #166): when channel_contact.phone_source is a trusted source,
 * applyMessengerPhonePolicy now injects task_state.phone_captured: true and
 * task_state.phone_source into the model-visible runtime context.
 *
 * Tests:
 * PCC-1  Orchestrator: trusted channel_contact → runtimeTurnService receives
 *         business_context.runtime_context.task_state.phone_captured === true
 * PCC-2  Orchestrator: no channel_contact → phone_captured absent from context
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { runRuntimeTurnOrchestrated } from "../src/runtime/runtimeTurnOrchestrator.ts";
import type { RuntimeTurnOrchestratorDeps } from "../src/runtime/runtimeTurnOrchestrator.ts";
import type { RuntimeContextRepository } from "../src/runtime/supabaseRuntimeContextRepository.ts";
import type { ClinicIdentityResolver } from "../src/runtime/supabaseClinicIdentityResolver.ts";
import type { TurnPersistenceRepository } from "../src/runtime/supabaseTurnPersistenceRepository.ts";
import type { RuntimeTurnService, RuntimeTurnInput } from "../src/runtime/runtimeTurnService.ts";

const CLINIC_CODE = "clinic_1";
const CLINIC_UUID = "cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa";
const CONTACT_UUID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

const MINIMAL_BODY = {
  clinic_code: CLINIC_CODE,
  channel: "telegram" as const,
  external_user_id: "ext_pcc_1",
  chat_id: "111",
  text: "[contact_shared]",
  meta: {
    update_id: 400,
    message_id: 90,
    username: null,
    first_name: null,
    last_name: null,
    telegram_chat_type: "private" as const,
  },
};

const stubClinicResolver: ClinicIdentityResolver = {
  async resolveClinicIdentity(input) {
    if (input.clinic_identifier === CLINIC_CODE) {
      return { ok: true, data: { clinic_id: CLINIC_UUID, clinic_code: CLINIC_CODE } };
    }
    return { ok: false, error: { code: "clinic_not_found", message: "not found", retryable: false } };
  },
};

const stubPersistence: TurnPersistenceRepository = {
  async getOrCreateContact() {
    return { ok: true, data: { contact_id: CONTACT_UUID, clinic_id: CLINIC_UUID } };
  },
  async registerInboundEvent() {
    return { ok: true, data: { inbound_event_id: "evt_pcc_1" } };
  },
  async saveMessage() {
    return { ok: true, data: { message_id: "msg_pcc_1" } };
  },
  async mergeConversationState() {
    return { ok: true, data: { ok: true } };
  },
};

function makeContextRepoWithPhone(phoneSource: string | null): RuntimeContextRepository {
  return {
    async loadRuntimeContext() {
      return {
        ok: true,
        data: {
          known_contact: {},
          conversation_state: { missing_fields: ["phone", "service_interest"] },
          topic_memory: null,
          channel_contact: phoneSource
            ? {
                phone_number: "+380991234567",
                phone_source: phoneSource as "telegram_contact_button",
                phone_consent: true,
                phone_collected_at: "2026-07-08T06:00:00.000Z",
              }
            : null,
          case_context_lite: null,
          runtime_flags: {
            has_durable_context: true,
            context_source: "supabase",
            context_loaded_at: "2026-07-08T06:00:00.000Z",
          },
          recent_history: [],
        },
      };
    },
  };
}

function makeCapturingService(): { service: RuntimeTurnService; captured: RuntimeTurnInput[] } {
  const captured: RuntimeTurnInput[] = [];
  const service: RuntimeTurnService = {
    async runTurn(input) {
      captured.push(input);
      return {
        final_patient_reply: "OK",
        conversation_id: null,
        tool_requests: [],
        tool_results: [],
      };
    },
  };
  return { service, captured };
}

// ── PCC-1 ────────────────────────────────────────────────────────────────────

describe("PCC-1: trusted channel_contact → phone_captured: true in model-visible context", () => {
  test("runtimeTurnService receives task_state.phone_captured=true when phone_source=telegram_contact_button", async () => {
    const { service, captured } = makeCapturingService();

    const deps: RuntimeTurnOrchestratorDeps = {
      runtimeTurnService: service,
      clinicIdentityResolver: stubClinicResolver,
      turnPersistenceRepository: stubPersistence,
      runtimeContextRepository: makeContextRepoWithPhone("telegram_contact_button"),
    };

    const result = await runRuntimeTurnOrchestrated(MINIMAL_BODY, deps);

    // Orchestrator must succeed or fall through to error — not short-circuit on duplicate
    assert.ok(
      result.outcome === "success" || result.outcome === "error",
      `unexpected outcome: ${result.outcome}`,
    );

    // runtimeTurnService.runTurn must have been called exactly once
    assert.strictEqual(captured.length, 1, "runtimeTurnService.runTurn must be called once");

    const capturedInput = captured[0]!;
    const runtimeCtx = (capturedInput.business_context?.runtime_context ?? {}) as Record<string, unknown>;
    const taskState = (runtimeCtx.task_state ?? {}) as Record<string, unknown>;

    assert.strictEqual(
      taskState.phone_captured,
      true,
      `task_state.phone_captured must be true — got: ${JSON.stringify(taskState)}`,
    );
    assert.strictEqual(
      taskState.phone_source,
      "telegram_contact_button",
      `task_state.phone_source must be telegram_contact_button — got: ${taskState.phone_source}`,
    );

    // phone must NOT remain in missing_fields
    const missingFields = Array.isArray(taskState.missing_fields) ? taskState.missing_fields : [];
    assert.ok(
      !missingFields.includes("phone"),
      `phone must not be in missing_fields — got: ${JSON.stringify(missingFields)}`,
    );
  });
});

// ── PCC-2 ────────────────────────────────────────────────────────────────────

describe("PCC-2: no channel_contact → phone_captured absent from model-visible context", () => {
  test("runtimeTurnService receives task_state without phone_captured when no trusted phone", async () => {
    const { service, captured } = makeCapturingService();

    const deps: RuntimeTurnOrchestratorDeps = {
      runtimeTurnService: service,
      clinicIdentityResolver: stubClinicResolver,
      turnPersistenceRepository: stubPersistence,
      runtimeContextRepository: makeContextRepoWithPhone(null),
    };

    const result = await runRuntimeTurnOrchestrated(MINIMAL_BODY, deps);

    assert.ok(
      result.outcome === "success" || result.outcome === "error",
      `unexpected outcome: ${result.outcome}`,
    );

    assert.strictEqual(captured.length, 1, "runtimeTurnService.runTurn must be called once");

    const capturedInput = captured[0]!;
    const runtimeCtx = (capturedInput.business_context?.runtime_context ?? {}) as Record<string, unknown>;
    const taskState = (runtimeCtx.task_state ?? {}) as Record<string, unknown>;

    assert.ok(
      !("phone_captured" in taskState),
      `task_state.phone_captured must be absent when no trusted phone — got: ${JSON.stringify(taskState)}`,
    );
  });
});
