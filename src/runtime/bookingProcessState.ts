import type { RuntimeAgentToolResult, ChannelContact } from "./openaiRuntimeAgent.ts";
import { hasTrustedPhone } from "./bookingContactGuard.ts";
import type { AuthoritativeAvailabilityAttempt } from "./availabilityActionTruth.ts";
import type { AvailabilityEvidence, SelectedSlotProof } from "./slotEvidence.ts";
import { slotToKey, normalizeSlotKey, buildAllowedSlotKeysFromResult } from "./slotEvidence.ts";
import type { BookingSelectSlotSuccessData } from "./bookingSelectSlot.ts";
import { parseStrictSubjectId } from "./bookingSubjectsState.ts";

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
  /** Authoritative evidence from the last successful availability.check, keyed by full datetime. */
  active_availability_evidence?: AvailabilityEvidence | null;
  /** Proof linking selected_slot to active_availability_evidence. Required for slot_known=true. */
  selected_slot_proof?: SelectedSlotProof | null;
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

export type SlotEvidenceStatus = "verified" | "missing" | "stale";

export type BookingStateConfidence = "high" | "low";

export interface ModelVisibleBookingProcessState extends Partial<BookingProcessState> {
  next_action_confidence: BookingStateConfidence;
  slot_evidence_status?: SlotEvidenceStatus;
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

export const AVAILABILITY_MODEL_VISIBILITY_TTL_MS = 15 * 60 * 1000;

/** Fails closed: evidence without checked_at is treated as stale. */
export function isAvailabilityEvidenceFresh(
  evidence: AvailabilityEvidence | null | undefined,
  now: Date,
): boolean {
  if (!evidence?.checked_at) return false;
  const age = now.getTime() - new Date(evidence.checked_at).getTime();
  return age >= 0 && age <= AVAILABILITY_MODEL_VISIBILITY_TTL_MS;
}

function filterFutureSlots(slots: AvailableSlot[], now: Date, timezone: string): AvailableSlot[] {
  const fmt = new Intl.DateTimeFormat("sv-SE", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const minKey = fmt.format(now).replace(" ", "T").substring(0, 16);
  return slots.filter((s) => {
    const key = slotToKey(s);
    return key !== null && key > minKey; // slot at exactly current minute = expired
  });
}

/**
 * Returns true when selected_slot is still usable: strictly in the future and bound
 * to the active evidence allowed_slot_keys. Slot at exactly the current clinic-local
 * minute is considered expired (consistent with filterFutureSlots semantics).
 */
function isSelectedSlotUsable(
  selectedSlot: AvailableSlot | null | undefined,
  evidence: AvailabilityEvidence | null | undefined,
  now: Date,
  timezone: string,
): boolean {
  if (!selectedSlot) return false;
  const key = slotToKey(selectedSlot);
  if (key === null) return false;

  const fmt = new Intl.DateTimeFormat("sv-SE", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const minKey = fmt.format(now).replace(" ", "T").substring(0, 16);
  if (key <= minKey) return false; // expired

  if (evidence && !evidence.allowed_slot_keys.includes(key)) return false; // unbound

  return true;
}

function filterAllowedSlots(slots: AvailableSlot[], allowedKeys: string[]): AvailableSlot[] {
  const allowed = new Set(allowedKeys);
  return slots.filter((s) => {
    const key = slotToKey(s);
    return key !== null && allowed.has(key);
  });
}

function filterVisibleSlots(state: BookingProcessState, now: Date, timezone: string): AvailableSlot[] {
  const slots = state.last_available_slots ?? [];
  if (slots.length === 0) return [];
  const evidence = state.active_availability_evidence;
  const future = filterFutureSlots(slots, now, timezone);
  return evidence ? filterAllowedSlots(future, evidence.allowed_slot_keys) : future;
}

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

function resolveSlotEvidenceStatus(state: BookingProcessState): SlotEvidenceStatus {
  if (!state.selected_slot) return "missing";
  if (state.proof.slot_known) return "verified";
  return "stale";
}

export function buildModelVisibleBookingProcessState(opts: {
  state: BookingProcessState;
  priorProcessState: Partial<BookingProcessState> | null;
  bookingStateGrounded: boolean;
  /**
   * Wall-clock time for this turn. When provided, enables stale-evidence sanitization
   * and future-slot filtering. Omit only in legacy test callers that don't inject time.
   * Production (runtimeAgentLoop) always provides this via turnNow.
   */
  now?: Date;
  /** Clinic timezone for future-slot filtering. Defaults to "Europe/Prague" when now is provided. */
  timezone?: string;
}): ModelVisibleBookingProcessState {
  const { state, priorProcessState, bookingStateGrounded, now, timezone } = opts;
  const confidence: BookingStateConfidence = bookingStateGrounded ? "high" : "low";

  const visibleNextAction = resolveVisibleNextAction(state, priorProcessState, bookingStateGrounded);

  // Stale-evidence sanitization and future-slot filtering only when now is provided.
  // Legacy test callers that omit now retain the original pass-through behavior.
  if (now !== undefined) {
    const tz = timezone ?? "Europe/Prague";
    const evidenceFresh = isAvailabilityEvidenceFresh(state.active_availability_evidence, now);
    const hasSlotData = (state.last_available_slots?.length ?? 0) > 0 || state.selected_slot != null;

    if (!evidenceFresh && hasSlotData) {
      // Stale: sanitize model-visible copy — never mutate persisted state.
      const staleSanitizedProof = sanitizeProofForModel({
        ...state.proof,
        slot_known: false,
        ready_for_booking_apply: false,
      });
      const staleNextAction: BookingNextAction | undefined =
        visibleNextAction === "choose_from_available_slots" ||
        visibleNextAction === "ready_for_booking_apply" ||
        visibleNextAction === "ask_for_phone"
          ? undefined
          : visibleNextAction;

      if (confidence === "low") {
        return {
          last_available_slots: [],
          selected_slot: undefined,
          slot_evidence_status: "stale",
          proof: staleSanitizedProof,
          next_action_confidence: "low",
        };
      }

      return {
        ...state,
        active_availability_evidence: undefined,
        selected_slot_proof: undefined,
        last_available_slots: [],
        selected_slot: undefined,
        slot_evidence_status: "stale",
        proof: staleSanitizedProof,
        next_action: staleNextAction,
        next_action_confidence: "high",
      };
    }

    // Evidence is fresh (or no slot data) — filter to future slots present in allowed_slot_keys.
    const visibleSlots = filterVisibleSlots(state, now, tz);

    // Even within TTL, independently verify that selected_slot hasn't passed and is
    // bound to the evidence allowed_slot_keys. A slot selected 5 min ago may already
    // be in the past if the patient spent time in the conversation.
    const slotExpiredOrUnbound =
      state.selected_slot != null &&
      !isSelectedSlotUsable(state.selected_slot, state.active_availability_evidence, now, tz);

    const slotEvidenceStatus = slotExpiredOrUnbound ? "stale" : resolveSlotEvidenceStatus(state);
    const freshProof = slotExpiredOrUnbound
      ? sanitizeProofForModel({ ...state.proof, slot_known: false, ready_for_booking_apply: false })
      : sanitizeProofForModel(state.proof);

    if (confidence === "low") {
      return {
        last_available_slots: visibleSlots,
        selected_slot: slotExpiredOrUnbound ? undefined : state.selected_slot,
        slot_evidence_status: slotEvidenceStatus,
        proof: freshProof,
        next_action_confidence: "low",
      };
    }

    // Suppress slot-dependent next_actions when selected_slot is no longer usable.
    // Also suppress choose_from_available_slots when all visible slots have been filtered out.
    const freshNextAction =
      (slotExpiredOrUnbound &&
        (visibleNextAction === "ready_for_booking_apply" || visibleNextAction === "ask_for_phone")) ||
      (visibleSlots.length === 0 && visibleNextAction === "choose_from_available_slots")
        ? undefined
        : visibleNextAction;

    return {
      ...state,
      // Strip internal evidence fields — model sees slot_evidence_status instead.
      active_availability_evidence: undefined,
      selected_slot_proof: undefined,
      last_available_slots: visibleSlots,
      selected_slot: slotExpiredOrUnbound ? undefined : state.selected_slot,
      slot_evidence_status: slotEvidenceStatus,
      proof: freshProof,
      next_action: freshNextAction,
      next_action_confidence: "high",
    };
  }

  // Legacy path: no now provided — original pass-through behavior.
  const slotEvidenceStatus = resolveSlotEvidenceStatus(state);

  if (confidence === "low") {
    return {
      last_available_slots: state.last_available_slots,
      selected_slot: state.selected_slot,
      slot_evidence_status: slotEvidenceStatus,
      proof: sanitizeProofForModel(state.proof),
      next_action_confidence: "low",
    };
  }

  return {
    ...state,
    // Strip internal evidence fields — model sees slot_evidence_status instead.
    active_availability_evidence: undefined,
    selected_slot_proof: undefined,
    slot_evidence_status: slotEvidenceStatus,
    proof: sanitizeProofForModel(state.proof),
    next_action: visibleNextAction,
    next_action_confidence: "high",
  };
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
  /**
   * Pre-resolved authoritative availability attempt from the runtime loop.
   * When present, takes priority over toolResults for availability slot resolution.
   * Ensures booking state uses the same authoritative pair as the truth objects.
   */
  authoritativeAvailabilityAttempt?: AuthoritativeAvailabilityAttempt;
  /**
   * Tool results from the current turn.
   * Used for backwards compat when authoritativeAvailabilityAttempt is absent (e.g. direct tests).
   * Production always passes authoritativeAvailabilityAttempt from the loop.
   */
  toolResults?: RuntimeAgentToolResult[];
  /** Channel contact for trusted phone resolution. */
  channelContact?: ChannelContact;
  /**
   * Successful booking.select_slot result from this turn.
   * When present, creates selected_slot and selected_slot_proof from the validated key.
   * Ignored when a new availability.check was performed this turn (evidence was refreshed).
   */
  selectSlotData?: BookingSelectSlotSuccessData | null;
  /**
   * True when the current turn contained at least one booking.select_slot request,
   * regardless of whether it succeeded. A selection attempt revokes the prior proof
   * before any new proof is installed — a failed attempt must never restore the old proof.
   */
  selectSlotAttemptedThisTurn?: boolean;
  /** Override service from explicit booking.apply args. */
  bookingApplyService?: string | null;
  /** Override name from explicit booking.apply args. */
  bookingApplyFirstName?: string | null;
  bookingApplyLastName?: string | null;
  /** Wall-clock time for this turn. Used to stamp checked_at on new availability evidence. Defaults to new Date(). */
  now?: Date;
}

export function computeBookingProcessState(input: ComputeBookingProcessStateInput): BookingProcessState {
  const p = input.prior ?? {};

  // ── Resolve available slots and build availability evidence ──
  let availabilityAttemptPresent: boolean;
  let availabilitySuccessPresent: boolean;
  let newSlots: AvailableSlot[];
  let activeAvailabilityEvidence: AvailabilityEvidence | null | undefined;

  if (input.authoritativeAvailabilityAttempt !== undefined) {
    const { attempted, pair } = input.authoritativeAvailabilityAttempt;
    availabilityAttemptPresent = attempted;
    availabilitySuccessPresent = attempted && pair !== null && pair.result.status === "success";
    newSlots = availabilitySuccessPresent && pair !== null
      ? extractSlotsFromToolResults([pair.result])
      : [];

    if (!attempted) {
      // No availability.check this turn — preserve prior evidence.
      activeAvailabilityEvidence = p.active_availability_evidence;
    } else if (pair === null || pair.result.status !== "success") {
      // Attempt failed or result unmatched — clear evidence (new attempt supersedes old).
      activeAvailabilityEvidence = null;
    } else {
      // Successful authoritative pair — build fresh evidence.
      activeAvailabilityEvidence = {
        availability_call_id: pair.request.call_id!,
        requested_date:
          typeof pair.request.arguments.requested_date === "string"
            ? pair.request.arguments.requested_date
            : "",
        requested_time:
          typeof pair.request.arguments.requested_time === "string"
            ? pair.request.arguments.requested_time
            : null,
        allowed_slot_keys: buildAllowedSlotKeysFromResult(pair.result),
        checked_at: (input.now ?? new Date()).toISOString(),
      };
    }
  } else {
    // Backwards-compat: positional last-result scan (test callers that omit authoritativeAvailabilityAttempt).
    let lastAvailResult: RuntimeAgentToolResult | undefined;
    if (input.toolResults) {
      for (const r of input.toolResults) {
        if (r.tool === "availability.check") lastAvailResult = r;
      }
    }
    availabilityAttemptPresent = lastAvailResult !== undefined;
    availabilitySuccessPresent = lastAvailResult?.status === "success" ?? false;
    newSlots = availabilitySuccessPresent && lastAvailResult
      ? extractSlotsFromToolResults([lastAvailResult])
      : [];
    // Preserve prior evidence when no authoritativeAvailabilityAttempt was supplied.
    activeAvailabilityEvidence = p.active_availability_evidence;
  }

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

  // ── Resolve selected_slot and proof ──
  // Both availability.check and a selection attempt revoke the prior slot and proof.
  // A failed booking.select_slot must never restore the old proof — revoke first, install only on success.
  const clearPriorSelection = availabilityAttemptPresent || !!(input.selectSlotAttemptedThisTurn);
  let selectedSlot: AvailableSlot | null = clearPriorSelection
    ? null
    : (p.selected_slot ?? null);
  let selectedSlotProof: SelectedSlotProof | null | undefined = clearPriorSelection
    ? null
    : (p.selected_slot_proof ?? null);

  let selectionEstablishedThisTurn = false;

  // booking.select_slot result: creates slot + proof from the validated key.
  // Only applied when no new availability.check was performed (which would stale the evidence).
  // subject_id must pass strict validation; missing or out-of-range values are fail-closed.
  if (!availabilityAttemptPresent && input.selectSlotData && activeAvailabilityEvidence) {
    const key = input.selectSlotData.selected_slot_key;
    const proofSubjectId = parseStrictSubjectId(input.selectSlotData.subject_id);
    if (
      proofSubjectId !== null &&
      key !== null &&
      activeAvailabilityEvidence.allowed_slot_keys.includes(key)
    ) {
      const matchedSlot = lastAvailableSlots.find((s) => slotToKey(s) === key)
        ?? { starts_at: `${key}:00` };
      selectedSlot = matchedSlot;
      selectedSlotProof = {
        subject_id: proofSubjectId,
        availability_call_id: activeAvailabilityEvidence.availability_call_id,
        slot_key: key,
      };
      selectionEstablishedThisTurn = true;
    }
    // When subject_id is absent or invalid: no proof, no slot, selectionEstablishedThisTurn stays false.
  }

  // ── Validate persisted proof ──
  // Proof is created only via booking.select_slot. Persisted proof is validated (not reconstructed).
  if (!selectionEstablishedThisTurn && selectedSlotProof && selectedSlot && activeAvailabilityEvidence) {
    // Validate persisted proof — clear it if the chain is broken, keep it if intact.
    // subject_id must pass the same strict check as new proofs (subject_1..subject_4 only).
    const proofSubjectId = parseStrictSubjectId(selectedSlotProof.subject_id);
    const key = slotToKey(selectedSlot);
    const proofValid =
      proofSubjectId !== null &&
      key !== null &&
      selectedSlotProof.slot_key === key &&
      selectedSlotProof.availability_call_id === activeAvailabilityEvidence.availability_call_id &&
      activeAvailabilityEvidence.allowed_slot_keys.includes(selectedSlotProof.slot_key);
    if (!proofValid) {
      selectedSlotProof = null;
    }
  }
  // If selectedSlotProof is null and selectionEstablishedThisTurn is false, proof stays null.

  // ── Compute proof ──
  const serviceKnown = !!serviceReason;
  const nameKnown = !!(firstName && lastName);

  // slot_known requires full provenance chain:
  //   selected_slot exists
  //   + selected_slot_proof exists with valid subject_id (defense in depth — proof paths above also check)
  //   + active_availability_evidence exists
  //   + call IDs agree
  //   + slot key exists in allowed keys
  const slotKey = selectedSlot ? slotToKey(selectedSlot) : null;
  const slotKnown = !!(
    selectedSlot &&
    selectedSlotProof &&
    parseStrictSubjectId(selectedSlotProof.subject_id) !== null &&
    activeAvailabilityEvidence &&
    selectedSlotProof.availability_call_id === activeAvailabilityEvidence.availability_call_id &&
    slotKey !== null &&
    slotKey === selectedSlotProof.slot_key &&
    activeAvailabilityEvidence.allowed_slot_keys.includes(selectedSlotProof.slot_key)
  );

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
    nextAction = "ask_for_slot";
  }

  return {
    service_reason: serviceReason,
    first_name: firstName,
    last_name: lastName,
    preferred_time_text: p.preferred_time_text,
    last_available_slots: availabilityAttemptPresent
      ? lastAvailableSlots
      : p.last_available_slots,
    selected_slot: selectedSlot,
    active_availability_evidence: activeAvailabilityEvidence,
    selected_slot_proof: selectedSlotProof,
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
