import type { ChannelContact } from "./openaiRuntimeAgent.ts";
import { hasTrustedPhone } from "./bookingContactGuard.ts";

// ── Types ──────────────────────────────────────────────────────────────────

export type ClinicalSignalLevel = "none" | "tooth_pain" | "red_flag";
export type ClinicalSignalType =
  | "none"
  | "tooth_pain"
  | "bleeding"
  | "swelling"
  | "fever"
  | "trauma"
  | "severe_pain"
  | "unknown";
export type ActiveIntent = "booking" | "faq" | "urgent_clinical" | "unknown";
export type WaitingFor =
  | "none"
  | "trusted_phone"
  | "patient_name"
  | "preferred_time"
  | "slot_selection"
  | "availability_check"
  | "admin_handoff";
export type PreferredTimeMode = "asap" | "exact" | "datepart" | "unknown";

export interface ClinicalSignal {
  level: ClinicalSignalLevel;
  type: ClinicalSignalType;
  safety_guidance_first: boolean;
  must_contact_clinic_immediately: boolean;
  emergency_if_severe_or_worsening: boolean;
}

export interface CaseLiteBooking {
  service_reason: string | null;
  first_name: string | null;
  last_name: string | null;
  preferred_time_text: string | null;
  preferred_time_mode: PreferredTimeMode | null;
  phone_number: string | null;
  phone_source: string | null;
  phone_trusted: boolean;
  last_available_slots?: Array<{ date: string; time_start: string; time_end?: string }>;
}

export interface CaseLiteBookingStatus {
  created_visit: boolean;
  cliniccard_visit_id: string | null;
  may_claim_booked: boolean;
}

export interface CaseLitePolicy {
  must_not_make_intake_main_response: boolean;
  must_not_claim_booking_created: boolean;
  may_offer_booking_after_guidance: boolean;
}

export interface RuntimeCaseLite {
  case_id: string;
  clinic_id: string;
  channel: string;
  external_user_id: string;
  locale: string | null;
  active_intent: ActiveIntent;
  clinical_signal: ClinicalSignal;
  booking: CaseLiteBooking;
  booking_status: CaseLiteBookingStatus;
  waiting_for: WaitingFor;
  policy: CaseLitePolicy;
  updated_at: string;
  expires_at: string | null;
}

export interface RuntimeCaseLiteUpdate {
  active_intent?: ActiveIntent;
  clinical_signal?: Partial<ClinicalSignal>;
  booking?: Partial<Omit<CaseLiteBooking, "last_available_slots">>;
  waiting_for?: WaitingFor;
}

// ── Defaults ───────────────────────────────────────────────────────────────

export function buildDefaultClinicalSignal(): ClinicalSignal {
  return {
    level: "none",
    type: "none",
    safety_guidance_first: false,
    must_contact_clinic_immediately: false,
    emergency_if_severe_or_worsening: false,
  };
}

export function buildDefaultRuntimeCaseLite(opts: {
  clinic_id: string;
  channel: string;
  external_user_id: string;
  locale?: string | null;
}): RuntimeCaseLite {
  const now = new Date().toISOString();
  return {
    case_id: `case_lite_${opts.clinic_id}_${opts.channel}_${opts.external_user_id}`,
    clinic_id: opts.clinic_id,
    channel: opts.channel,
    external_user_id: opts.external_user_id,
    locale: opts.locale ?? null,
    active_intent: "unknown",
    clinical_signal: buildDefaultClinicalSignal(),
    booking: {
      service_reason: null,
      first_name: null,
      last_name: null,
      preferred_time_text: null,
      preferred_time_mode: null,
      phone_number: null,
      phone_source: null,
      phone_trusted: false,
    },
    booking_status: {
      created_visit: false,
      cliniccard_visit_id: null,
      may_claim_booked: false,
    },
    waiting_for: "none",
    policy: {
      must_not_make_intake_main_response: false,
      must_not_claim_booking_created: true,
      may_offer_booking_after_guidance: false,
    },
    updated_at: now,
    expires_at: null,
  };
}

// ── Merge ──────────────────────────────────────────────────────────────────

