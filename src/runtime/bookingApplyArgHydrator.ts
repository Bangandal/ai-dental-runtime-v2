import type { BookingProcessState } from "./bookingProcessState.ts";

// Words that look like Cyrillic capitalised words but are NOT personal names.
// Checked against the capitalised form, so "как" becomes "Как" before matching.
const NAME_EXCLUSION_SET = new Set([
  "Как", "Можно", "Скорее", "Срочно", "Быстро", "Сегодня", "Завтра",
  "Утром", "Вечером", "Хочу", "Нужно", "Болит", "Болят", "Зуб", "Зубы",
  "Клиника", "Стоматология", "Боль", "Записаться", "Запишите", "Запись",
  "Пожалуйста", "Спасибо", "Привет", "Добрый", "День", "Вечер", "Утро",
  "Хорошо", "Подходит", "Давайте", "Оформляйте", "Ладно", "Да", "Нет",
  "Срочно", "Сильно", "Очень", "Прямо", "Сейчас", "Можете",
]);

// Regex: pure Cyrillic word (letters only, 2+ chars).
const CYRILLIC_PURE = /^[а-яёА-ЯЁ]{2,}$/;

function capitalise(word: string): string {
  if (!word) return word;
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/**
 * Attempt to find a two-word Cyrillic personal name in a text snippet.
 * Returns [firstName, lastName] or null.
 */
function extractCyrillicName(text: string): [string, string] | null {
  // Split into segments by punctuation/newline, try each segment.
  const segments = text.split(/[\n\r.,!?;:]+/);
  for (const seg of segments) {
    const words = seg.trim().split(/\s+/).filter(Boolean);
    for (let i = 0; i < words.length - 1; i++) {
      const w1 = capitalise(words[i]);
      const w2 = capitalise(words[i + 1]);
      if (
        CYRILLIC_PURE.test(w1) && !NAME_EXCLUSION_SET.has(w1) &&
        CYRILLIC_PURE.test(w2) && !NAME_EXCLUSION_SET.has(w2)
      ) {
        return [w1, w2];
      }
    }
  }
  return null;
}

function containsUrgentPainSignal(text: string): boolean {
  const t = text.toLowerCase();
  return (
    t.includes("болит зуб") || t.includes("болят зубы") ||
    t.includes("зубная боль") || t.includes("сильно болит") ||
    t.includes("боль в зуб") || t.includes("зуб болит")
  );
}

function containsBookingIntent(text: string): boolean {
  const t = text.toLowerCase();
  return (
    t.includes("хочу записаться") || t.includes("запишите") ||
    t.includes("записаться") || t.includes("хочу попасть") ||
    t.includes("оформите") || t.includes("оформляйте")
  );
}

const ACCEPTANCE_RE = /^(да|ок|окей|хорошо|подходит|давайте|да\s+оформляйте|подойдёт|подойдет|согласен|согласна|отлично|записывайте)\.?$/i;
const TIME_RE = /\b(\d{1,2}:\d{2})\b/;

/** Extract HH:MM and YYYY-MM-DD from an ISO starts_at string. */
function parseSlotDateTime(startsAt: string): { time: string; date: string } | null {
  // Expected: "2026-07-06T17:30:00" or "2026-07-06T17:30"
  const match = startsAt.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  if (!match) return null;
  return { date: match[1], time: match[2] };
}

export interface BookingApplyHydrationDebug {
  applied: boolean;
  hydrated_fields: string[];
  evidence: {
    first_name?: "recent_history" | "current_message";
    last_name?: "recent_history" | "current_message";
    service?: "urgent_pain_booking_context";
    service_reason?: "urgent_pain_booking_context";
    requested_time?: "selected_slot" | "offered_slot_acceptance";
    requested_date?: "selected_slot" | "offered_slot_acceptance";
  };
}

export interface BookingApplyArgHydrationResult {
  args: Record<string, unknown>;
  applied: boolean;
  debug: BookingApplyHydrationDebug;
}

/**
 * Best-effort hydration of missing booking.apply args from conversation context.
 * Explicit non-empty model args always win — only fills missing/empty fields.
 * Guards remain authoritative and run after hydration.
 */
export function hydrateBookingApplyArgs(
  originalArgs: Record<string, unknown>,
  context: {
    userMessage: string;
    recentHistory: Array<{ role: string; content: string }>;
    bookingProcessState: BookingProcessState | null;
  },
): BookingApplyArgHydrationResult {
  const args: Record<string, unknown> = { ...originalArgs };
  const hydrated_fields: string[] = [];
  const evidence: BookingApplyHydrationDebug["evidence"] = {};

  const { userMessage, recentHistory, bookingProcessState } = context;

  // ── 1. Hydrate first_name / last_name ──────────────────────────────────────
  const needsName =
    (typeof args.first_name !== "string" || !args.first_name.trim()) &&
    (typeof args.last_name !== "string" || !args.last_name.trim());

  if (needsName) {
    // Search recent user messages most-recent first, then current message.
    const userMessages = recentHistory
      .filter((m) => m.role === "user")
      .map((m) => m.content)
      .reverse(); // most recent first

    let found: [string, string] | null = null;
    let source: "recent_history" | "current_message" = "current_message";

    for (const msg of userMessages) {
      found = extractCyrillicName(msg);
      if (found) { source = "recent_history"; break; }
    }
    if (!found) {
      found = extractCyrillicName(userMessage);
      if (found) source = "current_message";
    }

    if (found) {
      args.first_name = found[0];
      args.last_name = found[1];
      hydrated_fields.push("first_name", "last_name");
      evidence.first_name = source;
      evidence.last_name = source;
    }
  }

  // ── 2. Hydrate service / service_reason ───────────────────────────────────
  const needsService =
    (typeof args.service !== "string" || !args.service.trim()) &&
    (typeof args.service_reason !== "string" || !args.service_reason.trim());

  if (needsService) {
    const allUserText = [
      userMessage,
      ...recentHistory.filter((m) => m.role === "user").map((m) => m.content),
    ].join(" ");

    const hasPain = containsUrgentPainSignal(allUserText);
    const hasIntent = containsBookingIntent(allUserText);

    if (hasPain && hasIntent) {
      args.service_reason = "осмотр из-за боли";
      hydrated_fields.push("service_reason");
      evidence.service_reason = "urgent_pain_booking_context";
    }
  }

  // ── 3. Hydrate requested_time / requested_date ────────────────────────────
  const needsTime =
    typeof args.requested_time !== "string" || !args.requested_time.trim();

  if (needsTime) {
    let hydratedTime: string | null = null;
    let hydratedDate: string | null = null;
    let timeEvidence: "selected_slot" | "offered_slot_acceptance" | null = null;

    // Source 1: selected_slot from booking process state
    if (bookingProcessState?.selected_slot) {
      const parsed = parseSlotDateTime(bookingProcessState.selected_slot.starts_at);
      if (parsed) {
        hydratedTime = parsed.time;
        hydratedDate = parsed.date;
        timeEvidence = "selected_slot";
      }
    }

    // Source 2: single available slot
    if (!hydratedTime && bookingProcessState?.last_available_slots?.length === 1) {
      const parsed = parseSlotDateTime(bookingProcessState.last_available_slots[0].starts_at);
      if (parsed) {
        hydratedTime = parsed.time;
        hydratedDate = parsed.date;
        timeEvidence = "selected_slot";
      }
    }

    // Source 3: user acceptance + time from recent assistant message
    if (!hydratedTime && ACCEPTANCE_RE.test(userMessage.trim())) {
      const assistantMessages = recentHistory
        .filter((m) => m.role === "assistant")
        .map((m) => m.content)
        .reverse(); // most recent first

      for (const msg of assistantMessages) {
        const match = msg.match(TIME_RE);
        if (match) {
          hydratedTime = match[1];
          timeEvidence = "offered_slot_acceptance";
          // Try to get date from selected_slot or last_available_slots
          if (bookingProcessState?.selected_slot) {
            const parsed = parseSlotDateTime(bookingProcessState.selected_slot.starts_at);
            hydratedDate = parsed?.date ?? null;
          } else if (bookingProcessState?.last_available_slots?.length) {
            // Find slot matching the time
            for (const slot of bookingProcessState.last_available_slots) {
              const parsed = parseSlotDateTime(slot.starts_at);
              if (parsed && parsed.time === hydratedTime) {
                hydratedDate = parsed.date;
                break;
              }
            }
          }
          break;
        }
      }
    }

    if (hydratedTime && timeEvidence) {
      args.requested_time = hydratedTime;
      hydrated_fields.push("requested_time");
      evidence.requested_time = timeEvidence;

      if (hydratedDate && (typeof args.requested_date !== "string" || !args.requested_date.trim())) {
        args.requested_date = hydratedDate;
        hydrated_fields.push("requested_date");
        evidence.requested_date = timeEvidence;
      }
    }
  }

  const applied = hydrated_fields.length > 0;
  return {
    args,
    applied,
    debug: { applied, hydrated_fields, evidence },
  };
}
