import type { RuntimeCaseLite, WaitingFor } from "./runtimeCaseLite.ts";

export interface CasePolicyTruth {
  active_intent: string;
  clinical_signal_level: string;
  safety_guidance_first: boolean;
  known_booking_fields: {
    first_name: string | null;
    last_name: string | null;
    service_reason: string | null;
    preferred_time_text: string | null;
    preferred_time_mode: string | null;
    phone_trusted: boolean;
  };
  missing_fields: string[];
  must_not_make_intake_main_response: boolean;
  must_not_claim_booking_created: boolean;
  may_offer_booking_after_guidance: boolean;
  next_safe_step: string;
  booking_created: boolean;
}

export function buildCasePolicyTruth(caseLite: RuntimeCaseLite): CasePolicyTruth {
  const missing = deriveMissingFields(caseLite);
  return {
    active_intent: caseLite.active_intent,
    clinical_signal_level: caseLite.clinical_signal.level,
    safety_guidance_first: caseLite.clinical_signal.safety_guidance_first,
    known_booking_fields: {
      first_name: caseLite.booking.first_name,
      last_name: caseLite.booking.last_name,
      service_reason: caseLite.booking.service_reason,
      preferred_time_text: caseLite.booking.preferred_time_text,
      preferred_time_mode: caseLite.booking.preferred_time_mode,
      phone_trusted: caseLite.booking.phone_trusted,
    },
    missing_fields: missing,
    must_not_make_intake_main_response: caseLite.policy.must_not_make_intake_main_response,
    must_not_claim_booking_created: caseLite.policy.must_not_claim_booking_created,
    may_offer_booking_after_guidance: caseLite.policy.may_offer_booking_after_guidance,
    next_safe_step: describeNextStep(caseLite.waiting_for),
    booking_created: caseLite.booking_status.created_visit,
  };
}

function deriveMissingFields(caseLite: RuntimeCaseLite): string[] {
  if (caseLite.active_intent !== "booking" && caseLite.active_intent !== "urgent_clinical") return [];
  const missing: string[] = [];
  if (!caseLite.booking.phone_trusted) missing.push("trusted_phone");
  if (!caseLite.booking.first_name) missing.push("first_name");
  if (!caseLite.booking.last_name) missing.push("last_name");
  if (!caseLite.booking.preferred_time_mode) missing.push("preferred_time");
  return missing;
}

function describeNextStep(waitingFor: WaitingFor): string {
  switch (waitingFor) {
    case "trusted_phone": return "request trusted phone via channel contact button";
    case "patient_name": return "ask for patient first and last name";
    case "preferred_time": return "ask for preferred appointment time or day";
    case "slot_selection": return "present available slots for patient to choose";
    case "availability_check": return "call availability.check for requested date/time";
    case "admin_handoff": return "explain online booking unavailable, ask patient to contact clinic";
    case "none": return "all required fields collected — proceed with booking";
    default: return "continue intake";
  }
}
