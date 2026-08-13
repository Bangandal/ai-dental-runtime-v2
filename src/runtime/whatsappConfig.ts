export interface WhatsAppConfig {
  accessToken: string;
  phoneNumberId: string;
  verifyToken: string;
  appSecret: string | null;
  graphApiVersion: string;
  clinicId: string;
}

export interface WhatsAppBootstrapConfig {
  accessToken: string;
  phoneNumberId: string;
  verifyToken: string;
  appSecret: string | null;
  graphApiVersion: string;
  clinicId: string;
}

export type WhatsAppConfigResult =
  | { ok: true; config: WhatsAppConfig }
  | { ok: false; missing: string[] };

export function loadWhatsAppConfig(env: NodeJS.ProcessEnv = process.env): WhatsAppConfigResult {
  const missing: string[] = [];

  const accessToken = env.WHATSAPP_ACCESS_TOKEN?.trim() ?? "";
  const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID?.trim() ?? "";
  const verifyToken = env.WHATSAPP_VERIFY_TOKEN?.trim() ?? "";
  const graphApiVersion = env.WHATSAPP_GRAPH_API_VERSION?.trim() ?? "";
  const clinicId = env.WHATSAPP_CLINIC_ID?.trim() ?? "";

  if (!accessToken) missing.push("WHATSAPP_ACCESS_TOKEN");
  if (!phoneNumberId) missing.push("WHATSAPP_PHONE_NUMBER_ID");
  if (!verifyToken) missing.push("WHATSAPP_VERIFY_TOKEN");
  if (!graphApiVersion) missing.push("WHATSAPP_GRAPH_API_VERSION");
  if (!clinicId) missing.push("WHATSAPP_CLINIC_ID");

  if (missing.length > 0) return { ok: false, missing };

  const appSecret = env.WHATSAPP_APP_SECRET?.trim() || null;

  return {
    ok: true,
    config: { accessToken, phoneNumberId, verifyToken, appSecret, graphApiVersion, clinicId },
  };
}

export type WhatsAppConfigReadResult =
  | { ok: true; config: WhatsAppBootstrapConfig }
  | { ok: false; reason: "disabled" }
  | { ok: false; reason: "partial_config"; missing: string[] };

export function readWhatsAppConfig(
  env: NodeJS.ProcessEnv = process.env,
  isProduction = false,
): WhatsAppBootstrapConfig | undefined {
  const result = readWhatsAppConfigResult(env, isProduction);
  if (result.ok) return result.config;
  if (result.reason === "disabled") return undefined;
  // partial_config — throw so startup fails deterministically
  const missing = result.missing.join(", ");
  throw new Error(`WhatsApp transport partially configured. Missing required variables: ${missing}`);
}

export function readWhatsAppConfigResult(
  env: NodeJS.ProcessEnv = process.env,
  isProduction = false,
): WhatsAppConfigReadResult {
  const accessToken = env.WHATSAPP_ACCESS_TOKEN?.trim() || "";

  // No WhatsApp env vars at all → transport disabled normally
  if (!accessToken) {
    const others = [
      env.WHATSAPP_PHONE_NUMBER_ID,
      env.WHATSAPP_VERIFY_TOKEN,
      env.WHATSAPP_GRAPH_API_VERSION,
      env.WHATSAPP_CLINIC_ID,
      env.WHATSAPP_APP_SECRET,
    ].some((v) => v?.trim());
    if (!others) return { ok: false, reason: "disabled" };
  }

  // Any WhatsApp var present — validate all required fields
  const missing: string[] = [];
  if (!accessToken) missing.push("WHATSAPP_ACCESS_TOKEN");

  const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID?.trim() || "";
  if (!phoneNumberId) missing.push("WHATSAPP_PHONE_NUMBER_ID");

  const verifyToken = env.WHATSAPP_VERIFY_TOKEN?.trim() || "";
  if (!verifyToken) missing.push("WHATSAPP_VERIFY_TOKEN");

  const graphApiVersion = env.WHATSAPP_GRAPH_API_VERSION?.trim() || "";
  if (!graphApiVersion) missing.push("WHATSAPP_GRAPH_API_VERSION");

  const clinicId = env.WHATSAPP_CLINIC_ID?.trim() || "";
  if (!clinicId) missing.push("WHATSAPP_CLINIC_ID");

  const appSecret = env.WHATSAPP_APP_SECRET?.trim() || null;
  if (isProduction && !appSecret) missing.push("WHATSAPP_APP_SECRET");

  if (missing.length > 0) return { ok: false, reason: "partial_config", missing };

  return {
    ok: true,
    config: { accessToken, phoneNumberId, verifyToken, appSecret, graphApiVersion, clinicId },
  };
}
