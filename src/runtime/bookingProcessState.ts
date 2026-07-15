import type { RuntimeAgentToolResult, ChannelContact } from "./openaiRuntimeAgent.ts";
import { hasTrustedPhone } from "./bookingContactGuard.ts";

export interface AvailableSlot {
  starts_at: string;
  ends_at?: string;
  slot_id?: string;
}

export type BookingNextAction =
  | "ask_for_service"
  | "ask_for_name"
  | "ask_for_slot"
  | "ask_for_phone"
  | "choose_from_available_slots"
  | "ready_for_booking_apply";

export interface BookingProcessState {
  service_reason?: string;
  first_name?: string;
  last_name?: string;
  preferred_time_text?: string;
  last_available_slots?: AvailableSlot[];
  selected_slot?: AvailableSlot | null;
  phone_trusted?: boolean;
  phone_source?: string;
  next_action?: BookingNextAction;
  proof: {
    service_known: boolean;
    name_known: boolean;
    slot_known: boolean;
    trusted_phone_known: boolean;
    ready_for_booking_apply: boolean;
  };
}

export type BookingStateConfidence = "high" | "low";

export interface ModelVisibleBookingProcessState extends Partial<BookingProcessState> {
  next_action_confidence: BookingStateConfidence;
}

export interface BookingProcessStateLoadDebug {
  loaded: boolean;
  reason?: "null_or_missing" | "rpc_error";
  error?: string;
}

export interface BookingProcessStateRepository {
  loadState(
    key: { clinic_id: string; contact_id?: string | null; case_id?: string | null },
    onDebug?: (info: BookingProcessStateLoadDebug) => void,
  ): Promise<Partial<BookingProcessState> | null>;
  saveState(
    key: { clinic_id: string; contact_id?: string | null; case_id?: string | null },
    state: BookingProcessState,
    onDebug?: (info: { saved: boolean; error?: string }) => void,
  ): Promise<void>;
}

/**
 * Returns true if the persisted state contains meaningful booking data
 * (not just an empty-state default).
 */
export function hasMeaningfulBookingState(state: Partial<BookingProcessState>): boolean {
  return !!(
    state.service_reason ||
    state.first_name ||
    state.last_name ||
    state.selected_slot ||
    (state.last_available_slots && state.last_available_slots.length > 0)
  );
}

/**
 * Safe next_action values that can be exposed to the model.
 *
 * ask_for_service and ask_for_name are NEVER exposed because the runtime cannot
 * reliably extract service/name from free-form patient text. Exposing them causes
 * the model to re-ask fields the patient already provided in conversation.
 * Conversation memory + recent_history handle collection; booking.apply guards enforce
 * that these fields are present before any live write.
 */
const SAFE_VISIBLE_NEXT_ACTIONS = new Set<BookingNextAction>([
  "ask_for_slot",
  "choose_from_available_slots",
  "ask_for_phone",
  "ready_for_booking_apply",
]);

/**
 * Resolves which next_action (if any) to expose to the model.
 *
 * Only safe, slot/phone-derived actions are exposed. ask_for_service and
 * ask_for_name are always suppressed — let conversation memory handle them.
 */
function resolveVisibleNextAction(
  state: BookingProcessState,
  _priorProcessState: Partial<BookingProcessState> | null,
  bookingStateGrounded: boolean,
): BookingNextAction | undefined {
  if (!bookingStateGrounded) return undefined; // low confidence — suppress entirely

  const na = state.next_action;
  if (!na) return undefined;

  // Always suppress conversational field asks — runtime cannot extract these reliably.
  // Patient may have stated service/name in conversation text that the runtime never persisted.
  if (!SAFE_VISIBLE_NEXT_ACTIONS.has(na)) return undefined;

  return na;
}

/**
 * Builds the booking process state object that is safe to expose to the model.
 *
 * Confidence is "high" only when state is genuinely grounded:
 *   - priorProcessState is non-null and contains meaningful booking data, OR
 *   - current turn produced booking-relevant evidence (availability.check / booking.apply
 *     tool results, or selected_slot detected from offered slots).
 *
 * Non-booking tools (knowledge.search, faq, etc.) do NOT make state grounded.
 *
 * Even when grounded, ask_for_service / ask_for_name are suppressed when the field
 * is absent only because it was never persisted (the patient may have stated it in
 * conversation text that the runtime didn't extract).
 *
 * selected_slot and last_available_slots are always exposed (inherently high-confidence,
 * derived from slot-detection / tool results).
 */
