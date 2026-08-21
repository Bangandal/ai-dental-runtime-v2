import assert from "node:assert/strict";
import test from "node:test";

import {
  runRuntimeTurnOrchestrated,
  type RuntimeTurnOrchestratorDeps,
} from "../src/runtime/runtimeTurnOrchestrator.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createDeps(input: {
  firstStarted: () => void;
  firstGate: Promise<void>;
  events: string[];
}): RuntimeTurnOrchestratorDeps {
  return {
    clinicIdentityResolver: {
      async resolveClinicIdentity() {
        return {
          ok: true as const,
          data: {
            clinic_id: "00000000-0000-4000-8000-000000000001",
            clinic_code: "clinic_1",
          },
        };
      },
    },
    runtimeTurnService: {
      async runTurn(turn) {
        input.events.push(`${turn.user_message}:start`);
        if (turn.user_message === "first") {
          input.firstStarted();
          await input.firstGate;
        }
        input.events.push(`${turn.user_message}:end`);
        return {
          final_patient_reply: `reply:${turn.user_message}`,
          tool_requests: [],
          tool_results: [],
        };
      },
    },
  };
}

test("PF-008: public orchestrator serializes overlapping turns for the same contact", async () => {
  const firstStarted = deferred();
  const gate = deferred();
  const events: string[] = [];
  const deps = createDeps({
    firstStarted: firstStarted.resolve,
    firstGate: gate.promise,
    events,
  });

  const first = runRuntimeTurnOrchestrated({
    clinic_code: "clinic_1",
    channel: "telegram",
    external_user_id: "patient-42",
    chat_id: "patient-42",
    text: "first",
  }, deps);
  const second = runRuntimeTurnOrchestrated({
    clinic_code: "clinic_1",
    channel: "telegram",
    external_user_id: "patient-42",
    chat_id: "patient-42",
    text: "second",
  }, deps);

  try {
    await firstStarted.promise;
    await Promise.resolve();
    assert.deepEqual(events, ["first:start"]);
  } finally {
    gate.resolve();
  }

  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.outcome, "success");
  assert.equal(secondResult.outcome, "success");
  assert.deepEqual(events, ["first:start", "first:end", "second:start", "second:end"]);
});
