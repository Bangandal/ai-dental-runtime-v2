export interface TelegramUiActions {
  request_contact?: boolean;
  button_text?: string;
}

export interface AgentUiActions {
  telegram?: TelegramUiActions;
}

export interface ChannelContact {
  phone_number: string;
  phone_source: "telegram_contact_button" | "whatsapp_sender" | "manual_input" | "existing_cliniccard_patient";
  phone_consent?: boolean;
  phone_collected_at?: string;
}

/**
 * Phone supplied by the patient as typed text — used when booking for a third
 * party who cannot share their own Telegram contact. Trust level is "unverified"
 * (no channel mechanism confirmed ownership). hasTrustedPhone() returns false;
 * hasBookingContactPhone() returns true so booking.apply can proceed.
 */
export interface ProvidedPhone {
  phone_number: string;
  phone_source: "typed";
  phone_trust: "unverified";
  phone_consent: false;
  phone_collected_at: string;
}

export interface RuntimeAgentTurnInput {
  trace_id?: string;
  clinic_id: string;
  contact_id?: string | null;
  case_id?: string | null;
  conversation_id?: string | null;
  user_message: string;
  locale?: string | null;
  business_context?: Record<string, unknown>;
  truth_snapshot?: Record<string, unknown>;
  recent_summary?: string | null;
  /** True only when the stateful pipeline confirmed no prior conversation memory exists for this contact. Set by RuntimeTurnOrchestrator before runTurn is called. */
  is_first_patient_turn?: boolean;
  /** Phone captured from the channel (e.g. Telegram contact button). Forwarded to booking.apply executor via ToolExecutionContext. */
  channel_contact?: ChannelContact;
  /** Phone typed as text by the patient — unverified, lower trust than channel_contact. Used when channel_contact is absent (e.g. booking for a third party). */
  provided_phone?: ProvidedPhone | null;
  /** Booking subjects state — when present, execution context uses active subject's phone instead of global provided_phone/channel_contact. */
  booking_subjects?: import("./bookingSubjectsState.ts").BookingSubjectsState | null;
  /** Typed phone extracted from the current turn's message only. Set by orchestrator from
   * typedContactToStore — never from persisted existingProvidedPhone. Used to populate
   * pending_typed_phone when bootstrap creates a new multi-subject registry this turn. */
  current_turn_typed_phone?: string | null;
  /** True when this conversation ever had an active or completed booking_subjects registry.
   * Set by orchestrator when persisted booking_subjects (including completed) is non-null.
   * Causes any legacy typed provided_phone to be suppressed — old ownerless typed phones
   * from a prior multi-subject flow must not leak into a new single-subject self-booking. */
  had_booking_subjects?: boolean;
}

export type RuntimeAgentToolName =
  | "kb.search"
  | "availability.check"
  | "hold.create"
  | "booking.confirm"
  | "cancel_hold"
  | "appointment.lookup"
  | "booking.select_slot"
  | "booking.apply";

export const ACTIVE_RUNTIME_AGENT_TOOLS = ["kb.search", "availability.check", "booking.select_slot", "booking.apply", "appointment.lookup"] as const;

export const FUTURE_RUNTIME_AGENT_TOOLS = [
  "hold.create",
  "booking.confirm",
  "cancel_hold",
] as const;

export interface RuntimeAgentToolRequest {
  tool: RuntimeAgentToolName;
  arguments: Record<string, unknown>;
  call_id?: string;
}

export interface RuntimeAgentToolResult {
  tool: RuntimeAgentToolName;
  call_id?: string;
  status: "success" | "failed" | "denied";
  data?: unknown;
  error?: {
    code: string;
    message: string;
    retryable?: boolean;
  };
}

export interface RuntimeAgentFinalResponse {
  final_patient_reply: string;
  language?: string | null;
  reply_reason?: string | null;
  safety_notes?: string[];
  ui?: AgentUiActions;
  /** Model-produced subject switch intent for multi-person booking flows. */
  subject_intent?: import("./bookingSubjectsState.ts").SubjectIntent | null;
  /** Model-produced phone ownership resolution intent. */
  phone_ownership_intent?: import("./bookingSubjectsState.ts").PhoneOwnershipIntent | null;
}