// Sanitize proof before exposing it to the model.
// name_known and service_known in proof are persistence flags: true only when the runtime
// persisted the field via booking.apply. When false they do NOT mean the patient hasn't stated
// the field in conversation. Exposing false creates a conflicting authority signal.
// Safety flags (slot_known, trusted_phone_known, ready_for_booking_apply) are always included.
function sanitizeProofForModel(
  proof: BookingProcessState["proof"],
): Partial<BookingProcessState["proof"]> {
  const sanitized: Partial<BookingProcessState["proof"]> = {
    slot_known: proof.slot_known,
    trusted_phone_known: proof.trusted_phone_known,
    ready_for_booking_apply: proof.ready_for_booking_apply,
  };
  if (proof.name_known) sanitized.name_known = true;
  if (proof.service_known) sanitized.service_known = true;
  return sanitized;
}

export function buildModelVisibleBookingProcessState(opts: {
  state: BookingProcessState;
  priorProcessState: Partial<BookingProcessState> | null;
  bookingStateGrounded: boolean;
}): ModelVisibleBookingProcessState {
  const { state, priorProcessState, bookingStateGrounded } = opts;
  const confidence: BookingStateConfidence = bookingStateGrounded ? "high" : "low";

  const visibleNextAction = resolveVisibleNextAction(state, priorProcessState, bookingStateGrounded);

  if (confidence === "low") {
    // Only expose slot-related fields (inherently grounded) and sanitized proof.
    // Omit next_action so the model relies on conversation memory instead.
    return {
      last_available_slots: state.last_available_slots,
      selected_slot: state.selected_slot,
      proof: sanitizeProofForModel(state.proof),
      next_action_confidence: "low",
    };
  }

  return {
    ...state,
    proof: sanitizeProofForModel(state.proof),
    next_action: visibleNextAction,
    next_action_confidence: "high",
  };
}

// ── Slot extraction ────────────────────────────────────────────────────────────

function normalizeHHMM(raw: string): string {
  const match = raw.match(/^(\d{1,2}):(\d{2})/);
  if (!match) return raw;
  const h = match[1].padStart(2, "0");
  const m = match[2];
  return `${h}:${m}`;
}

/**
 * Extracts a time string like "17:30" from patient text.
 * Handles formats: "17:30", "17.30", "1730", preceded by whitespace/punctuation.
 */
export function extractSlotTime(text: string): string | null {
  // Standard HH:MM (e.g. "17:30", "в 17:30", "отлично 17:30")
  const colonMatch = text.match(/\b(\d{1,2}):(\d{2})\b/);
  if (colonMatch) return normalizeHHMM(`${colonMatch[1]}:${colonMatch[2]}`);

  // Dot separator (e.g. "17.30")
  const dotMatch = text.match(/\b(\d{1,2})\.(\d{2})\b/);
  if (dotMatch) return normalizeHHMM(`${dotMatch[1]}:${dotMatch[2]}`);

  // Space separator (e.g. "15 00", "на 15 00") — patient omits colon
  const spaceMatch = text.match(/\b(\d{1,2}) (\d{2})\b/);
  if (spaceMatch) return normalizeHHMM(`${spaceMatch[1]}:${spaceMatch[2]}`);

  return null;
}

/**
 * Extracts HH:MM from a starts_at ISO string (e.g. "2026-08-05T14:00:00" → "14:00").
 */
function extractSlotHHMM(startsAt: string): string | null {
  const match = startsAt.match(/T(\d{2}:\d{2})(?::\d{2})?/);
  if (match) return match[1];
  // Short form "HH:MM"
  const short = startsAt.match(/^(\d{2}:\d{2})$/);
  return short ? short[1] : null;
}

/**
 * Detects ordinal references ("первый", "второй", "последний", etc.)
 * and maps them to a 0-based index into the slots array.
 *
 * Uses Unicode-aware word boundaries ((?<!\p{L}) / (?!\p{L})) so that weekday
 * words are not confused with ordinals:
 *   "во вторник" → NOT slot[1]   (вторник ≠ второй)
 *   "в четверг"  → NOT slot[3]   (четверг ≠ четвёртый)
 *   "в пятницу"  → NOT slot[4]   (пятница ≠ пятый)
 */
