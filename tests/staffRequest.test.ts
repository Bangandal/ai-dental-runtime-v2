import test from "node:test";
import assert from "node:assert/strict";
import { parseStaffRequest, type StaffRequest } from "../src/runtime/staffRequest.ts";
import { withStaffRequestHandling } from "../src/runtime/staffRequestHandling.ts";
import { normalizeOpenAIResponse } from "../src/runtime/openaiRuntimeAgentCaller.ts";
import { createDentalRuntimeTurnService } from "../src/runtime/runtimeTurnService.ts";
import { runRuntimeTurnOrchestrated, type RuntimeTurnOrchestratorDeps } from "../src/runtime/runtimeTurnOrchestrator.ts";
import { buildModelVisibleRuntimeContext } from "../src/runtime/modelVisibleRuntimeContext.ts";
import { createSupabaseStaffRequestRepository } from "../src/runtime/supabaseStaffRequestRepository.ts";
import { createAdminNotifier } from "../src/integrations/adminNotify/telegramAdminNotifier.ts";
import type { AdminNotificationPayload, AdminNotificationResult } from "../src/integrations/adminNotify/adminNotifyTypes.ts";
import type { RpcCaller } from "../src/runtime/runtimeRepositories.ts";

process.env.RUNTIME_AGENT_MODE = "agent_first";
process.env.LEGACY_CASE_ROUTER_ENABLED = "false";

const CLINIC = "11111111-1111-4111-8111-111111111111";
const CONTACT = "22222222-2222-4222-8222-222222222222";
const request: StaffRequest = {
  kind: "callback", patient_target: "self", person_ref: "відправник",
  summary: "Пацієнт очікує обіцяного дзвінка лікаря. Зручно завтра о 10–11.",
  preferred_contact_window: "завтра 10–11", reply_language: "uk",
};
const input = {
  clinic_id: CLINIC, contact_id: CONTACT, trace_id: "trace-callback",
  user_message: "Добрий вечір, 10–11 година.", locale: "ru",
  business_context: { channel: "telegram", chat_id: "test-chat", clinic_code: "test-clinic" },
};

function setup(opts: { status?: AdminNotificationResult["status"]; failSave?: boolean; failAudit?: boolean; duplicate?: boolean; throwNotify?: boolean } = {}) {
  const events: string[] = [];
  let notified: AdminNotificationPayload | undefined;
  const deps: RuntimeTurnOrchestratorDeps = {
    runtimeTurnService: { async runTurn() { return {
      final_patient_reply: "Лікар точно зателефонує о 10:00.", tool_requests: [], tool_results: [], staff_request: request,
    }; } },
    staffRequestRepository: {
      async create() {
        events.push("save");
        return opts.failSave
          ? { ok: false, error: { code: "offline", message: "offline", retryable: true } }
          : { ok: true, data: { request_id: "request-1", created: !opts.duplicate, delivery_status: "pending" } };
      },
      async recordDelivery() {
        events.push("audit");
        return opts.failAudit
          ? { ok: false, error: { code: "offline", message: "offline", retryable: true } }
          : { ok: true, data: { ok: true } };
      },
    },
    adminNotifier: { async notify(payload) {
      events.push("notify"); notified = payload;
      if (opts.throwNotify) throw new Error("unavailable");
      return { type: "admin_notification", status: opts.status ?? "sent", channel: "telegram", reason: payload.reason, trace_id: payload.trace_id };
    } },
  };
  return { deps, events, notified: () => notified };
}

test("S38/R08: save before notification; callback window never becomes an appointment; receipt follows patient language", async () => {
  const h = setup();
  const result = await withStaffRequestHandling(h.deps).runtimeTurnService.runTurn(input);
  assert.deepEqual(h.events, ["save", "notify", "audit"]);
  assert.equal(h.notified()?.requested_time, null);
  assert.equal(h.notified()?.requested_date, null);
  assert.equal(h.notified()?.created_visit, false);
  assert.equal(h.notified()?.staff_request?.preferred_contact_window, "завтра 10–11");
  assert.equal(result.staff_request_state?.proof.may_claim_notified, true);
  assert.match(result.final_patient_reply, /зворотний дзвінок передано/);
  assert.doesNotMatch(result.final_patient_reply, /точно|зателефонує о 10/);
});

for (const status of ["failed", "disabled", "not_configured", "queued"] as const) {
  test(`R08: ${status} delivery cannot claim staff were notified`, async () => {
    const h = setup({ status });
    const result = await withStaffRequestHandling(h.deps).runtimeTurnService.runTurn(input);
    assert.equal(result.staff_request_state?.proof.request_saved, true);
    assert.equal(result.staff_request_state?.proof.may_claim_notified, false);
    assert.match(result.final_patient_reply, /доставку.*не підтверджено/);
    assert.deepEqual(h.events, ["save", "notify", "audit"]);
  });
}

