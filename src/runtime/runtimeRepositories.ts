import type { PatientSubject } from "./caseContext.ts";

/**
 * RuntimeResult is the typed boundary contract returned by repository methods.
 *
 * Repositories form an anti-corruption layer between Runtime V2 and the
 * existing Supabase/Core RPC layer. Runtime code must consume these normalized
 * contracts instead of depending on raw table rows.
 */
export type RuntimeResult<TData, TCode extends string = string> =
  | {
    ok: true;
    data: TData;
  }
  | {
    ok: false;
    error: {
      code: TCode;
      message: string;
      retryable: boolean;
      details?: Record<string, unknown>;
    };
  };

export interface RpcContactRecord {
  contact_id: string;
  external_ref?: string | null;
  phone_e164?: string | null;
  full_name?: string | null;
  preferred_locale?: string | null;
  timezone?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface RpcCaseRecord {
  case_id: string;
  contact_id: string;
  status: "open" | "closed" | "unknown";
  case_type?: "faq" | "booking" | "reschedule" | "cancel" | "document" | "post_booking" | "unknown";
  service_interest?: string | null;
  patient_subject?: PatientSubject;
  /** TODO(gap): patient_subject persistence may require future schema support. */
  patient_subject_persistence_gap?: boolean;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface RpcContactCaseContext {
  contact: RpcContactRecord;
  active_case?: RpcCaseRecord | null;
  recent_case_ids?: string[];
}

export interface RpcBookingContext {
  active_hold_id?: string | null;
  active_hold_expires_at?: string | null;
  active_appointment_id?: string | null;
  last_known_slot_id?: string | null;
  timezone?: string | null;
  /** TODO(gap): post-booking lookup context may require future RPC support. */
  post_booking_context_gap?: boolean;
}

export interface RpcAvailabilitySlot {
  slot_id: string;
  starts_at: string;
  ends_at: string;
  provider_id?: string | null;
  location_id?: string | null;
  service_id?: string | null;
  timezone?: string | null;
}

export interface RpcHoldRecord {
  hold_id: string;
  slot_id: string;
  contact_id: string;
  case_id: string;
  status: "active" | "cancelled" | "expired";
  starts_at: string;
  ends_at: string;
  expires_at: string;
}

export interface RpcAppointmentRecord {
  appointment_id: string;
  hold_id?: string | null;
  contact_id?: string | null;
  case_id?: string | null;
  status?: "booked_pending_admin_confirmation" | "booked_confirmed" | "cancelled" | "unknown";
  starts_at?: string | null;
  ends_at?: string | null;
  /** TODO(gap): appointment.lookup RPC may require future implementation. */
  lookup_rpc_gap?: boolean;
}

export interface RpcPreparedNotification {
  notification_type: "admin_booking_review" | "admin_follow_up" | "admin_unknown";
  dedupe_key?: string | null;
  payload: Record<string, unknown>;
}

export interface RpcKnowledgeChunk {
  chunk_id: string;
  document_id?: string | null;
  score?: number;
  text: string;
  metadata?: Record<string, unknown>;
}

export interface ContactRepository {
  getOrCreateContact(input: {
    phone_e164?: string | null;
    external_ref?: string | null;
    full_name?: string | null;
    preferred_locale?: string | null;
  }): Promise<RuntimeResult<RpcContactRecord>>;

  getContactCaseContext(input: {
    contact_id: string;
  }): Promise<RuntimeResult<RpcContactCaseContext>>;

  getActiveBookingContext(input: {
    contact_id: string;
    case_id?: string | null;
  }): Promise<RuntimeResult<RpcBookingContext>>;
}

export interface CaseRepository {
  getCase(input: {
    case_id: string;
  }): Promise<RuntimeResult<RpcCaseRecord>>;

  mergeCaseState(input: {
    case_id: string;
    patch: {
      case_type?: RpcCaseRecord["case_type"];
      service_interest?: string | null;
      patient_subject?: PatientSubject;
    };
  }): Promise<RuntimeResult<RpcCaseRecord>>;

  appendCaseEvent(input: {
    case_id: string;
    event_type: string;
    payload: Record<string, unknown>;
    at?: string;
  }): Promise<RuntimeResult<{ case_id: string; event_id: string }>>;
}

export interface BookingRepository {
  checkAvailability(input: {
    clinic_id: string;
    requested_date: string;
    requested_time?: string | null;
    service_interest?: string | null;
    timezone?: string | null;
    limit?: number;
  }): Promise<RuntimeResult<{ slots: RpcAvailabilitySlot[]; timezone?: string | null }>>;

  createHold(input: {
    slot_id: string;
    contact_id: string;
    case_id: string;
  }): Promise<RuntimeResult<RpcHoldRecord>>;

  confirmBooking(input: {
    hold_id: string;
    contact_id: string;
    case_id: string;
  }): Promise<RuntimeResult<RpcAppointmentRecord>>;

  lookupAppointment(input: {
    appointment_id?: string | null;
    hold_id?: string | null;
    contact_id?: string | null;
    case_id?: string | null;
  }): Promise<RuntimeResult<RpcAppointmentRecord>>;

  cancelHold(input: {
    hold_id: string;
    reason?: string | null;
  }): Promise<RuntimeResult<RpcHoldRecord>>;
}

export interface KnowledgeRepository {
  searchKnowledge(input: {
    query: string;
    limit?: number;
    locale?: string | null;
  }): Promise<RuntimeResult<{ chunks: RpcKnowledgeChunk[] }>>;
}

export interface NotificationRepository {
  /**
   * Prepares backend notification payload contracts only.
   * No send/deliver capability is exposed at runtime level.
   */
  prepareAdminNotification(input: {
    case_id: string;
    contact_id: string;
    context?: Record<string, unknown>;
  }): Promise<RuntimeResult<RpcPreparedNotification>>;
}
