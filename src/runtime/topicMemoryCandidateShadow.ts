import type { TurnUnderstandingDebug, TurnUnderstandingDecision, TurnUnderstandingConfidence } from "./turnUnderstandingShadow.ts";

// Topic Memory Candidate is a shadow-only observability step.
// It is deterministic only and must not call models, write databases,
// mutate runtime state, route live traffic, or change patient-facing replies.

export type TopicMemoryCandidateKind = "service_interest";

export interface TopicMemoryCandidateShadowDebug {
  enabled: true;
  mode: "shadow";
  should_update: boolean;
  topic_kind: TopicMemoryCandidateKind | null;
  topic_value: string | null;
  confidence: TurnUnderstandingConfidence | null;
  reason: string | null;
}

export interface BuildTopicMemoryCandidateShadowInput {
  turn_understanding: TurnUnderstandingDebug;
}

export function buildTopicMemoryCandidateShadow(
  input: BuildTopicMemoryCandidateShadowInput,
): TopicMemoryCandidateShadowDebug {
  const turnUnderstanding = input.turn_understanding;

  if (turnUnderstanding.skipped) {
    return emptyTopicMemoryCandidate("turn_understanding_skipped");
  }

  if (!turnUnderstanding.decision) {
    return emptyTopicMemoryCandidate("turn_understanding_missing_decision");
  }

  const serviceInterest = readServiceInterest(turnUnderstanding.decision);
  if (!serviceInterest) {
    return emptyTopicMemoryCandidate(null);
  }

  return {
    enabled: true,
    mode: "shadow",
    should_update: true,
    topic_kind: "service_interest",
    topic_value: serviceInterest,
    confidence: turnUnderstanding.decision.confidence,
    reason: null,
  };
}

function emptyTopicMemoryCandidate(reason: string | null): TopicMemoryCandidateShadowDebug {
  return {
    enabled: true,
    mode: "shadow",
    should_update: false,
    topic_kind: null,
    topic_value: null,
    confidence: null,
    reason,
  };
}

function readServiceInterest(decision: TurnUnderstandingDecision): string | null {
  return readString(decision.slot_updates.service_interest) ?? readString(decision.service_interest);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