test("failed persistence prevents notification and replaces a false success claim", async () => {
  const h = setup({ failSave: true });
  const result = await withStaffRequestHandling(h.deps).runtimeTurnService.runTurn(input);
  assert.deepEqual(h.events, ["save"]);
  assert.equal(result.staff_request_state?.proof.request_saved, false);
  assert.match(result.final_patient_reply, /Не вдалося зберегти/);
});

test("duplicate persisted request does not send again, including a crash with pending delivery", async () => {
  const h = setup({ duplicate: true });
  const result = await withStaffRequestHandling(h.deps).runtimeTurnService.runTurn(input);
  assert.deepEqual(h.events, ["save"]);
  assert.equal(result.staff_request_state?.proof.delivery_status, "pending");
  assert.equal(result.staff_request_state?.proof.may_claim_notified, false);
});

test("notification exception is recorded; failed delivery audit does not erase actual delivery proof", async () => {
  const failed = setup({ throwNotify: true });
  const failure = await withStaffRequestHandling(failed.deps).runtimeTurnService.runTurn(input);
  assert.equal(failure.staff_request_state?.proof.delivery_status, "failed");
  assert.deepEqual(failed.events, ["save", "notify", "audit"]);
  const sent = setup({ failAudit: true });
  const result = await withStaffRequestHandling(sent.deps).runtimeTurnService.runTurn(input);
  assert.equal(result.staff_request_state?.proof.delivery_recorded, false);
  assert.equal(result.staff_request_state?.proof.may_claim_notified, true);
});

test("no canonical contact, repository or trace means no side effect", async () => {
  for (const field of ["contact_id", "trace_id"] as const) {
    const h = setup();
    const result = await withStaffRequestHandling(h.deps).runtimeTurnService.runTurn({ ...input, [field]: undefined });
    assert.deepEqual(h.events, []);
    assert.equal(result.staff_request_state?.proof.request_saved, false);
  }
  const h = setup();
  delete h.deps.staffRequestRepository;
  const result = await withStaffRequestHandling(h.deps).runtimeTurnService.runTurn(input);
  assert.equal(result.staff_request_state?.proof.request_saved, false);
  assert.deepEqual(h.events, []);
});

test("proposal validation rejects unsupported actions and strips model-supplied success/identity authority", () => {
  assert.equal(parseStaffRequest({ ...request, kind: "send_medical_records" }), null);
  assert.equal(parseStaffRequest({ ...request, patient_target: "everyone" }), null);
  assert.equal(parseStaffRequest({ ...request, person_ref: "" }), null);
  assert.equal(parseStaffRequest({ ...request, summary: "x".repeat(1001) }), null);
  assert.deepEqual(parseStaffRequest({ ...request, contact_id: "someone-else", delivery_status: "sent", doctor_reviewed: true }), request);
});

test("staff proposal survives real caller/service normalization with qualification, without JSON leaking", async () => {
  const envelope = { reply: "Дякую за оновлення.", staff_request: request, qualification: { reported_facts: ["болить зуб"] } };
  const service = createDentalRuntimeTurnService({
    openaiClient: { responses: { async create() { return { output_text: JSON.stringify(envelope) }; } } },
    model: "test", rpc: async () => ({ data: null, error: null }),
    embeddingClient: { async createEmbedding() { return []; } }, embeddingModel: "test",
  });
  const result = await service.runTurn(input);
  assert.deepEqual(result.staff_request, request);
  assert.deepEqual(result.qualification?.reported_facts, ["болить зуб"]);
  assert.equal(result.final_patient_reply, envelope.reply);
  const malformed = normalizeOpenAIResponse({ output_text: JSON.stringify({ staff_request: request }) });
  assert.equal(malformed.type, "final_response");
  if (malformed.type === "final_response") assert.deepEqual(malformed.final_response.staff_request, request);
});