export interface RuntimeAgentTurnResult {
  final_patient_reply: string;
  conversation_id?: string | null;
  /** False when conversation_id (if any) has a pending function_call with no
   * function_call_output submitted and must not be persisted/resumed on a later
   * turn — resuming it fails upstream with a 400 "No tool output found" error.
   * Absent/true means the conversation_id (if present) is safe to persist/resume. */
  conversation_id_resumable?: boolean;
  tool_requests: RuntimeAgentToolRequest[];
  tool_results: RuntimeAgentToolResult[];
  debug?: Record<string, unknown>;
  ui?: AgentUiActions;
  /** Validated subject_intent from the model's final response — propagated for
   * postUpdateBookingSubjects to apply after the turn completes. */
  subject_intent?: import("./bookingSubjectsState.ts").SubjectIntent | null;
  /** Validated phone_ownership_intent from the model's final response. */
  phone_ownership_intent?: import("./bookingSubjectsState.ts").PhoneOwnershipIntent | null;
  /** Frozen execution subject resolved by Guard J before tool execution. Propagated for
   * orchestrator to use in postUpdateBookingSubjects — never re-derived from tool arguments. */
  execution_subject_id?: import("./bookingSubjectsState.ts").SubjectId | null;
  /** Booking subjects state after Guard J resolution (may include bootstrapped registry).
   * Orchestrator should use this as the base for postUpdateBookingSubjects when present. */
  booking_subjects_after_resolution?: import("./bookingSubjectsState.ts").BookingSubjectsState | null;
  /** Identifies which booking.apply request was eligible for execution this turn and which
   * subject it targeted. Orchestrator must use this call_id to match request/result in
   * postUpdateBookingSubjects — never re-derive from toolRequests.find(). */
  booking_apply_resolution?: BookingApplyResolution | null;
}

export interface BookingApplyResolution {
  call_id: string;
  subject_id: import("./bookingSubjectsState.ts").SubjectId;
}

export interface OpenAIRuntimeAgent {
  runTurn(input: RuntimeAgentTurnInput): Promise<RuntimeAgentTurnResult>;
}

const PATIENT_TARGET_PARAM_SCHEMA = {
  type: "string",
  enum: ["self", "other_person"],
  description: "Business-semantic patient target: self for the sender/patient, other_person for another person. Runtime resolves the internal patient identity.",
} as const;

export const RUNTIME_AGENT_TOOL_DEFINITIONS = {
  "kb.search": {
    description: "Use for clinic FAQ, services, prices, location, insurance, and opening hours.",
    required_args: ["query"],
    optional_args: [],
  },
  "availability.check": {
    description: "Check appointment slots. For a specific time, pass requested_time once. Result includes requested_time_available and free slots at/after it; if false, offer returned alternatives without another availability.check.",
    required_args: ["requested_date"],
    optional_args: ["requested_time", "service_interest", "limit"],
  },
  "booking.select_slot": {
    description: "Confirm the active patient's slot choice against active availability evidence. Call this with the exact date and time the patient affirmatively selected. Returns selection_status='selected' when the slot is in active evidence, or a failure reason otherwise. Does NOT create a visit or call ClinicCard. Runtime binds the selection to the active patient; do not provide an internal patient identifier. Call booking.apply only after this tool returns selection_status='selected'.",
    required_args: ["requested_date", "requested_time"],
    optional_args: [],
  },
  "booking.apply": {
    description: "Create a visit in ClinicCard for the intended patient when required booking details are present, slot selection is verified, and runtime has an acceptable booking contact. Set patient_target='self' when the sender is the patient, or patient_target='other_person' when booking for another person. Runtime owns internal patient identity. Returns booking_status indicating whether the visit was created or why it could not be.",
    required_args: ["patient_target", "first_name", "last_name", "service", "requested_date", "requested_time"],
    optional_args: [],
    param_schemas: {
      patient_target: PATIENT_TARGET_PARAM_SCHEMA,
    },
  },
  "appointment.lookup": {
    description: "Look up upcoming appointments for the intended patient. Set patient_target='self' for the sender's appointments, or patient_target='other_person' for another person's appointments. Runtime owns internal patient identity. Read-only: does not create, cancel, or modify visits.",
    required_args: ["patient_target"],
    optional_args: ["date_from", "date_to"],
    param_schemas: {
      patient_target: PATIENT_TARGET_PARAM_SCHEMA,
    },
  },
} as const;

