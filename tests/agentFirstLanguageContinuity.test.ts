import assert from "node:assert/strict";
import test from "node:test";

import { projectModelFacingContext } from "../src/runtime/modelFacingContextProjection.ts";

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

test("agent-first suppresses conflicting channel hint after patient language is established", async () => {
  await withAgentMode("agent_first", () => {
    const projected = projectModelFacingContext({
      locale: "cs",
      channel_context: { channel: "telegram" },
      runtime_context: {
        patient_context: { preferred_language: "uk" },
        recent_history: [
          { role: "user", text: "Мені потрібна консультація" },
          { role: "assistant", text: "Добре, коли вам зручно?" },
          { role: "user", text: "17:00" },
        ],
      },
    });

    const channel = projected.channel_context as Record<string, unknown>;
    assert.equal(channel.language_hint, undefined);
  });
});

test("agent-first suppresses hint for short confirmation after established dialogue", async () => {
  await withAgentMode("agent_first", () => {
    const projected = projectModelFacingContext({
      locale: "cs",
      channel_context: { channel: "telegram" },
      runtime_context: {
        recent_history: [
          { role: "user", text: "Хочу записатися на гігієну" },
          { role: "assistant", text: "Перевірити завтра?" },
          { role: "user", text: "Так" },
        ],
      },
    });

    const channel = projected.channel_context as Record<string, unknown>;
    assert.equal(channel.language_hint, undefined);
  });
});

test("agent-first keeps channel hint when no prior substantive patient language exists", async () => {
  await withAgentMode("agent_first", () => {
    const projected = projectModelFacingContext({
      locale: "cs",
      channel_context: { channel: "telegram" },
      runtime_context: {
        recent_history: [
          { role: "user", text: "17:00" },
        ],
      },
    });

    const channel = projected.channel_context as Record<string, unknown>;
    assert.equal(channel.language_hint, "cs");
  });
});
