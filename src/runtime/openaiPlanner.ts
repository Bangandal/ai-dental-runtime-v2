export interface OpenAIPlannerInput {
  trace_id?: string;
  clinic_id: string;
  contact_id?: string;
  case_id?: string;
  conversation_id?: string | null;
  user_message: string;
  locale?: string | null;
  business_context?: Record<string, unknown>;
  truth_snapshot_hint?: Record<string, unknown>;
  recent_summary?: string | null;
}

export interface OpenAIPlannerResult {
  raw_planner_output: unknown;
  conversation_id?: string | null;
  model?: string;
  usage?: unknown;
}

export interface OpenAIPlanner {
  plan(input: OpenAIPlannerInput): Promise<OpenAIPlannerResult>;
}

export interface OpenAIPlannerCallerInput {
  model: string;
  conversation_id?: string | null;
  messages: Array<{ role: "system" | "user" | "developer"; content: string }>;
  response_format?: unknown;
}

export interface OpenAIPlannerCallerOutput {
  output: unknown;
  conversation_id?: string | null;
  usage?: unknown;
}

export type OpenAIPlannerCaller = (input: OpenAIPlannerCallerInput) => Promise<OpenAIPlannerCallerOutput>;

export interface CreateOpenAIPlannerDeps {
  caller: OpenAIPlannerCaller;
  model: string;
  buildSystemInstruction?: (input: OpenAIPlannerInput) => string;
  response_format?: unknown;
}

const ALLOWED_RUNTIME_TOOLS = [
  "kb.search",
  "availability.check",
  "hold.create",
  "booking.confirm",
  "cancel_hold",
  "appointment.mutate",
] as const;

export function buildPlannerSystemInstruction(_input: OpenAIPlannerInput): string {
  return [
    "You are the runtime planner. Return JSON only.",
    "Your JSON must include fields compatible with PlannerOutput:",
    "turn_type, confidence, tools_requested, reply_strategy, booking_action, explicit_patient_confirmation, booking_request (optional).",
    `Allowed tools_requested values: ${ALLOWED_RUNTIME_TOOLS.join(", ")}.`,
    "Never request admin.notify.",
    "Never claim booking is confirmed.",
    "Never invent prices or medical facts.",
    "Never execute tools.",
    "Never write to DB, calendar, or CRM.",
    "Use low confidence when unsure.",
    "Prefer clarification when date/time/service is ambiguous.",
    "Conversation memory is for dialogue continuity only, not business truth.",
    "Business truth must come from runtime context and Supabase/Postgres, not model memory.",
    "Do not use model memory as source of truth for active holds, appointment status, prices, insurance coverage, clinic facts, patient identity, or case state.",
  ].join("\n");
}

function buildUserMessage(input: OpenAIPlannerInput): string {
  const context = {
    trace_id: input.trace_id ?? null,
    clinic_id: input.clinic_id,
    contact_id: input.contact_id ?? null,
    case_id: input.case_id ?? null,
    locale: input.locale ?? null,
    recent_summary: input.recent_summary ?? null,
    business_context: input.business_context ?? {},
    truth_snapshot_hint: input.truth_snapshot_hint ?? {},
    user_message: input.user_message,
  };

  return `Runtime context (JSON):\n${JSON.stringify(context)}\n\nPatient message:\n${input.user_message}`;
}

export function createOpenAIPlanner(deps: CreateOpenAIPlannerDeps): OpenAIPlanner {
  const { caller, model, response_format } = deps;
  const buildSystemInstructionFromInput = deps.buildSystemInstruction ?? buildPlannerSystemInstruction;

  return {
    async plan(input: OpenAIPlannerInput): Promise<OpenAIPlannerResult> {
      const systemInstruction = buildSystemInstructionFromInput(input);
      const userPrompt = buildUserMessage(input);

      const callResult = await caller({
        model,
        conversation_id: input.conversation_id,
        messages: [
          { role: "system", content: systemInstruction },
          { role: "user", content: userPrompt },
        ],
        response_format,
      });

      // TODO: Persist conversation_id in repository/case/contact state in a later PR.
      return {
        raw_planner_output: callResult.output,
        conversation_id: callResult.conversation_id,
        model,
        usage: callResult.usage,
      };
    },
  };
}
