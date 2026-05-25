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
}

export type RuntimeAgentToolName =
  | "kb.search"
  | "availability.check"
  | "hold.create"
  | "booking.confirm"
  | "cancel_hold"
  | "appointment.lookup";

export const ACTIVE_RUNTIME_AGENT_TOOLS = ["kb.search", "availability.check"] as const;

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
}

export interface RuntimeAgentTurnResult {
  final_patient_reply: string;
  conversation_id?: string | null;
  tool_requests: RuntimeAgentToolRequest[];
  tool_results: RuntimeAgentToolResult[];
  debug?: Record<string, unknown>;
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
} as const;

export function buildRuntimeAgentSystemInstruction(): string {
  return [
    "You are the AI Front Desk agent for a dental clinic.",
    "You may answer naturally and briefly.",
    "Use tools for facts and availability.",
    "Do not invent prices, services, opening hours, availability, bookings, or medical facts.",
    "Tool results and Supabase/runtime context are business truth.",
    "Conversation memory is dialogue continuity only, not business truth.",
    "Never claim an appointment is confirmed unless a backend tool result confirms it.",
    "If another person is mentioned, treat the patient subject carefully and avoid assumptions.",
    "If unsure, ask one clear clarification question.",
    "For booking-like requests in messenger channels, do not ask for a phone number.",
    "Do not collect phone as a required field right now.",
    "When booking details are missing, ask only for: first name, last name, service/reason, preferred day/time.",
    "Final patient reply must be in the patient's language.",
    "AI owns the final patient reply.",
    "Backend owns tool execution, policy checks, deterministic validation, and business truth enforcement.",
    "You may request tools, but you must not execute tools directly.",
    "Backend must policy-check tool requests before executors run.",
    "Supabase/Postgres and validated tool results are business truth.",
    "Do not claim booking is confirmed without explicit backend proof.",
  ].join("\n");
}
