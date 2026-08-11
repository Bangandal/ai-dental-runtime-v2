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

export function readWhatsAppConfig(env: NodeJS.ProcessEnv = process.env): WhatsAppBootstrapConfig | undefined {
  const accessToken = env.WHATSAPP_ACCESS_TOKEN?.trim();
  if (!accessToken) return undefined;

  const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID?.trim() ?? "";
  const verifyToken = env.WHATSAPP_VERIFY_TOKEN?.trim() ?? "";
  const graphApiVersion = env.WHATSAPP_GRAPH_API_VERSION?.trim() ?? "v19.0";
  const clinicId = env.WHATSAPP_CLINIC_ID?.trim() ?? "";
  const appSecret = env.WHATSAPP_APP_SECRET?.trim() || null;

  return { accessToken, phoneNumberId, verifyToken, appSecret, graphApiVersion, clinicId };
}
