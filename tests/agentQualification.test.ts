import test from "node:test";
import assert from "node:assert/strict";

import {
  mergeAgentQualification,
  parseAgentQualification,
} from "../src/runtime/agentQualification.ts";
import { normalizeOpenAIResponse } from "../src/runtime/openaiRuntimeAgentCaller.ts";
import { buildModelVisibleRuntimeContext } from "../src/runtime/modelVisibleRuntimeContext.ts";

function withAgentFirst<T>(fn: () => T): T {
  const previous = process.env.RUNTIME_AGENT_MODE;
  process.env.RUNTIME_AGENT_MODE = "agent_first";
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.RUNTIME_AGENT_MODE;
    else process.env.RUNTIME_AGENT_MODE = previous;
  }
}

test("qualification keeps patient-reported facts but strips clinical decisions without clinic policy", () => {
  const parsed = parseAgentQualification(
    {
      complaint: "сильная зубная боль",
      reported_facts: ["болит ночью", "пациент сообщил об отёке"],
      summary: "Боль усиливается ночью, пациент сообщает об отёке.",
      route: "acute_exam",
      urgency: "urgent",
      red_flags: ["swelling"],
    },
    { runtime_context: {} },
  );

  assert.deepEqual(parsed, {
    complaint: "сильная зубная боль",
    reported_facts: ["болит ночью", "пациент сообщил об отёке"],
    summary: "Боль усиливается ночью, пациент сообщает об отёке.",
  });
});

test("qualification may keep routing fields only with explicit clinic-owned policy context", () => {
  const parsed = parseAgentQualification(
    {
      complaint: "зубная боль",
      route: "clinic_route_17",
      urgency: "same_day",
      red_flags: ["clinic_flag_a"],
    },
    {
      runtime_context: {
        qualification_policy: {
          enabled: true,
          source: "clinic_policy:v1",
        },
      },
    },
  );

  assert.deepEqual(parsed, {
    complaint: "зубная боль",
    route: "clinic_route_17",
    urgency: "same_day",
    red_flags: ["clinic_flag_a"],
    policy_applied: true,
  });
});

test("qualification merge accumulates patient facts without duplicating them", () => {
  const merged = mergeAgentQualification(
    {
      complaint: "болит зуб",
      reported_facts: ["болит ночью"],
      summary: "Боль ночью.",
    },
    {
      reported_facts: ["болит ночью", "есть чувствительность при накусывании"],
      summary: "Боль ночью и чувствительность при накусывании.",
    },
  );

  assert.deepEqual(merged, {
    complaint: "болит зуб",
    reported_facts: ["болит ночью", "есть чувствительность при накусывании"],
    summary: "Боль ночью и чувствительность при накусывании.",
  });
});

test("agent-first qualification JSON envelope is removed from patient reply", () => {
  withAgentFirst(() => {
    const output = normalizeOpenAIResponse(
      {
        conversation_id: "conv_q1",
        output_text: JSON.stringify({
          reply: "Понял. Подскажите, боль постоянная или только при накусывании?",
          qualification: {
            complaint: "болит зуб",
            reported_facts: ["болит ночью"],
            route: "invented_route",
            urgency: "invented_urgent",
          },
        }),
      },
      null,
      null,
      { runtime_context: {} },
    );

    assert.equal(output.type, "final_response");
    if (output.type !== "final_response") return;
    assert.equal(
      output.final_response.final_patient_reply,
      "Понял. Подскажите, боль постоянная или только при накусывании?",
    );
    assert.deepEqual(output.final_response.qualification, {
      complaint: "болит зуб",
      reported_facts: ["болит ночью"],
    });
    assert.doesNotMatch(output.final_response.final_patient_reply, /qualification|complaint/);
  });
});

test("stored qualification is projected back to the main agent on the next turn", () => {
  const visible = buildModelVisibleRuntimeContext({
    known_contact: {},
    conversation_state: {
      collected: {
        agent_qualification: {
          complaint: "болит зуб",
          reported_facts: ["болит ночью"],
          summary: "Зубная боль ночью.",
        },
      },
      missing_fields: [],
    },
    recent_history: [],
  });

  assert.deepEqual(visible.qualification_state, {
    complaint: "болит зуб",
    reported_facts: ["болит ночью"],
    summary: "Зубная боль ночью.",
  });
});
