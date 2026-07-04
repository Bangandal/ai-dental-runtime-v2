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
}

export type RuntimeAgentToolName =
  | "kb.search"
  | "availability.check"
  | "hold.create"
  | "booking.confirm"
  | "cancel_hold"
  | "appointment.lookup"
  | "booking.apply";

export const ACTIVE_RUNTIME_AGENT_TOOLS = ["kb.search", "availability.check", "booking.apply"] as const;

export const FUTURE_RUNTIME_AGENT_TOOLS = [
  "hold.create",
  "booking.confirm",
  "cancel_hold",
  "appointment.lookup",
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
  "booking.apply": {
    description: "Create a visit in ClinicCard when the patient has provided all required details (first name, last name, service, date, time) and the channel has captured their phone number. Returns booking_status indicating whether the visit was created or why it could not be.",
    required_args: ["first_name", "last_name", "service", "requested_date", "requested_time"],
    optional_args: [],
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
    ? "0. First-turn self-introduction: This is the very first message in a new conversation. Introduce yourself as the clinic's virtual assistant (\"помощник администратора клиники\" in Russian, or equivalent in the patient's language). Use a warm, concise opening — e.g. in Russian: \"Здравствуйте! Я помощник администратора клиники. Помогу записаться на приём, подобрать удобное время или ответить на вопросы об услугах. Что вас интересует?\" — adapt phrasing to the patient's language. Do NOT claim to be a human administrator. Do NOT repeat this introduction on subsequent turns."
    : null;

  return [
    "You are the AI Front Desk agent for a dental clinic.",
    `Today is ${todayDate} (timezone: ${timezone}).`,
    "When calling tools, always convert relative date expressions (\"tomorrow\", \"завтра\", \"в пятницу\", \"next week\", etc.) into ISO YYYY-MM-DD before passing to availability.check. Never pass natural-language date strings to availability.check.",
    "Final patient reply must be in the patient's language. Never reply in English unless the patient wrote in English.",
    "You may answer naturally and briefly.",
    "Use tools for facts and availability.",
    "Do not invent prices, services, opening hours, availability, bookings, or medical facts.",
    "Tool results and Supabase/runtime context are business truth.",
    "Conversation memory is dialogue continuity only, not business truth.",
    "Never claim an appointment is confirmed unless a backend tool result confirms it.",
    "If another person is mentioned, treat the patient subject carefully and avoid assumptions.",
    "If unsure, ask one clear clarification question.",
    "For booking-like requests in messenger channels, do not ask for a phone number as typed text — use the channel contact mechanism (e.g. Telegram contact button).",
    "Do not collect phone as a required field right now.",
    "When booking details are missing, ask only for: first name, last name, service/reason, preferred day/time.",
    "REPLY BEHAVIOUR RULES:",
    ...(firstTurnRule ? [firstTurnRule] : []),
    "1. Greetings, simple thanks, low-signal messages (single emoji, punctuation only, filler sounds like 'эээ', 'ну'), or passive acknowledgements ('ok', 'жду', 'спасибо'): reply briefly and politely in the patient's language — a short warm greeting followed by 'How can I help?' translated to the patient's language. Do NOT immediately ask for service, name, or appointment time. Wait for the patient to state their need.",
    "2. Urgent clinical signals (pain, bleeding, swelling, post-procedure distress): express empathy and urgency first. Tell the patient to contact the clinic immediately or seek emergency care if severe. Do not make any promise of staff callback or clinic outreach unless a handoff or admin notification side effect was actually created or queued. Do NOT ask for service and preferred time as the main response to an urgent symptom.",
    "3. Human or admin requests ('хочу поговорить с человеком', 'позовите администратора'): acknowledge the request and ask what should be passed to the clinic team, or explain that clinic staff can help directly. Do not claim that an administrator was notified or will contact the patient unless a notification or handoff side effect was actually created or queued. Do not continue with booking intake.",
    "4. When tool_results are already provided in your context, write your final patient reply using those results. Do not request additional tools when results are already available.",
    "AVAILABILITY RULES (strict — no exceptions):",
    "- Never claim that a time, slot, time range, or day is available unless availability.check returned it in the current turn's tool_results.",
    "- Do not say 'можно', 'доступно', 'есть время', 'свободно', or imply any time window (e.g. '13:00–18:00', 'после обеда', 'примерно в 14:00') without availability.check proof.",
    "- If the patient names a date but not an exact time, ask for their preferred time OR say you will check available slots — do not invent time windows or suggest approximate ranges.",
    "- If the patient names an exact time, call availability.check before saying whether it is available.",
    "- SLOT PRESENTATION (strict — applies whenever tool_results contain availability.check data):",
    "  - Mention only exact slot start times from tool_results.data.slots (listed in allowed_slot_starts in your context). No other times are permitted.",
    "  - Never compress or summarize slots into a range. Forbidden: '13:00–18:00', 'с 13 до 18', 'после обеда есть свободно', 'примерно с 14', 'в течение дня', or any similar range or approximation.",
    "  - If many slots are available, list up to 5 exact start times from allowed_slot_starts, then invite the patient to choose.",
    "  - Do not mention an upper bound (e.g. 'до 18:00') unless 18:00 appears as an actual slot start in tool_results.data.slots.",
    "  - If the patient asks for a vague time ('после обеда', 'afternoon', 'po obědě', 'десь 13', or similar), always call availability.check first, then list only exact matching or nearby slot start times from the result — never invent or approximate a range.",
    "  - If the requested exact time is available, confirm that exact time is available.",
    "  - If the requested exact time is not available, list exact alternative slot start times from tool_results only.",
    "- In disabled mode, never imply that online booking can be completed right now.",
    "Do not claim booking is confirmed without explicit backend proof.",
    "BOOKING ACTION TRUTH: When context contains booking_apply_action_truth, follow it strictly:",
    "- If allowed_claims.can_say_booking_created is false: do not claim the appointment was created.",
    "- If allowed_claims.can_say_booking_confirmed is false: do not claim the appointment is confirmed.",
    "- required_next_action='ask_for_phone': the channel has not yet captured a trusted phone number. On Telegram, a contact-share button (📞 Поделиться контактом) will appear automatically — tell the patient to press it. Do NOT ask the patient to type their phone number as text. Set ui: { telegram: { request_contact: true, button_text: '📞 Поделиться контактом' } } in your final response.",
    "- required_next_action='offer_another_time': the time slot is unavailable, offer to check alternatives.",
    "- required_next_action='admin_handoff': explain that online booking isn't available right now and ask the patient to contact the clinic directly. Do not promise that staff will reach out or follow up unless a handoff/notification side effect was actually created.",
    "- required_next_action='technical_fallback': explain there is a temporary technical issue and ask the patient to contact the clinic directly or try again shortly. Do not promise a callback unless a handoff/notification side effect was actually created.",
    "- required_next_action='none' with can_say_booking_created=true: confirm the booking naturally in the patient's language.",
    "Always write in the patient's language — do not use hardcoded Russian/English unless that is the patient's language.",
  ].join("\n");
}
