import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { checkRuntimeApiKey } from "./runtimeApiAuth.ts";
import type {
  StaffInboxRepository,
  StaffRequestWorkflowStatus,
} from "./staffInboxRepository.ts";

export interface StaffInboxRouteDeps {
  repository: StaffInboxRepository;
  apiKey?: string;
  isProduction?: boolean;
}

function header(req: FastifyRequest, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function authorize(req: FastifyRequest, deps: StaffInboxRouteDeps): "ok" | "unauthorized" | "unconfigured" {
  const result = checkRuntimeApiKey({
    configuredKey: deps.apiKey,
    authHeader: header(req, "authorization"),
    apiKeyHeader: header(req, "x-runtime-api-key"),
    isProduction: deps.isProduction ?? false,
  });
  return result.ok ? "ok" : result.code;
}

function queryRecord(req: FastifyRequest): Record<string, unknown> {
  return req.query !== null && typeof req.query === "object" && !Array.isArray(req.query)
    ? req.query as Record<string, unknown>
    : {};
}

function queryValue(req: FastifyRequest, name: string): string | null {
  const value = queryRecord(req)[name];
  if (Array.isArray(value)) {
    const first = value[0];
    return typeof first === "string" && first.trim() ? first.trim() : null;
  }
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function bodyRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function paramsRecord(req: FastifyRequest): Record<string, unknown> {
  return req.params !== null && typeof req.params === "object" && !Array.isArray(req.params)
    ? req.params as Record<string, unknown>
    : {};
}

function validStatus(value: string | null): value is StaffRequestWorkflowStatus | "all" {
  return value === "open" || value === "acknowledged" || value === "resolved" || value === "all";
}

function rejectAuth(reply: FastifyReply, status: "unauthorized" | "unconfigured"): void {
  reply.code(status === "unconfigured" ? 503 : 401).send({ error: { code: `staff_api_${status}` } });
}

export function registerStaffInboxRoutes(app: FastifyInstance, deps: StaffInboxRouteDeps): void {
  app.get("/staff/requests", async (req, reply) => {
    const auth = authorize(req, deps);
    if (auth !== "ok") return rejectAuth(reply, auth);
    const clinicId = queryValue(req, "clinic_id");
    const statusRaw = queryValue(req, "status") ?? "open";
    const limitRaw = queryValue(req, "limit");
    if (!clinicId || !validStatus(statusRaw)) {
      reply.code(400).send({ error: { code: "invalid_staff_inbox_query" } });
      return;
    }
    const limit = limitRaw ? Number(limitRaw) : 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      reply.code(400).send({ error: { code: "invalid_staff_inbox_limit" } });
      return;
    }
    const result = await deps.repository.list({ clinic_id: clinicId, status: statusRaw, limit });
    if (!result.ok) {
      reply.code(503).send({ error: { code: result.error.code } });
      return;
    }
    reply.code(200).send({ items: result.data });
  });

  app.post("/staff/requests/:request_id/status", async (req, reply) => {
    const auth = authorize(req, deps);
    if (auth !== "ok") return rejectAuth(reply, auth);
    const rawRequestId = paramsRecord(req).request_id;
    const requestId = typeof rawRequestId === "string" ? rawRequestId.trim() : "";
    const body = bodyRecord(req.body);
    const clinicId = typeof body?.clinic_id === "string" ? body.clinic_id.trim() : "";
    const status = typeof body?.status === "string" ? body.status.trim() : "";
    const note = body?.resolution_note == null
      ? null
      : typeof body.resolution_note === "string" ? body.resolution_note.trim() : null;
    if (!requestId || !clinicId || !validStatus(status) || status === "all"
      || (body?.resolution_note != null && note == null)) {
      reply.code(400).send({ error: { code: "invalid_staff_status_update" } });
      return;
    }
    const result = await deps.repository.setStatus({
      clinic_id: clinicId,
      request_id: requestId,
      status,
      resolution_note: note,
    });
    if (!result.ok) {
      reply.code(503).send({ error: { code: result.error.code } });
      return;
    }
    reply.code(200).send({ item: result.data });
  });

  app.get("/staff/metrics", async (req, reply) => {
    const auth = authorize(req, deps);
    if (auth !== "ok") return rejectAuth(reply, auth);
    const result = await deps.repository.metrics({ clinic_id: queryValue(req, "clinic_id") });
    if (!result.ok) {
      reply.code(503).send({ error: { code: result.error.code } });
      return;
    }
    reply.code(200).send(result.data);
  });
}
