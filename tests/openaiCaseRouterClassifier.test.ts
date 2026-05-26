import assert from "node:assert/strict";
import test from "node:test";

import { createOpenAICaseRouterClassifier, parseClassifierJson } from "../src/runtime/openaiCaseRouterClassifier.ts";
import { runCaseRouterShadow } from "../src/runtime/caseRouterShadow.ts";

test("parseClassifierJson parses fenced json block", () => {
  const parsed = parseClassifierJson("```json\n{\"case_relation\":\"unknown\"}\n```") as Record<string, unknown>;
  assert.equal(parsed.case_relation, "unknown");
});

test("parseClassifierJson throws invalid_classifier_json for malformed json", () => {
  assert.throws(() => parseClassifierJson("{not-json"), (error: unknown) => {
    return error instanceof Error && error.message === "invalid_classifier_json";
  });
});

test("openai classifier exact-schema response validates as classifier openai", async () => {
  const classifier = createOpenAICaseRouterClassifier({
    model: "gpt-test",
    client: {
      responses: {
        create: async () => ({
          output_text:
            '{"case_relation":"new_case","case_action":"open_case","case_type":"booking_request","topic":"appointment booking","status":"collecting","priority":"normal","confidence":"high","reason":"User asks to schedule an appointment.","should_apply":false}',
        }),
      },
    },
  });

  const result = await runCaseRouterShadow({ user_message: "I want to book", runtime_context: {}, classifier });
  assert.equal(result.classifier, "openai");
  assert.equal(result.decision.case_type, "booking_request");
  assert.equal(result.decision.should_apply, false);
});

test("openai classifier response with legacy classification key falls back", async () => {
  const classifier = createOpenAICaseRouterClassifier({
    model: "gpt-test",
    client: {
      responses: {
        create: async () => ({ output_text: '{"should_apply":false,"classification":"appointment_inquiry","extracted_slots":{}}' }),
      },
    },
  });

  const result = await runCaseRouterShadow({ user_message: "book me", runtime_context: {}, classifier });
  assert.equal(result.classifier, "fallback");
  assert.equal(result.error?.code, "classifier_invalid_output");
});

test("openai classifier live-like price_inquiry output falls back", async () => {
  const classifier = createOpenAICaseRouterClassifier({
    model: "gpt-test",
    client: {
      responses: {
        create: async () => ({ output_text: '{"should_apply":false,"classification":"price_inquiry"}' }),
      },
    },
  });

  const result = await runCaseRouterShadow({ user_message: "how much is cleaning", runtime_context: {}, classifier });
  assert.equal(result.classifier, "fallback");
  assert.equal(result.error?.code, "classifier_invalid_output");
});

test("classifier instructions contain required schema fields and forbid legacy keys", async () => {
  let capturedInstructions = "";
  const classifier = createOpenAICaseRouterClassifier({
    model: "gpt-test",
    client: {
      responses: {
        create: async (input: unknown) => {
          capturedInstructions = (input as { instructions?: string }).instructions ?? "";
          return { output_text: '{"case_relation":"unknown","case_action":"no_case","case_type":"other","topic":null,"status":null,"priority":"low","confidence":"low","reason":"n/a","should_apply":false}' };
        },
      },
    },
  });

  await classifier.classifyCaseTurn({ user_message: "hi", runtime_context: {} });
  assert.match(capturedInstructions, /case_relation/);
  assert.match(capturedInstructions, /case_action/);
  assert.match(capturedInstructions, /case_type/);
  assert.match(capturedInstructions, /topic/);
  assert.match(capturedInstructions, /status/);
  assert.match(capturedInstructions, /priority/);
  assert.match(capturedInstructions, /confidence/);
  assert.match(capturedInstructions, /reason/);
  assert.match(capturedInstructions, /should_apply/);
  assert.match(capturedInstructions, /Do not return these keys: classification, intent, extracted_slots, action, type, booking_intent/);
  assert.match(capturedInstructions, /short or ambiguous/);
  assert.match(capturedInstructions, /last_bot_question/);
});

test("classifier receives compact task continuation context and can return same_case on ambiguous reply", async () => {
  let capturedInput = "";
  const classifier = createOpenAICaseRouterClassifier({
    model: "gpt-test",
    client: {
      responses: {
        create: async (input: unknown) => {
          const payload = (input as { input?: Array<{ content?: Array<{ text?: string }> }> }).input ?? [];
          capturedInput = payload[0]?.content?.[0]?.text ?? "";
          return {
            output_text:
              '{"case_relation":"same_case","case_action":"reuse_case","case_type":"booking_request","topic":"appointment booking","status":"collecting","priority":"normal","confidence":"medium","reason":"Short confirmation interpreted using last bot question and pending slots.","should_apply":false}',
          };
        },
      },
    },
  });

  const result = await runCaseRouterShadow({
    user_message: "да",
    runtime_context: {
      task_state: {
        last_bot_question: "Какое время вам удобно?",
        pending_slots: ["preferred_time"],
        last_known_intent: "booking_request",
      },
      case_context: { current_case: { type: "booking_request", status: "collecting" } },
      booking_context: { in_progress: true },
    },
    classifier,
  });

  assert.match(capturedInput, /last_bot_question/);
  assert.match(capturedInput, /pending_slots/);
  assert.equal(result.classifier, "openai");
  assert.equal(result.decision.case_relation, "same_case");
  assert.equal(result.decision.case_action, "reuse_case");
  assert.equal(result.decision.case_type, "booking_request");
});
