import type { OpenAIResponsesClient } from "./openaiRuntimeAgentCaller.ts";
import type { CaseRouterClassifier, CaseRouterClassifierInput } from "./caseRouterShadow.ts";

const CASE_ROUTER_INSTRUCTIONS = [
  "You are a shadow-only case router classifier.",
  "Classify only. Do not answer the patient.",
  "Do not decide booking execution.",
  "Do not create or update cases.",
  "Return JSON only with the requested schema.",
  "should_apply must always be false.",
].join(" ");

export function createOpenAICaseRouterClassifier(deps: { client: OpenAIResponsesClient; model: string }): CaseRouterClassifier {
  return {
    async classifyCaseTurn(input: CaseRouterClassifierInput): Promise<unknown> {
      const response = await deps.client.responses.create({
        model: deps.model,
        instructions: CASE_ROUTER_INSTRUCTIONS,
        input: [{ role: "user", content: [{ type: "input_text", text: JSON.stringify(input) }] }],
      });
      return parseClassifierOutput(response);
    },
  };
}

function parseClassifierOutput(raw: unknown): unknown {
  const obj = asObject(raw);
  const outputText = readString(obj?.output_text);
  if (outputText) return parseClassifierJson(outputText);
  const output = obj?.output;
  if (!Array.isArray(output)) throw new Error("missing_classifier_output");
  for (const item of output) {
    const itemObj = asObject(item);
    if (!itemObj || readString(itemObj.type) !== "message") continue;
    const content = itemObj.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const partObj = asObject(part);
      if (!partObj || readString(partObj.type) !== "output_text") continue;
      const text = readString(partObj.text);
      if (text) return parseClassifierJson(text);
    }
  }
  throw new Error("missing_classifier_output");
}

export function parseClassifierJson(text: string): unknown {
  const trimmed = text.trim();
  const candidate = extractJsonCandidate(trimmed);
  try {
    return JSON.parse(candidate);
  } catch {
    throw new Error("invalid_classifier_json");
  }
}

function extractJsonCandidate(text: string): string {
  const startFence = "```";
  const firstFence = text.indexOf(startFence);
  if (firstFence === -1) return text;
  const secondFence = text.indexOf(startFence, firstFence + startFence.length);
  if (secondFence === -1) return text;
  const fencedBody = text.slice(firstFence + startFence.length, secondFence).trim();
  if (fencedBody.startsWith("json")) {
    return fencedBody.slice(4).trim();
  }
  return fencedBody;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