// Merge an extracted update into existing case context.
// Rule: non-null values in `update` override existing; null means "no change".
// Phone trust is always derived from channel_contact (authoritative source).
export function mergeRuntimeCaseLite(
  existing: RuntimeCaseLite,
  update: RuntimeCaseLiteUpdate,
  channelContact: ChannelContact | undefined | null,
): RuntimeCaseLite {
  const now = new Date().toISOString();

  const newIntent = update.active_intent ?? existing.active_intent;

  const newClinicalSignal: ClinicalSignal = update.clinical_signal
    ? {
        level: update.clinical_signal.level ?? existing.clinical_signal.level,
        type: update.clinical_signal.type ?? existing.clinical_signal.type,
        safety_guidance_first:
          update.clinical_signal.safety_guidance_first ?? existing.clinical_signal.safety_guidance_first,
        must_contact_clinic_immediately:
          update.clinical_signal.must_contact_clinic_immediately ??
          existing.clinical_signal.must_contact_clinic_immediately,
        emergency_if_severe_or_worsening:
          update.clinical_signal.emergency_if_severe_or_worsening ??
          existing.clinical_signal.emergency_if_severe_or_worsening,
      }
    : existing.clinical_signal;

  // Phone trust is authoritative from channel_contact — never rely on model extraction.
  const trusted = hasTrustedPhone(channelContact ?? undefined);
  const newBooking: CaseLiteBooking = {
    service_reason: update.booking?.service_reason ?? existing.booking.service_reason,
    first_name: update.booking?.first_name ?? existing.booking.first_name,
    last_name: update.booking?.last_name ?? existing.booking.last_name,
    preferred_time_text: update.booking?.preferred_time_text ?? existing.booking.preferred_time_text,
    preferred_time_mode: update.booking?.preferred_time_mode ?? existing.booking.preferred_time_mode,
    phone_number: trusted ? (channelContact!.phone_number) : (update.booking?.phone_number ?? existing.booking.phone_number),
    phone_source: trusted ? (channelContact!.phone_source) : (update.booking?.phone_source ?? existing.booking.phone_source),
    phone_trusted: trusted,
    last_available_slots: existing.booking.last_available_slots,
  };

  const isRedFlag = newClinicalSignal.level === "red_flag";
  const newPolicy: CaseLitePolicy = {
    must_not_make_intake_main_response: isRedFlag,
    must_not_claim_booking_created: !existing.booking_status.may_claim_booked,
    may_offer_booking_after_guidance: isRedFlag,
  };

  const newWaitingFor: WaitingFor = deriveWaitingFor(newIntent, newBooking, update.waiting_for);

  return {
    ...existing,
    active_intent: newIntent,
    clinical_signal: newClinicalSignal,
    booking: newBooking,
    policy: newPolicy,
    waiting_for: newWaitingFor,
    updated_at: now,
  };
}

// Derive what the booking flow is waiting for next based on known state.
export function deriveWaitingFor(
  intent: ActiveIntent,
  booking: CaseLiteBooking,
  explicitOverride?: WaitingFor,
): WaitingFor {
  if (explicitOverride && explicitOverride !== "none") return explicitOverride;
  if (intent !== "booking" && intent !== "urgent_clinical") return "none";
  if (!booking.phone_trusted) return "trusted_phone";
  if (!booking.first_name || !booking.last_name) return "patient_name";
  if (!booking.preferred_time_mode) return "preferred_time";
  return "none";
}

// Update booking_status after tool results are available.
export function applyBookingStatusToCase(
  existing: RuntimeCaseLite,
  toolResults: ReadonlyArray<{ tool: string; status: string; data?: unknown }>,
): RuntimeCaseLite {
  const bookingResult = toolResults.find(
    (r) => r.tool === "booking.apply" && r.status === "success",
  );
  if (!bookingResult) return existing;

  const data = bookingResult.data as Record<string, unknown> | undefined;
  const visitId =
    typeof data?.cliniccard_visit_id === "string" ? data.cliniccard_visit_id :
    typeof data?.visit_id === "string" ? data.visit_id : null;

  return {
    ...existing,
    booking_status: {
      created_visit: true,
      cliniccard_visit_id: visitId,
      may_claim_booked: true,
    },
    policy: {
      ...existing.policy,
      must_not_claim_booking_created: false,
    },
    updated_at: new Date().toISOString(),
  };
}

// Safely parse a raw JSON value into RuntimeCaseLite.
export function parseRuntimeCaseLite(raw: unknown): RuntimeCaseLite | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.clinic_id !== "string" || typeof obj.channel !== "string") return null;
  return obj as unknown as RuntimeCaseLite;
}
