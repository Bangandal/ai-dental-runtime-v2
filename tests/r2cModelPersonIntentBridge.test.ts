import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  normalizeSubjectIntentEnvelope,
  parseModelPersonIntents,
} from "../src/runtime/modelPersonIntentBridge.ts";

test("R2c boundary: canonical structured subject intent is preserved", () => {
  const parsed = parseModelPersonIntents({
    subject_intent: {
      action: "switch_subject",
      target: "mentioned_person",
      subject_id: "subject_2",
      display_name: "Eva",
      confidence: "high",
    },
  }, null);

  assert.equal(parsed.subject_intent?.action, "switch_subject");
  assert.equal(parsed.subject_intent?.subject_id, "subject_2");
  assert.equal(parsed.subject_intent?.display_name, "Eva");
});

test("R2c boundary: envelope switch by canonical subject id receives bounded defaults", () => {
  const normalized = normalizeSubjectIntentEnvelope({
    action: "switch_subject",
    subject_id: "subject_3",
  });
  assert.ok(normalized);
  assert.equal(normalized.target, "mentioned_person");
  assert.equal(normalized.confidence, "medium");

  const parsed = parseModelPersonIntents(null, normalized);
  assert.equal(parsed.subject_intent?.subject_id, "subject_3");
});

test("R2c boundary: create_subjects defaults remain bounded", () => {
  const parsed = parseModelPersonIntents(null, {
    action: "create_subjects",
    labels: ["дочь", "сын"],
  });
  assert.equal(parsed.subject_intent?.action, "create_subjects");
  assert.equal(parsed.subject_intent?.count, 2);
  assert.deepEqual(parsed.subject_intent?.labels, ["дочь", "сын"]);
  assert.equal(parsed.subject_intent?.confidence, "medium");
});

test("R2c boundary: removed start_new_episode remains rejected", () => {
  const parsed = parseModelPersonIntents(null, {
    action: "start_new_episode",
    target: "self",
    confidence: "high",
  });
  assert.equal(parsed.subject_intent, undefined);
});

test("R2c boundary: phone ownership intent is parsed beside subject intent", () => {
  const parsed = parseModelPersonIntents({
    phone_ownership_intent: {
      action: "assign_pending_phone",
      target_subject_id: "subject_2",
      confidence: "high",
    },
  }, null);
  assert.equal(parsed.phone_ownership_intent?.action, "assign_pending_phone");
  assert.equal(parsed.phone_ownership_intent?.target_subject_id, "subject_2");
});

test("R2c structure: OpenAI caller no longer owns person-intent protocol details", async () => {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const callerSource = await readFile(resolve(thisDir, "../src/runtime/openaiRuntimeAgentCaller.ts"), "utf8");
  const bridgeSource = await readFile(resolve(thisDir, "../src/runtime/modelPersonIntentBridge.ts"), "utf8");

  assert.match(callerSource, /from\s+["']\.\/modelPersonIntentBridge\.ts["']/);
  assert.doesNotMatch(callerSource, /KNOWN_SUBJECT_ACTIONS/);
  assert.doesNotMatch(callerSource, /VALID_TARGETS/);
  assert.doesNotMatch(callerSource, /SUBJECT_ID_RE/);
  assert.doesNotMatch(callerSource, /parseSubjectIntent/);
  assert.doesNotMatch(callerSource, /parsePhoneOwnershipIntent/);
  assert.doesNotMatch(callerSource, /create_subjects|create_or_switch_subject|mentioned_person/);

  assert.doesNotMatch(bridgeSource, /process\.env/);
  assert.doesNotMatch(bridgeSource, /from\s+["'][^"']*cliniccard[^"']*["']/i);
  assert.doesNotMatch(bridgeSource, /from\s+["'][^"']*supabase[^"']*["']/i);
  assert.doesNotMatch(bridgeSource, /from\s+["'][^"']*telegram[^"']*["']/i);
});
