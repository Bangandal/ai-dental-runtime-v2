/**
 * PR #140 amendment — openaiRuntimeCaseLiteExtractor output dedup regression tests (A–C).
 *
 * Verifies that parseExtractorOutput uses deduped output[] logic before falling back
 * to response.output_text, preventing the duplicate-block bug introduced by gpt-5.4-mini.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readResponseOutputTextDeduped } from "../src/runtime/openaiResponsesOutputText.ts";

// ── Shared helpers matching the extractor's internal logic ───────────────────

function makeOutputBlock(text: string) {
  return { type: "message", content: [{ type: "output_text", text }] };
}

// ── Test A: duplicate identical output_text blocks ────────────────────────────
// gpt-5.4-mini emits the same JSON as two separate output_text blocks;
// SDK-level output_text becomes doubled JSON → JSON.parse fails → extractor returns {}.
// Fix: read output[] with dedup, ignore the doubled SDK-level string.

test("A: two identical output_text blocks → dedup returns first block only", () => {
  const json = '{"active_intent":"booking","booking":{"first_name":"Роман"}}';
  const output = [makeOutputBlock(json), makeOutputBlock(json)];
  const result = readResponseOutputTextDeduped(output);
  assert.equal(result, json, "should return the single deduplicated block, not a doubled string");
});

test("A: doubled SDK output_text (as if read directly) would fail JSON.parse", () => {
  const json = '{"active_intent":"booking","booking":{"first_name":"Роман"}}';
  const doubled = json + json;
  assert.throws(() => JSON.parse(doubled), "doubled JSON string must not be valid JSON");
});

test("A: deduplicated output from output[] is valid JSON with expected fields", () => {
  const json = '{"active_intent":"booking","booking":{"first_name":"Роман"}}';
  const output = [makeOutputBlock(json), makeOutputBlock(json)];
  const text = readResponseOutputTextDeduped(output);
  assert.ok(text !== null);
  const parsed = JSON.parse(text!) as Record<string, unknown>;
  assert.equal(parsed.active_intent, "booking");
  assert.equal((parsed.booking as Record<string, unknown>).first_name, "Роман");
});

// ── Test B: distinct split output_text blocks ─────────────────────────────────
// Model emits first half of JSON in block 1, second half in block 2.
// Fix: parts differ → concatenate in order.

test("B: two distinct output_text blocks → concatenated and parsed successfully", () => {
  const part1 = '{"active_intent":"booking",';
  const part2 = '"booking":{"preferred_time_mode":"asap"}}';
  const output = [makeOutputBlock(part1), makeOutputBlock(part2)];
  const text = readResponseOutputTextDeduped(output);
  assert.ok(text !== null);
  const parsed = JSON.parse(text!) as Record<string, unknown>;
  assert.equal(parsed.active_intent, "booking");
  assert.equal((parsed.booking as Record<string, unknown>).preferred_time_mode, "asap");
});

test("B: concatenation order is preserved (part1 before part2)", () => {
  const part1 = '{"active_intent":"faq"';
  const part2 = "}";
  const output = [makeOutputBlock(part1), makeOutputBlock(part2)];
  const text = readResponseOutputTextDeduped(output);
  assert.equal(text, part1 + part2);
});

// ── Test C: no output_text parts → fallback to response.output_text ───────────
// When output[] contains no output_text blocks, dedup returns null so
// the extractor falls back to response.output_text.

test("C: output[] with no output_text content → readResponseOutputTextDeduped returns null", () => {
  const output = [{ type: "message", content: [] }];
  const result = readResponseOutputTextDeduped(output);
  assert.equal(result, null, "should return null when no output_text parts found");
});

test("C: null output → returns null", () => {
  assert.equal(readResponseOutputTextDeduped(null), null);
});

test("C: non-array output → returns null", () => {
  assert.equal(readResponseOutputTextDeduped("string"), null);
  assert.equal(readResponseOutputTextDeduped({}), null);
});

test("C: empty output array → returns null", () => {
  assert.equal(readResponseOutputTextDeduped([]), null);
});
