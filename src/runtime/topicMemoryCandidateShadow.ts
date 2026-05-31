import type { RuntimeGateDebug } from "./runtimeGateShadow.ts";
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
  user_message?: string;
  runtime_gate?: RuntimeGateDebug;
  turn_understanding: TurnUnderstandingDebug;
}

export function buildTopicMemoryCandidateShadow(
  input: BuildTopicMemoryCandidateShadowInput,
): TopicMemoryCandidateShadowDebug {
  const turnUnderstanding = input.turn_understanding;

  if (turnUnderstanding.decision) {
    const serviceInterest = readServiceInterest(turnUnderstanding.decision);
    if (serviceInterest) {
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
  }

  if (turnUnderstanding.skipped) {
    if (isNonOperationalFaqOrUnclear(input.runtime_gate)) {
      // TODO: FAQ topic extraction must come from a typed/domain data source later,
      // such as clinic service catalog or KB metadata, a typed service ontology,
      // configurable per-clinic service aliases, or a separate approved topic extractor
      // contract. Do not infer service topics from hardcoded runtime aliases here.
      return emptyTopicMemoryCandidate("no_typed_topic_source");
    }

    return emptyTopicMemoryCandidate("turn_understanding_skipped");
  }

  if (!turnUnderstanding.decision) {
    return emptyTopicMemoryCandidate("turn_understanding_missing_decision");
  }

  return emptyTopicMemoryCandidate(null);
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

function isNonOperationalFaqOrUnclear(runtimeGate: RuntimeGateDebug | undefined): boolean {
  return runtimeGate?.route === "non_operational" && (runtimeGate.turn_shape === "faq" || runtimeGate.turn_shape === "unclear");
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
