import { SYSTEM_PROMPT_TEMPLATE, FIRST_TURN_ROUTING } from "./systemPromptTemplate.ts";

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
  /** Model-produced subject switch intent for multi-person booking flows. */
  subject_intent?: import("./bookingSubjectsState.ts").SubjectIntent | null;
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
  const firstTurnBlock = isNewConversation ? FIRST_TURN_ROUTING + "\n" : "";

  return SYSTEM_PROMPT_TEMPLATE
    .replace("{{TODAY_DATE}}", todayDate)
    .replace("{{TIMEZONE}}", timezone)
    .replace("{{FIRST_TURN_ROUTING}}", firstTurnBlock);
}
