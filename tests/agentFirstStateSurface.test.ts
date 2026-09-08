import assert from "node:assert/strict";
import test from "node:test";

import { projectModelFacingContext } from "../src/runtime/modelFacingContextProjection.ts";
import { buildOpenAIInput } from "../src/runtime/openaiRuntimeAgentCaller.ts";
import { RUNTIME_AGENT_TOOL_DEFINITIONS } from "../src/runtime/openaiRuntimeAgent.ts";

async function withAgentMode<T>(
  mode: "legacy" | "agent_first",
  fn: () => Promise<T> | T,
): Promise<T> {
  const previous = process.env.RUNTIME_AGENT_MODE;
  process.env.RUNTIME_AGENT_MODE = mode;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.RUNTIME_AGENT_MODE;
    else process.env.RUNTIME_AGENT_MODE = previous;
  }
}

function noisyContext() {
  return {
    locale: "uk",
    channel_context: {
      channel: "telegram",
      patient_reachable_in_current_channel: true,
    },
    booking_process_state: {
      service_reason: "ортодонтія",
      first_name: "Олена",
      last_name: "Коваль",
      preferred_time_text: "завтра",
      last_available_slots: [
        { starts_at: "2026-09-09T10:00:00+02:00" },
        { starts_at: "2026-09-09T11:00:00+02:00" },
      ],
      selected_slot: {
        starts_at: "2026-09-09T10:00:00+02:00",
        ends_at: "2026-09-09T10:30:00+02:00",
        slot_id: "slot_10",
      },
      slot_evidence_status: "verified",
      next_action: "ready_for_booking_apply",
      next_action_confidence: "high",
      proof: {
        service_known: true,
        name_known: true,
        slot_known: true,
        trusted_phone_known: true,
        ready_for_booking_apply: true,
      },
    },
    runtime_context: {
      patient_context: {
        display_name: "Олена",
        preferred_language: "uk",
        reachable_in_current_channel: true,
      },
      task_state: {
        collected: {
          service_interest: "брекети",
          contact_channel_available: true,
        },
        missing_fields: ["preferred_time"],
        last_known_intent: "booking",
        intake_status: "collecting_time",
      },
      qualification_state: {
        complaint: "болить зуб",
        reported_facts: ["біль з вечора"],
        summary: "Пацієнт повідомляє про біль",
        route: "urgent_exam",
        urgency: "urgent",
        red_flags: ["severe_pain"],
        policy_applied: true,
      },
      runtime_policy: {
        phone_required: false,
        patient_reachable_in_current_channel: true,
      },
      recent_history: [
        { role: "assistant", text: "Що саме вас цікавить?" },
        { role: "user", text: "Брекети" },
      ],
      case_context: {
        has_current_case: true,
        current_case: { case_type: "booking", topic: "old topic", status: "open" },
        recent_cases: [{ case_type: "faq", topic: "insurance", status: "closed" }],
      },
      booking_context: {
        has_active_hold: true,
        active_hold: { label: "old hold" },
        latest_appointment: { service_interest: "hygiene", start_at: "2026-08-01T09:00:00" },
      },
    },
  };
}

test("agent-first hides Runtime state machines and model-written summaries", async () => {
  await withAgentMode("agent_first", () => {
    const projected = projectModelFacingContext(noisyContext());

    assert.equal(projected.booking_process_state, undefined);
    assert.deepEqual(projected.booking_selection, {
      status: "verified",
      starts_at: "2026-09-09T10:00:00+02:00",
      ends_at: "2026-09-09T10:30:00+02:00",
      slot_id: "slot_10",
    });

    const runtime = projected.runtime_context as Record<string, any>;
    assert.equal(runtime.case_context, undefined);
    assert.equal(runtime.booking_context, undefined);
    assert.deepEqual(runtime.task_state.collected, { service_interest: "брекети" });
    assert.equal(runtime.task_state.missing_fields, undefined);
    assert.equal(runtime.task_state.last_known_intent, undefined);
    assert.equal(runtime.task_state.intake_status, undefined);
    assert.deepEqual(runtime.runtime_policy, { patient_reachable_in_current_channel: true });
    assert.deepEqual(runtime.qualification_state, {
      complaint: "болить зуб",
      reported_facts: ["біль з вечора"],
    });
  });
});

