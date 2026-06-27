import { timingSafeEqual } from "node:crypto";

export function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(\S+)$/i);
  return match ? (match[1] ?? null) : null;
}

export type ApiKeyCheckResult =
  | { ok: true }
  | { ok: false; code: "unconfigured" | "unauthorized" };

export function checkRuntimeApiKey(opts: {
  configuredKey: string | undefined;
  authHeader: string | undefined;
  apiKeyHeader: string | undefined;
  isProduction: boolean;
}): ApiKeyCheckResult {
  const { configuredKey, authHeader, apiKeyHeader, isProduction } = opts;

  if (!configuredKey) {
    // In production, missing RUNTIME_API_KEY is a misconfiguration — fail closed.
    if (isProduction) return { ok: false, code: "unconfigured" };
    // In non-production, allow without key for local development convenience.
    return { ok: true };
  }

  const requestKey = extractBearerToken(authHeader) ?? apiKeyHeader ?? null;
  if (!requestKey) return { ok: false, code: "unauthorized" };

  // Constant-time comparison to prevent timing attacks.
  try {
    const a = Buffer.from(configuredKey, "utf8");
    const b = Buffer.from(requestKey, "utf8");
    if (a.length !== b.length) return { ok: false, code: "unauthorized" };
    if (!timingSafeEqual(a, b)) return { ok: false, code: "unauthorized" };
  } catch {
    return { ok: false, code: "unauthorized" };
  }

  return { ok: true };
}