function detectOrdinalIndex(text: string, slotCount: number): number | null {
  const lower = text.toLowerCase();

  /** Returns true if any of the exact word forms appears in `lower`, bounded by non-letter chars. */
  function matchAny(forms: string[]): boolean {
    const escaped = forms.map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const pattern = `(?<!\\p{L})(${escaped.join("|")})(?!\\p{L})`;
    return new RegExp(pattern, "ui").test(lower);
  }

  const ordinals: { forms: string[]; index: number }[] = [
    {
      forms: ["первый", "первого", "первому", "первым", "первом", "первое", "первая", "первых", "1-й", "first"],
      index: 0,
    },
    {
      // "второй"/"второго"/etc. — NOT "вторник" (Tuesday, different word)
      forms: ["второй", "второго", "второму", "вторым", "втором", "второе", "вторая", "вторых", "2-й", "second"],
      index: 1,
    },
    {
      forms: ["третий", "третьего", "третьему", "третьим", "третьем", "третье", "третья", "третьих", "3-й", "third"],
      index: 2,
    },
    {
      // "четвёртый"/"четвертый"/etc. — NOT "четверг" (Thursday, different word)
      forms: [
        "четвёртый", "четвертый",
        "четвёртого", "четвертого",
        "четвёртому", "четвертому",
        "четвёртым", "четвертым",
        "четвёртом", "четвертом",
        "четвёртое", "четвертое",
        "четвёртая", "четвертая",
        "четвёртых", "четвертых",
        "4-й", "fourth",
      ],
      index: 3,
    },
    {
      // "пятый"/"пятого"/etc. — NOT "пятница" (Friday, different word)
      forms: ["пятый", "пятого", "пятому", "пятым", "пятом", "пятое", "пятая", "пятых", "5-й", "fifth"],
      index: 4,
    },
  ];

  for (const { forms, index } of ordinals) {
    if (matchAny(forms) && index < slotCount) {
      return index;
    }
  }

  // "последний" / "last" → last slot
  if (matchAny(["последний", "последнего", "последнему", "последним", "последнем", "last"]) && slotCount > 0) {
    return slotCount - 1;
  }

  return null;
}

/**
 * Given patient text and a list of previously offered slots, returns the matching slot
 * or null if no match found (including ordinal references like "первый", "последний").
 */
export function detectSelectedSlot(patientText: string, availableSlots: AvailableSlot[]): AvailableSlot | null {
  if (!availableSlots.length) return null;

  // Try ordinal reference first
  const ordinalIndex = detectOrdinalIndex(patientText, availableSlots.length);
  if (ordinalIndex !== null) {
    return availableSlots[ordinalIndex] ?? null;
  }

  // Try exact time match
  const extracted = extractSlotTime(patientText);
  if (!extracted) return null;

  const match = availableSlots.find((slot) => {
    const slotHHMM = extractSlotHHMM(slot.starts_at);
    return slotHHMM === extracted;
  });

  return match ?? null;
}

// ── Slot extraction from tool results ─────────────────────────────────────────

export function extractSlotsFromToolResults(toolResults: RuntimeAgentToolResult[]): AvailableSlot[] {
  const slots: AvailableSlot[] = [];
  for (const r of toolResults) {
    if (r.tool !== "availability.check" || r.status !== "success") continue;
    const data = r.data as { slots?: unknown[] } | null | undefined;
    if (!Array.isArray(data?.slots)) continue;
    for (const s of data.slots) {
      if (s && typeof s === "object") {
        const raw = s as { starts_at?: unknown; ends_at?: unknown; slot_id?: unknown };
        if (typeof raw.starts_at === "string") {
          slots.push({
            starts_at: raw.starts_at,
            ends_at: typeof raw.ends_at === "string" ? raw.ends_at : undefined,
            slot_id: typeof raw.slot_id === "string" ? raw.slot_id : undefined,
          });
        }
      }
    }
  }
  return slots;
}

// ── State computation ──────────────────────────────────────────────────────────

export interface ComputeBookingProcessStateInput {
  /** Previously persisted state (may be partial / from last turn). */
  prior?: Partial<BookingProcessState> | null;
  /** Tool results from the current turn. */
  toolResults?: RuntimeAgentToolResult[];
  /** Raw patient message for selected_slot detection. */
  patientMessage?: string;
  /** Channel contact for trusted phone resolution. */
  channelContact?: ChannelContact;
  /** Override selected_slot from explicit booking.apply args (round 2). */
  bookingApplySlot?: { date: string; time: string } | null;
  /** Override service from explicit booking.apply args. */
  bookingApplyService?: string | null;
  /** Override name from explicit booking.apply args. */
  bookingApplyFirstName?: string | null;
  bookingApplyLastName?: string | null;
}

