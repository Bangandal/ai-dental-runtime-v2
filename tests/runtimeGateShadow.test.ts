import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildFallbackRuntimeGateDebug,
  createOpenAIRuntimeGateClassifier,
  normalizeRuntimeGateDebug,
  runRuntimeGateShadow,
  sanitizeRuntimeGateContext,
} from "../src/runtime/runtimeGateShadow.ts";

const examples = [
  {
    name: "greeting is non-operational",
    user_message: "Привет",
    classifier_output: { route: "non_operational", turn_shape: "greeting", confidence: "high", reason: "Greeting only.", should_apply: false },
    route: "non_operational",
    turn_shape: "greeting",
  },
  {
    name: "price question is FAQ and non-operational",
    user_message: "Сколько стоит чистка?",
    classifier_output: { route: "non_operational", turn_shape: "faq", confidence: "high", reason: "Asks for pricing only.", should_apply: false },
    route: "non_operational",
    turn_shape: "faq",
  },
  {
    name: "booking request is operational candidate",
    user_message: "Хочу записаться на прием",
    classifier_output: { route: "operational_candidate", turn_shape: "booking", confidence: "high", reason: "Asks to book an appointment.", should_apply: false },
    route: "operational_candidate",
    turn_shape: "booking",
  },
  {
    name: "mixed booking and price is operational candidate",
    user_message: "Хочу записаться и узнать цены",
    classifier_output: { route: "operational_candidate", turn_shape: "mixed", confidence: "high", reason: "Combines booking with pricing.", should_apply: false },
    route: "operational_candidate",
    turn_shape: "mixed",
  },
  {
    name: "vague short message without pending context is unclear and non-operational",
    user_message: "да",
    classifier_output: { route: "non_operational", turn_shape: "unclear", confidence: "low", reason: "Short ambiguous reply without pending context.", should_apply: false },
    route: "non_operational",
    turn_shape: "unclear",
  },
] as const;

for (const example of examples) {
  test(`runtime gate classifier shape: ${example.name}`, async () => {
    const debug = await runRuntimeGateShadow({
      user_message: example.user_message,
      runtime_context: {},
      classifier: { classifyRuntimeGateTurn: async () => example.classifier_output },
    });

    assert.equal(debug.enabled, true);
    assert.equal(debug.mode, "shadow");
    assert.equal(debug.route, example.route);
    assert.equal(debug.turn_shape, example.turn_shape);
    assert.equal(debug.should_apply, false);
  });
}

test("fallback is safe and non-fatal when classifier throws", async () => {
  const debug = await runRuntimeGateShadow({
    user_message: "Хочу записаться",
    runtime_context: {},
    classifier: { classifyRuntimeGateTurn: async () => { throw new Error("classifier failed"); } },
  });

  assert.deepEqual(debug, buildFallbackRuntimeGateDebug());
});

test("invalid classifier output normalizes conservatively and never applies", () => {
  const debug = normalizeRuntimeGateDebug({
    enabled: false,
    mode: "live",
    route: "book_now",
    turn_shape: "unknown_shape",
    confidence: "certain",
    reason: "   ",
    should_apply: true,
  });

  assert.equal(debug.enabled, true);
  assert.equal(debug.mode, "shadow");
  assert.equal(debug.route, "non_operational");
  assert.equal(debug.turn_shape, "unclear");
  assert.equal(debug.confidence, "low");
  assert.equal(debug.should_apply, false);
});

test("sanitizes runtime context to pending-task signals without mutating input", () => {
  const raw = {
    task_state: { missing_fields: ["service_interest", 7], last_known_intent: "booking", intake_status: "collecting", collected: { name: "Ana" } },
    booking_context: { has_active_hold: true, active_hold: { label: "10:00" } },
    case_context: { has_current_case: true, open_cases_count: 1, current_case: { case_type: "booking" } },
  };

  const sanitized = sanitizeRuntimeGateContext(raw);

  assert.deepEqual((sanitized.task_state as any).missing_fields, ["service_interest"]);
  assert.equal((sanitized.booking_context as any).has_active_hold, true);
  assert.equal((sanitized.case_context as any).has_current_case, true);
  assert.deepEqual((raw.task_state as any).missing_fields, ["service_interest", 7]);
});

test("OpenAI runtime gate classifier uses the supplied mini model and parses output", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const classifier = createOpenAIRuntimeGateClassifier({
    model: "gpt-runtime-gate-mini",
    client: {
      responses: {
        async create(payload: Record<string, unknown>) {
          calls.push(payload);
          return { output_text: "{\"route\":\"non_operational\",\"turn_shape\":\"greeting\",\"confidence\":\"high\",\"reason\":\"Greeting only.\",\"should_apply\":false}" };
        },
      },
    } as any,
  });

  const debug = await runRuntimeGateShadow({ user_message: "hi", runtime_context: {}, classifier });

  assert.equal(calls[0]?.model, "gpt-runtime-gate-mini");
  assert.equal(debug.route, "non_operational");
  assert.equal(debug.turn_shape, "greeting");
});

test("runtime gate source has no apply RPC or regex semantic routing", async () => {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const source = await readFile(resolve(thisDir, "../src/runtime/runtimeGateShadow.ts"), "utf8");

  assert.equal(source.includes("rpc_apply"), false);
  assert.equal(source.includes("new RegExp"), false);
  assert.equal(source.includes("BOOKING_INTENT_PATTERNS"), false);
});
