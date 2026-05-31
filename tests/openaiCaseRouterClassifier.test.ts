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

  const result = await runCaseRouterShadow({ user_message: "I want to book", runtime_context: {}, classifier, enabled: true });
  assert.equal(result.classifier, "openai");
  assert.equal(result.classifier_model, "gpt-test");
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

  const result = await runCaseRouterShadow({ user_message: "book me", runtime_context: {}, classifier, enabled: true });
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

  const result = await runCaseRouterShadow({ user_message: "how much is cleaning", runtime_context: {}, classifier, enabled: true });
  assert.equal(result.classifier, "fallback");
  assert.equal(result.error?.code, "classifier_invalid_output");
});

test("malformed classifier json preserves classifier_model in fallback debug", async () => {
  const classifier = createOpenAICaseRouterClassifier({
    model: "gpt-case-router-mini",
    client: {
      responses: {
        create: async () => ({ output_text: "{not-json" }),
      },
    },
  });

  const result = await runCaseRouterShadow({ user_message: "да", runtime_context: {}, classifier, enabled: true });
  assert.equal(result.classifier, "fallback");
  assert.equal(result.error?.code, "invalid_classifier_json");
  assert.equal(result.classifier_model, "gpt-case-router-mini");
  assert.equal(typeof result.classifier_raw_output, "string");
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
});
