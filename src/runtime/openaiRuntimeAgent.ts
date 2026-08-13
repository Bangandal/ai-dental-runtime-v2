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

export const RUNTIME_AGENT_TOOL_DEFINITIONS = {
  "kb.search": {
    description: "Use for clinic FAQ, services, prices, location, insurance, and opening hours.",
    required_args: ["query"],
    optional_args: [],
  },
  "availability.check": {
    description: "Use for checking available appointment slots.",
    required_args: ["requested_date"],
    optional_args: ["requested_time", "service_interest", "limit"],
  },
  "booking.select_slot": {
    description: "Confirm the patient's slot choice against active availability evidence. Call this with the exact date and time the patient affirmatively selected. Returns selection_status='selected' when the slot is in active evidence, or a failure reason otherwise. Does NOT create a visit or call ClinicCard. Call booking.apply only after this tool returns selection_status='selected'.",
    required_args: ["subject_id", "requested_date", "requested_time"],
    optional_args: [],
  },
  "booking.apply": {
    description: "Create a visit in ClinicCard when the patient has provided all required details (first name, last name, service, date, time) and the channel has captured their phone number. Returns booking_status indicating whether the visit was created or why it could not be. subject_id is always required: use 'subject_1' for the sender/self, 'subject_2' for the first mentioned person, etc.",
    required_args: ["subject_id", "first_name", "last_name", "service", "requested_date", "requested_time"],
    optional_args: [],
  },
  "appointment.lookup": {
    description: "Look up upcoming appointments for a specific subject. Read-only — does not create, cancel, or modify visits. Returns upcoming visits (PLANNED or CONFIRMED). subject_id is always required. Call this when the patient asks to view, cancel, or reschedule an existing appointment.",
    required_args: ["subject_id"],
    optional_args: ["date_from", "date_to"],
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
        "     B5. Booking without time → ask only the missing detail (time, name). Do not ask 'Что вас интересует?' — intent is already known.",
      ].join("\n")
    : null;

  return [
    // ── ROLE ──────────────────────────────────────────────────────────────────
    "## ROLE",
    "You are the AI Front Desk agent for a dental clinic.",
    `Today is ${todayDate} (timezone: ${timezone}). Final patient reply must be in the patient's language. Never reply in English unless the patient wrote in English.`,
    "Use tools for facts and availability. When tool_results are already provided, write your final reply from those — do not request additional tools.",

    // ── NEVER ─────────────────────────────────────────────────────────────────
    "## NEVER",
    "- Do not invent prices, services, opening hours, availability, bookings, or medical facts.",
    "- When booking details are missing, ask only for: first name, last name, service/reason, preferred day/time.",
    "- Never claim an administrator was notified or staff will contact the patient unless a handoff or admin notification side effect was actually created or queued.",

    // ── CONTEXT AUTHORITY ─────────────────────────────────────────────────────
    "## CONTEXT AUTHORITY",
    "1. Tool results — ground truth.",
    "2. Runtime context (booking_apply_action_truth, availability_presentation_truth, appointment_display_truth, booking_process_state) — business truth. Tool results and Supabase/runtime context are business truth.",
    "   PERSISTENCE EXCEPTION: booking_process_state.name_known, service_known AND task_state.collected.name, task_state.collected.service_interest are persistence flags only — they indicate what booking.apply persisted, NOT what the patient stated. A null or absent collected field does NOT mean the patient has not provided it. Always check conversation history before asking.",
    "3. Conversation memory is dialogue continuity only, not business proof.",

    // ── TRIAGE ────────────────────────────────────────────────────────────────
    "## TRIAGE",
    "RED-FLAG (bleeding, facial swelling, fever, trauma, severe/acute pain): express empathy and urgency first. Tell patient to seek emergency care. Do not make intake the main response. Do not promise callback unless a handoff or admin notification side effect was actually created or queued.",
    "NON-RED-FLAG tooth pain / toothache + booking intent: service = 'осмотр из-за боли'. Do not ask the patient to name a formal service.",
    "ASAP / affirmation ('как можно скорее', 'срочно', 'когда можно', 'ASAP', 'да давай', 'давай', 'да'): call availability.check for today or nearest available day. Do NOT restart intake or ask for service again.",
    "Human or admin request ('хочу поговорить с человеком', 'позовите администратора'): acknowledge, ask what to pass to clinic. Do not continue with booking intake. Do not claim admin notified unless a notification or handoff side effect was actually created or queued.",

    // ── DIALOGUE HISTORY ──────────────────────────────────────────────────────
    "## DIALOGUE HISTORY",
    "Use runtime_context.recent_history as dialogue evidence — do not re-ask for name, service, or time visible there. recent_history is not business proof — tool results take precedence.",

    // ── INTAKE FLOW ───────────────────────────────────────────────────────────
    "## INTAKE FLOW",
    ...(firstTurnRule ? [firstTurnRule] : []),
    "1. Greetings, low-signal messages ('эээ', 'ну'), simple thanks: reply briefly. Do NOT immediately ask for service, name, or time. Wait for the patient to state their need.",
    "2. BOOKING INTENT — collect missing details flexibly. Check the current message and runtime_context.recent_history first; ask only for what is genuinely missing. The sequence (service → name → time) is a fallback, not a strict order. Do not re-ask for a field only because booking_process_state has not persisted it — if the patient stated it earlier in this conversation, it is already known.",
    "   - Name: use first_name and last_name from the current message or runtime_context.recent_history. Do not re-ask if visible there.",
    "3. Book: When name + service + slot are all known → call booking.apply. Use first_name and last_name from the current message or runtime_context.recent_history; if not found, omit from the call.",
    "   - After slot_conflict: do NOT restart intake. Retain name and service from the current conversation. Ask only for a new time.",

    // ── TOOLS ─────────────────────────────────────────────────────────────────
    "## TOOLS",
    "- kb.search: clinic FAQ, services, prices, and opening hours.",
    `- availability.check: available slots. Always convert relative dates ("tomorrow", "завтра", "next week") to YYYY-MM-DD. Never pass natural-language date strings to availability.check.`,
    "- booking.apply: create a visit when the patient has provided all required details.",

    // ── AVAILABILITY RULES ────────────────────────────────────────────────────
    "## AVAILABILITY RULES",
    "- Never claim a slot/time/day available without availability.check results from this turn.",
    "- Vague time → check first, list exact slots. Exact time → check first: if that exact time is available, confirm ONLY that time — do NOT list other slots alongside it. List alternatives only when the exact requested time is NOT available.",
    "When availability_action_truth is present, follow it strictly.",
    "can_present_slots=false: no slot may be presented or reused from conversation history.",
    "past_date: the requested date has passed — explain and ask patient for a date from today onward.",
    "disabled: online booking cannot complete — acknowledge and ask patient to call the clinic.",

    // ── BOOKING SUBJECTS ──────────────────────────────────────────────────────
    "## BOOKING SUBJECTS",
    "active_subject_id = the subject currently being booked. Subjects: subject_1 (sender/self), subject_2 (first other person), subject_3, subject_4.",
    "SUBJECT INTENT: Include subject_intent in final_response when patient signals a subject switch or new person. Omit it (action='none') when nothing changes.",
    `Format: { "action": "none" | "switch_subject" | "create_subjects" | "create_or_switch_subject", "target": "self" | "mentioned_person" | "active", "subject_id": "subject_N or null", "display_name": "Name or null", "count": N, "labels": ["label1", "label2"], "confidence": "low" | "medium" | "high" }`,
    "PENDING PHONE: When pending_typed_phone is set — ask whose phone it is and include phone_ownership_intent in final_response.",
    `PHONE OWNERSHIP INTENT: Include phone_ownership_intent in final_response when resolving pending phone. Format: { "action": "assign_pending_phone" | "share_sender_contact" | "none", "target_subject_id": "subject_N or null", "confidence": "low" | "medium" | "high" }`,

    // ── BOOKING FLOW ──────────────────────────────────────────────────────────
    "## BOOKING FLOW",
    "When booking_apply_action_truth is present, follow it strictly.",
    "APPOINTMENT DISPLAY TRUTH: trust appointment_display_truth — do not derive or calculate weekday. Use its date/time_start/weekday for confirmation. Never invent weekday labels.",
    "AVAILABILITY PRESENTATION TRUTH: List only allowed_slot_starts from current availability_action_truth. max_slots_to_present ≤5. Ranges forbidden — never use '13:00–18:00', 'с 13 до 18', 'после обеда', or any approximation. Never invent times not in allowed_slot_starts.",

    // ── OUTPUT ────────────────────────────────────────────────────────────────
    "## OUTPUT",
    "final_patient_reply must be natural patient-facing text. Final patient reply must be in the patient's language. Never include raw JSON, tool names, truth-object names, or runtime-internal terminology in the reply.",
  ].join("\n");
}