test("S40: shared orchestration saves request, audits result and persists the actual receipt for later turns", async () => {
  const h = setup();
  h.deps.runtimeTurnService = { async runTurn() { return {
    final_patient_reply: "Ви повторюєтеся.", tool_requests: [], tool_results: [],
    staff_request: { ...request, kind: "document_update", summary: "Пацієнт повідомив: знімок зроблено і відправлено лікарю.", preferred_contact_window: null },
  }; } };
  let savedReply = "";
  let collected: Record<string, unknown> = {};
  h.deps.clinicIdentityResolver = { async resolveClinicIdentity() { return { ok: true, data: { clinic_id: CLINIC, clinic_code: "clinic-test" } }; } };
  h.deps.turnPersistenceRepository = {
    async getOrCreateContact() { return { ok: true, data: { contact_id: CONTACT, clinic_id: CLINIC } }; },
    async registerInboundEvent() { return { ok: true, data: { inbound_event_id: "event-1", accepted: true, is_duplicate: false } }; },
    async saveMessage(message) { if (message.role === "assistant") savedReply = message.text; return { ok: true, data: { message_id: "message-1" } }; },
    async mergeConversationState(state) { collected = state.control_flags.collected as Record<string, unknown>; return { ok: true, data: { ok: true } }; },
  };
  const output = await runRuntimeTurnOrchestrated({ clinic_code: "clinic-test", channel: "telegram", external_user_id: "test-doc", text: "Знімок зробила, відправили лікарю", meta: { message_id: "test-doc-1" } }, h.deps);
  assert.equal(output.outcome, "success");
  if (output.outcome !== "success") return;
  assert.equal(savedReply, output.payload.final_patient_reply);
  assert.match(savedReply, /Отримання та перегляд лікарем ще не підтверджено/);
  assert.doesNotMatch(savedReply, /повторюєтеся|запис/);
  assert.equal(output.payload.side_effects.length, 2);
  const visible = buildModelVisibleRuntimeContext({ conversation_state: { collected } });
  assert.equal((visible.staff_request_context as StaffRequest).kind, "document_update");
  assert.deepEqual(h.events, ["save", "notify", "audit"]);
});

test("ordinary replies and legacy mode do not create requests", async () => {
  const h = setup();
  h.deps.runtimeTurnService = { async runTurn() { return { final_patient_reply: "Будь ласка!", tool_requests: [], tool_results: [] }; } };
  await withStaffRequestHandling(h.deps).runtimeTurnService.runTurn(input);
  assert.deepEqual(h.events, []);
  process.env.RUNTIME_AGENT_MODE = "legacy";
  try {
    const legacy = setup();
    await withStaffRequestHandling(legacy.deps).runtimeTurnService.runTurn(input);
    assert.deepEqual(legacy.events, []);
  } finally { process.env.RUNTIME_AGENT_MODE = "agent_first"; }
});

test("a staff request preserves a separately supplied answer to another question", async () => {
  const h = setup();
  h.deps.runtimeTurnService = { async runTurn() { return {
    final_patient_reply: "Передам.", tool_requests: [], tool_results: [],
    staff_request: { ...request, additional_reply: "Адреса з тестової бази клініки: Testova 20, Prague." },
  }; } };
  const result = await withStaffRequestHandling(h.deps).runtimeTurnService.runTurn(input);
  assert.match(result.final_patient_reply, /зворотний дзвінок передано/);
  assert.match(result.final_patient_reply, /Testova 20, Prague/);
});

test("repository requires explicit durable task proof and scopes delivery writes by clinic/contact/request", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const rpc: RpcCaller = async <T>(name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    return { data: (name === "rpc_create_staff_request" ? [{ request_id: "request-1", created: true, delivery_status: "pending" }] : [{ ok: true }]) as T, error: null };
  };
  const repo = createSupabaseStaffRequestRepository({ rpc });
  const created = await repo.create({ ...input, request, source_message: input.user_message });
  assert.equal(created.ok, true);
  const delivery: AdminNotificationResult = { type: "admin_notification", status: "sent", channel: "telegram", reason: "callback", trace_id: input.trace_id };
  await repo.recordDelivery({ clinic_id: CLINIC, contact_id: CONTACT, request_id: "request-1", delivery });
  assert.equal(calls[1].args.p_contact_id, CONTACT);
  assert.equal(calls[1].args.p_clinic_id, CLINIC);
  assert.equal(calls[1].args.p_request_id, "request-1");
  const bad = createSupabaseStaffRequestRepository({ rpc: async () => ({ data: null, error: null }) });
  assert.equal((await bad.create({ ...input, request, source_message: input.user_message })).ok, false);
});

test("staff notification includes the whole request and distinguishes its callback window", async () => {
  const h = setup();
  await withStaffRequestHandling(h.deps).runtimeTurnService.runTurn(input);
  let body = "";
  const notifier = createAdminNotifier({
    config: { mode: "telegram", telegram_chat_id: "test-admin", telegram_thread_id: null }, botToken: "test-token",
    fetch: async (_url, init) => { body = String(init?.body); return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 }); },
  });
  await notifier.notify(h.notified()!);
  const sent = JSON.parse(body).text as string;
  assert.match(sent, /Staff request \(callback\)/);
  assert.match(sent, /Preferred CALLBACK window \(not an appointment\): завтра 10–11/);
  assert.ok(sent.includes(request.summary));
});