test("agent-first exposes only verified selected-slot continuity, never stale booking state", async () => {
  await withAgentMode("agent_first", () => {
    const context = noisyContext();
    (context.booking_process_state as Record<string, unknown>).slot_evidence_status = "stale";
    const projected = projectModelFacingContext(context);
    assert.equal(projected.booking_selection, undefined);
    assert.equal(projected.booking_process_state, undefined);
  });
});

test("agent-first people context contains semantic identity only", async () => {
  await withAgentMode("agent_first", () => {
    const projected = projectModelFacingContext({
      runtime_context: {
        booking_subjects: {
          version: 3,
          status: "active",
          active_subject_id: "subject_2",
          pending_typed_phone: "+420777111222",
          max_subjects: 4,
          subjects: [
            {
              id: "subject_1",
              role: "sender",
              person_kind: "self",
              is_active: false,
              label: "я",
              patient_name: "Михайло",
              service: "гігієна",
              slot: "2026-09-12T09:00",
              phone_status: "trusted",
              contact_owner: "subject_1",
              missing: ["slot"],
              status: "collecting",
            },
            {
              id: "subject_2",
              role: "mentioned_person",
              person_kind: "other_person",
              is_active: true,
              label: "мама",
              patient_name: "Олена",
              service: "огляд",
              slot: "2026-09-10T12:00",
              phone_status: "trusted_contact_owner",
              contact_owner: "subject_1",
              missing: [],
              status: "booked",
            },
          ],
        },
      },
    });

    const bookingSubjects = (projected.runtime_context as Record<string, any>).booking_subjects;
    assert.equal(bookingSubjects.version, undefined);
    assert.equal(bookingSubjects.status, undefined);
    assert.equal(bookingSubjects.active_subject_id, undefined);
    assert.equal(bookingSubjects.max_subjects, undefined);
    assert.equal(bookingSubjects.pending_typed_phone, undefined);
    assert.equal(bookingSubjects.has_pending_typed_phone, undefined);

    assert.deepEqual(bookingSubjects.subjects[0], {
      person_kind: "self",
      is_active: false,
      label: "я",
      patient_name: "Михайло",
      service: "гігієна",
    });
    assert.deepEqual(bookingSubjects.subjects[1], {
      person_kind: "other_person",
      is_active: true,
      label: "мама",
      patient_name: "Олена",
      service: "огляд",
    });
  });
});

test("agent-first tool follow-up carries narrow truth, not booking_process_state", async () => {
  await withAgentMode("agent_first", () => {
    const context = noisyContext();
    Object.assign(context, {
      availability_action_truth: {
        outcome: "slots_available",
        requested_date: "2026-09-09",
        can_present_slots: true,
        required_next_action: "choose_slot",
        allowed_slot_starts: ["10:00"],
      },
      availability_presentation_truth: {
        allowed_slot_starts: ["10:00"],
        max_slots_to_present: 3,
      },
    });

    const built = buildOpenAIInput({
      model: "gpt-test",
      conversation_id: "conv_turn",
      system_instruction: "system",
      input: {
        message: "Завтра",
        context,
        tool_definitions: RUNTIME_AGENT_TOOL_DEFINITIONS,
        tool_results: [{
          tool: "availability.check",
          call_id: "call_1",
          status: "success",
          data: { slots: [{ starts_at: "2026-09-09T10:00:00+02:00" }] },
        }],
      },
    } as any) as Record<string, any>;

    const output = JSON.parse(built.input[0].output);
    assert.equal(output.runtime_truth.booking_process_state, undefined);
    assert.deepEqual(output.runtime_truth.availability_action_truth.allowed_slot_starts, ["10:00"]);
    assert.equal(JSON.stringify(output).includes("recent_cases"), false);
    assert.equal(JSON.stringify(output).includes("latest_appointment"), false);
  });
});

test("legacy keeps full historical state surface unchanged", async () => {
  await withAgentMode("legacy", () => {
    const source = noisyContext();
    const projected = projectModelFacingContext(source);
    assert.deepEqual(projected.booking_process_state, source.booking_process_state);
    const runtime = projected.runtime_context as Record<string, any>;
    assert.deepEqual(runtime.case_context, (source.runtime_context as Record<string, any>).case_context);
    assert.deepEqual(runtime.booking_context, (source.runtime_context as Record<string, any>).booking_context);
    assert.deepEqual(runtime.qualification_state, (source.runtime_context as Record<string, any>).qualification_state);
  });
});
