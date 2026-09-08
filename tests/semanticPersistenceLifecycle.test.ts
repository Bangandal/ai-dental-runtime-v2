import assert from "node:assert/strict";
import test from "node:test";

import { withAgentQualificationPersistence } from "../src/runtime/runtimeTurnOrchestrator.ts";

test("agent-first persistence timestamps new qualification/staff/PEOPLE and does not merge stale qualification", async () => {
  const previousMode = process.env.RUNTIME_AGENT_MODE;
  try {
    process.env.RUNTIME_AGENT_MODE = "agent_first";
    let persistedInput: Record<string, any> | null = null;

    const deps: any = {
      runtimeContextRepository: {
        async loadRuntimeContext() {
          return {
            ok: true,
            data: {
              known_contact: {},
              conversation_state: {
                collected: {
                  agent_qualification: {
                    complaint: "old complaint",
                    reported_facts: ["old fact"],
                  },
                  agent_qualification_updated_at: "2026-09-06T08:00:00.000Z",
                },
              },
              booking_subjects: {
                version: 3,
                status: "active",
                active_subject_id: "subject_1",
                subjects: [],
                pending_typed_phone: null,
                max_subjects: 4,
              },
              recent_history: [
                { role: "user", text: "old topic", created_at: "2026-09-06T08:00:00.000Z" },
                { role: "assistant", text: "old reply", created_at: "2026-09-06T08:01:00.000Z" },
                { role: "user", text: "new session", created_at: "2026-09-08T10:00:00.000Z" },
              ],
            },
          };
        },
      },
      runtimeTurnService: {
        async runTurn() {
          return {
            final_patient_reply: "ok",
            tool_requests: [],
            tool_results: [],
            qualification: {
              complaint: "new complaint",
              reported_facts: ["new fact"],
            },
            staff_request_state: {
              request: {
                kind: "callback",
                patient_target: "self",
                person_ref: "Mila",
                summary: "Please call",
                preferred_contact_window: null,
                reply_language: "ru",
              },
              proof: {
                type: "staff_request",
                request_id: "req-1",
                request_saved: true,
                delivery_status: "sent",
                delivery_recorded: true,
                may_claim_notified: true,
              },
            },
          };
        },
      },
      turnPersistenceRepository: {
        async mergeConversationState(input: Record<string, any>) {
          persistedInput = input;
          return { ok: true, data: { ok: true } };
        },
      },
    };

    const wrapped = withAgentQualificationPersistence(deps);
    const loaded = await wrapped.runtimeContextRepository!.loadRuntimeContext({ clinic_id: "clinic", contact_id: "contact" });
    assert.equal(loaded.ok, true);
    if (loaded.ok) {
      assert.equal(loaded.data.booking_subjects, null, "stale PEOPLE registry must be hidden from execution");
    }
    await wrapped.runtimeTurnService.runTurn({} as any);
    await wrapped.turnPersistenceRepository!.mergeConversationState({
      clinic_id: "clinic",
      contact_id: "contact",
      user_text: "new session",
      reply_text: "ok",
      requested_action: "continue",
      conversation_intent: "unknown",
      handoff_recommended: false,
      confidence: "medium",
      control_flags: {
        booking_subjects: {
          version: 3,
          status: "active",
          active_subject_id: "subject_2",
          subjects: [{ id: "subject_2", patient_name: "Anna" }],
          pending_typed_phone: null,
          max_subjects: 4,
        },
      },
    });

    assert.ok(persistedInput);
    const collected = persistedInput!.control_flags.collected;
    assert.deepEqual(collected.agent_qualification, {
      complaint: "new complaint",
      reported_facts: ["new fact"],
    });
    assert.equal(collected.agent_staff_request.request.summary, "Please call");
    assert.equal(typeof collected.agent_qualification_updated_at, "string");
    assert.equal(typeof collected.agent_staff_request_updated_at, "string");
    assert.equal(typeof collected.booking_subjects_updated_at, "string");
    assert.equal(new Date(collected.agent_qualification_updated_at).getTime() > 0, true);
    assert.equal(JSON.stringify(collected.agent_qualification).includes("old fact"), false);
  } finally {
    if (previousMode === undefined) delete process.env.RUNTIME_AGENT_MODE;
    else process.env.RUNTIME_AGENT_MODE = previousMode;
  }
});

test("unchanged PEOPLE registry does not refresh its session timestamp", async () => {
  const previousMode = process.env.RUNTIME_AGENT_MODE;
  try {
    process.env.RUNTIME_AGENT_MODE = "agent_first";
    const sameSubjects = {
      version: 3,
      status: "active",
      active_subject_id: "subject_1",
      subjects: [],
      pending_typed_phone: null,
      max_subjects: 4,
    };
    let persistedInput: Record<string, any> | null = null;

    const deps: any = {
      runtimeContextRepository: {
        async loadRuntimeContext() {
          return {
            ok: true,
            data: {
              known_contact: {},
              conversation_state: { collected: {} },
              booking_subjects: sameSubjects,
              recent_history: [
                { role: "user", text: "hello", created_at: "2026-09-08T10:00:00.000Z" },
              ],
            },
          };
        },
      },
      runtimeTurnService: {
        async runTurn() {
          return { final_patient_reply: "ok", tool_requests: [], tool_results: [] };
        },
      },
      turnPersistenceRepository: {
        async mergeConversationState(input: Record<string, any>) {
          persistedInput = input;
          return { ok: true, data: { ok: true } };
        },
      },
    };

    const wrapped = withAgentQualificationPersistence(deps);
    const loaded = await wrapped.runtimeContextRepository!.loadRuntimeContext({ clinic_id: "clinic", contact_id: "contact" });
    assert.equal(loaded.ok, true);
    if (loaded.ok) {
      assert.equal(loaded.data.booking_subjects, null, "unversioned PEOPLE registry stays stale for execution");
    }
    await wrapped.runtimeTurnService.runTurn({} as any);
    await wrapped.turnPersistenceRepository!.mergeConversationState({
      clinic_id: "clinic",
      contact_id: "contact",
      user_text: "hello",
      reply_text: "ok",
      requested_action: "continue",
      conversation_intent: "unknown",
      handoff_recommended: false,
      confidence: "medium",
      control_flags: { booking_subjects: sameSubjects },
    });

    assert.ok(persistedInput);
    const collected = persistedInput!.control_flags.collected;
    assert.equal(collected?.booking_subjects_updated_at, undefined);
  } finally {
    if (previousMode === undefined) delete process.env.RUNTIME_AGENT_MODE;
    else process.env.RUNTIME_AGENT_MODE = previousMode;
  }
});
