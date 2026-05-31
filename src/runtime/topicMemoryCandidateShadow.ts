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

interface ServiceKeywordCandidate {
  topic_value: string;
}

const FAQ_SERVICE_KEYWORDS: readonly { readonly topic_value: string; readonly terms: readonly string[] }[] = [
  { topic_value: "удаление зуба", terms: ["удаление зуба", "вырывание зуба", "вырвать зуб", "видалення зуба", "tooth extraction", "extrakce"] },
  { topic_value: "отбеливание зубов", terms: ["отбеливание зубов", "отбеливание", "відбілювання", "whitening", "bělení"] },
  { topic_value: "чистка зубов", terms: ["чистка зубов", "чистка", "гигиена", "dentální hygiena", "čištění zubů", "teeth cleaning", "чистка зубів"] },
  { topic_value: "консультация ортодонта", terms: ["консультация ортодонта", "ортодонт консультация"] },
  { topic_value: "пломба", terms: ["пломба", "пломбу", "пломбы"] },
  { topic_value: "tooth filling", terms: ["filling", "výplň"] },
  { topic_value: "кариес", terms: ["кариес"] },
  { topic_value: "брекеты", terms: ["брекеты", "брекети", "braces", "rovnátka"] },
  { topic_value: "коронка", terms: ["коронка"] },
  { topic_value: "имплант", terms: ["имплант"] },
];

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

  const faqKeywordCandidate = buildFaqServiceKeywordCandidate(input);
  if (faqKeywordCandidate) {
    return {
      enabled: true,
      mode: "shadow",
      should_update: true,
      topic_kind: "service_interest",
      topic_value: faqKeywordCandidate.topic_value,
      confidence: "medium",
      reason: "non_operational_service_keyword",
    };
  }

  if (turnUnderstanding.skipped) {
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

function buildFaqServiceKeywordCandidate(input: BuildTopicMemoryCandidateShadowInput): ServiceKeywordCandidate | null {
  if (!isFaqServiceKeywordEligible(input.runtime_gate)) return null;

  const normalizedUserMessage = normalizeText(input.user_message);
  if (!normalizedUserMessage) return null;

  for (const keyword of FAQ_SERVICE_KEYWORDS) {
    if (keyword.terms.some((term) => normalizedUserMessage.includes(normalizeText(term)))) {
      return { topic_value: keyword.topic_value };
    }
  }

  return null;
}

function isFaqServiceKeywordEligible(runtimeGate: RuntimeGateDebug | undefined): boolean {
  return runtimeGate?.route === "non_operational" && (runtimeGate.turn_shape === "faq" || runtimeGate.turn_shape === "unclear");
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim().toLocaleLowerCase() : "";
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
