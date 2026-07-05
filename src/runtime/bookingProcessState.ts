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

export interface BookingProcessStateRepository {
  loadState(key: { clinic_id: string; contact_id?: string | null; case_id?: string | null }): Promise<Partial<BookingProcessState> | null>;
  saveState(key: { clinic_id: string; contact_id?: string | null; case_id?: string | null }, state: BookingProcessState): Promise<void>;
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
 * Detects ordinal references ("первый", "первое", "second", "последний", etc.)
 * and maps them to a 0-based index into the slots array.
 */
function detectOrdinalIndex(text: string, slotCount: number): number | null {
  const lower = text.toLowerCase();

  const ordinals: { patterns: string[]; index: number }[] = [
    { patterns: ["перв", "first", "1-й", "1-е", "один", "1ый"], index: 0 },
    { patterns: ["втор", "second", "2-й", "два", "2ой"], index: 1 },
    { patterns: ["трет", "third", "3-й", "три", "3ий"], index: 2 },
    { patterns: ["четвер", "fourth", "4-й", "четыре"], index: 3 },
    { patterns: ["пят", "fifth", "5-й", "пять"], index: 4 },
  ];

  for (const { patterns, index } of ordinals) {
    if (patterns.some((p) => lower.includes(p)) && index < slotCount) {
      return index;
    }
  }

  // "последний" / "last" → last slot
  if ((lower.includes("последн") || lower.includes("last")) && slotCount > 0) {
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
  const newSlots = input.toolResults ? extractSlotsFromToolResults(input.toolResults) : [];
  const lastAvailableSlots = newSlots.length > 0 ? newSlots : (p.last_available_slots ?? []);

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

  // ── Detect selected_slot from patient message (only if we have slots to match against) ──
  let selectedSlot = p.selected_slot ?? null;
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
    last_available_slots: lastAvailableSlots.length > 0 ? lastAvailableSlots : undefined,
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
    async loadState(key) {
      return store.get(makeKey(key)) ?? null;
    },
    async saveState(key, state) {
      store.set(makeKey(key), state);
    },
  };
}