export function computeBookingProcessState(input: ComputeBookingProcessStateInput): BookingProcessState {
  const p = input.prior ?? {};

  // ── Resolve available slots from tool results ──
  // Any availability.check attempt (regardless of result status) supersedes prior evidence.
  // Only the LAST availability.check result (by position) is authoritative — earlier results
  // in the same round are superseded. Success installs fresh slots; failure/denied/past_date
  // installs []. toolResults are pushed in request order by the loop.
  let lastAvailResult: RuntimeAgentToolResult | undefined;
  if (input.toolResults) {
    for (const r of input.toolResults) {
      if (r.tool === "availability.check") lastAvailResult = r;
    }
  }
  const availabilityAttemptPresent = lastAvailResult !== undefined;
  const availabilitySuccessPresent = lastAvailResult?.status === "success";
  const newSlots = availabilitySuccessPresent && lastAvailResult
    ? extractSlotsFromToolResults([lastAvailResult])
    : [];
  const lastAvailableSlots: AvailableSlot[] = availabilityAttemptPresent
    ? newSlots
    : (p.last_available_slots ?? []);

  // ── Resolve service_reason ──
  const serviceReason =
    input.bookingApplyService?.trim() ||
    p.service_reason ||
    undefined;

  // ── Resolve name fields ──
  const firstName = input.bookingApplyFirstName?.trim() || p.first_name || undefined;
  const lastName = input.bookingApplyLastName?.trim() || p.last_name || undefined;

  // ── Resolve trusted phone ──
  const phoneTrusted = hasTrustedPhone(input.channelContact);
  const phoneSource = input.channelContact?.phone_source;

  // ── Detect selected_slot from patient message ──
  // Any availability.check attempt clears the prior selected_slot — stale selection
  // from an earlier date is no longer valid. Re-detection below uses only fresh slots.
  let selectedSlot: AvailableSlot | null = availabilityAttemptPresent
    ? null
    : (p.selected_slot ?? null);

  if (
    input.patientMessage &&
    lastAvailableSlots.length > 0 &&
    !selectedSlot
  ) {
    const detected = detectSelectedSlot(input.patientMessage, lastAvailableSlots);
    if (detected !== null) {
      selectedSlot = detected;
    }
  }

  // Explicit slot from booking.apply args wins over detected slot
  if (input.bookingApplySlot) {
    const matched = lastAvailableSlots.find((s) => {
      const hhmm = extractSlotHHMM(s.starts_at);
      return hhmm === input.bookingApplySlot!.time;
    });
    if (matched) selectedSlot = matched;
  }

  // ── Compute proof ──
  const serviceKnown = !!serviceReason;
  const nameKnown = !!(firstName && lastName);
  const slotKnown = !!selectedSlot;
  const trustedPhoneKnown = phoneTrusted;
  const readyForBookingApply = serviceKnown && nameKnown && slotKnown && trustedPhoneKnown;

  // ── Compute next_action ──
  let nextAction: BookingNextAction;
  if (!serviceKnown) {
    nextAction = "ask_for_service";
  } else if (!nameKnown) {
    nextAction = "ask_for_name";
  } else if (!slotKnown && !p.preferred_time_text) {
    nextAction = "ask_for_slot";
  } else if (slotKnown && !trustedPhoneKnown) {
    nextAction = "ask_for_phone";
  } else if (readyForBookingApply) {
    nextAction = "ready_for_booking_apply";
  } else {
    // Has preferred_time_text but no confirmed slot yet
    nextAction = "ask_for_slot";
  }

  // If patient gave a time that doesn't match any slot, override
  if (
    input.patientMessage &&
    lastAvailableSlots.length > 0 &&
    !selectedSlot &&
    extractSlotTime(input.patientMessage) !== null
  ) {
    nextAction = "choose_from_available_slots";
  }

  return {
    service_reason: serviceReason,
    first_name: firstName,
    last_name: lastName,
    preferred_time_text: p.preferred_time_text,
    // Any availability attempt explicitly stores its outcome ([] for failure, fresh slots for success).
    // When no attempt was made this turn, preserve prior state.
    last_available_slots: availabilityAttemptPresent
      ? lastAvailableSlots
      : p.last_available_slots,
    selected_slot: selectedSlot,
    phone_trusted: phoneTrusted,
    phone_source: phoneSource,
    next_action: nextAction,
    proof: {
      service_known: serviceKnown,
      name_known: nameKnown,
      slot_known: slotKnown,
      trusted_phone_known: trustedPhoneKnown,
      ready_for_booking_apply: readyForBookingApply,
    },
  };
}

// ── In-memory repository (for tests and future production use) ─────────────────

export function createInMemoryBookingProcessStateRepository(): BookingProcessStateRepository {
  const store = new Map<string, BookingProcessState>();

  function makeKey(key: { clinic_id: string; contact_id?: string | null; case_id?: string | null }): string {
    return `${key.clinic_id}:${key.contact_id ?? ""}:${key.case_id ?? ""}`;
  }

  return {
    async loadState(key, onDebug) {
      const result = store.get(makeKey(key)) ?? null;
      onDebug?.({ loaded: result !== null, reason: result === null ? "null_or_missing" : undefined });
      return result;
    },
    async saveState(key, state, onDebug) {
      store.set(makeKey(key), state);
      onDebug?.({ saved: true });
    },
  };
}