export interface RuntimeAgentSystemInstructionOptions {
  now?: Date;
  timezone?: string;
  is_new_conversation?: boolean;
}

function formatDateInTimezone(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function buildRuntimeAgentSystemInstruction(opts?: RuntimeAgentSystemInstructionOptions): string {
  const timezone = opts?.timezone ?? "Europe/Prague";
  const todayDate = formatDateInTimezone(opts?.now ?? new Date(), timezone);
  const isNewConversation = opts?.is_new_conversation ?? false;

  const firstTurnRule = isNewConversation
    ? [
        "0. FIRST-TURN ROUTING: First patient message — choose path:",
        "   PATH A — Low-signal (no clear intent): pure greeting ('привет', 'здравствуйте'), emoji, punctuation, filler ('эээ', 'ну'), vague opener ('можно спросить?'). → Introduce yourself as the clinic's virtual assistant ('помощник администратора клиники' in Russian, or equivalent in the patient's language). Ask 'Что вас интересует?' Do NOT claim to be a human administrator. Do NOT repeat this introduction on subsequent turns.",
        "   PATH B — Clear intent in first message. Reply 'Здравствуйте!' and act immediately — do NOT ask 'Что вас интересует?':",
        "     B1. Red-flag symptoms → safety guidance first (TRIAGE rules). No normal availability intake as main response. No booking.apply.",
        "     B2. Price/FAQ ('сколько стоит', 'цена', 'прайс', 'стоимость') → call kb.search. No booking intake.",
        "     B3. Booking + ASAP ('как можно скорее', 'срочно', 'ASAP') → call availability.check for today/nearest day. Non-red-flag pain + booking intent → service = 'осмотр из-за боли'; do not ask 'какая услуга?' or 'Что вас интересует?'",
        "     B4. Booking + time hint ('завтра', 'в пятницу', 'в 09:00', 'утром') → call availability.check. No generic opening question.",
        "     B5. Booking without a usable time hint: collect only genuinely missing booking details. Do not ask a generic opening question.",
      ].join("\n")
    : null;

  return [
    "## ROLE",
    "You are the AI Front Desk agent for a dental clinic.",
    `Today is ${todayDate} (timezone: ${timezone}). Final patient reply must be in the patient's language. Never reply in English unless the patient wrote in English.`,
    "Use tools for facts and availability. When tool_results are provided, treat them as authoritative. Request another tool only when required for the next valid step; otherwise produce the final reply.",

    "## NEVER",
    "- Do not invent prices, services, opening hours, availability, bookings, or medical facts.",
    "- Never claim a slot, time, or day is available without availability.check tool evidence.",
    "- Never claim an administrator was notified or staff will contact the patient unless a handoff or admin notification side effect was actually created or queued.",
    "- Ask only for information genuinely missing from the conversation/runtime context. When structured required_next_action exists, follow it.",

    "## CONTEXT AUTHORITY",
    "Tool results and Supabase/runtime context are business truth. Tool results take precedence over conversation memory.",
    "Conversation memory is dialogue continuity only, not business proof.",
    "Runtime context (booking_apply_action_truth, availability_presentation_truth, appointment_display_truth, booking_process_state) — business truth.",
    "PERSISTENCE FLAGS: booking_process_state.name_known and service_known are persistence flags only — check conversation history before asking. task_state.collected.name and task_state.collected.service_interest are persistence flags; null or absent collected field does NOT mean the patient has not provided it.",

    "## TRIAGE",
    "RED-FLAG (bleeding, facial swelling, fever, trauma, severe/acute pain, post-procedure distress): express empathy and urgency; advise urgent clinic contact or emergency care when appropriate. Do not make routine booking intake the main response.",
    "NON-RED-FLAG tooth pain / toothache + booking intent: service = 'осмотр из-за боли'. Do not ask the patient to name a formal service.",
    "ASAP ('как можно скорее', 'срочно', 'когда можно', 'ASAP'): call availability.check for today or nearest available day.",
    "Affirmation ('да', 'давай', 'да давай') after an offered check: perform that check preserving context date/time. Do NOT default to today.",
    "Human/admin request ('хочу поговорить с человеком', 'позовите администратора'): acknowledge, ask what to pass to clinic. Do not continue with booking intake. No notification claims unless a notification or handoff side effect was actually created or queued.",

    "## DIALOGUE HISTORY",
    "Use runtime_context.recent_history as dialogue evidence only. recent_history is not business proof. Tool results take precedence.",

    "## INTAKE FLOW",
    ...(firstTurnRule ? [firstTurnRule] : []),
    "1. Greetings, low-signal messages ('эээ', 'ну'), simple thanks: reply briefly. Do NOT immediately ask for service, name, or time. Wait for the patient to state their need.",
    "2. BOOKING INTENT: collect missing details flexibly. Check the current message and runtime_context.recent_history first; ask only for what is genuinely missing. The sequence (service → name → time) is a fallback, not a strict order. Do not re-ask for a field only because booking_process_state has not persisted it — if the patient stated it earlier in this conversation, it is already known. When collecting names, use first_name and last_name from the current message or runtime_context.recent_history. Do not re-ask if visible there.",
    "3. BOOKING SEQUENCE: availability.check → patient affirmatively chooses one offered slot → booking.select_slot → booking.apply. booking.select_slot is mandatory before booking.apply. After slot_conflict: do NOT restart intake. Retain name and service from the current conversation. Ask only for a new time.",
    "4. For questions about an existing appointment or modification intent, use appointment.lookup first.",

    "## TOOLS",
    "- kb.search: clinic FAQ, services, prices, and opening hours.",
    `- availability.check: slots. Convert relative dates ("tomorrow", "завтра", "next week") to YYYY-MM-DD. Never pass natural-language date strings to availability.check.`,
    "- booking.select_slot: confirm patient's slot choice against availability evidence. Required step before booking.apply.",
    "- booking.apply: create a visit. Call only after booking.select_slot returns selection_status='selected'.",
    "- appointment.lookup: existing appointments (read-only).",

    "## AVAILABILITY RULES",
    "- Use only slots present in structured model-visible context. Never resurrect availability from prose conversation history. Structured availability truth overrides prose history.",
    "- Vague time (\"после обеда\"/afternoon): availability.check; list exact slots, never \"13:00–18:00\", \"с 13 до 18\", or \"после обеда есть\". Exact time: if available confirm ONLY it; else returned alternatives.",
    "When availability_action_truth is present, follow it strictly.",
    "can_present_slots=false: no slot may be presented or reused from conversation history.",
    "past_date: the requested date has passed — explain and ask patient for a date from today onward.",

    "## BOOKING PEOPLE",
    "Identify from booking_subjects.subjects label/name, person_kind, is_active.",
    `Switch/create: put subject_intent in final_response:{action:"none"|"switch_subject"|"create_subjects",target:"self"|"active"|"other_person",person_ref:null|string,display_name:null|string,count:null|1..4,labels:[],confidence:"low"|"medium"|"high"}.`,
    "Multiple other_person: person_ref=exact visible label/patient_name; if ambiguous, ask.",
    `pending_typed_phone: ask owner; put phone_ownership_intent in final_response:{action:"assign_pending_phone"|"share_sender_contact"|"none",target:"self"|"active"|"other_person",person_ref:null|string,confidence:"low"|"medium"|"high"}.`,
    "Never emit subject_id, target_subject_id, subject_1..4.",

    "## BOOKING FLOW",
    "booking_apply_action_truth present: follow allowed_claims/required_next_action strictly. Never claim booking success unless allowed_claims permits it.",
    "APPOINTMENT DISPLAY TRUTH: trust appointment_display_truth date/time_start/weekday; do not calculate weekday; never invent labels.",
    "AVAILABILITY PRESENTATION TRUTH: only allowed_slot_starts from current availability_action_truth (max max_slots_to_present); allowed_slots carry details. Slot/booking.select_slot date=resolved_date; labels=resolved_calendar. If requested_date!=resolved_date, never pair old date with returned times. Never range; never invent times.",

    "## OUTPUT",
    "final_patient_reply: natural patient-facing text. Never include raw JSON, tool names, or runtime-internal terminology.",
  ].join("\n");
}