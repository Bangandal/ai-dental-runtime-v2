export interface MetaMessengerConfig {
  pageAccessToken: string;
  pageId: string;
  verifyToken: string;
  appSecret: string | null;
  graphApiVersion: string;
  clinicCode: string;
}

export type MetaMessengerConfigReadResult =
  | { ok: true; config: MetaMessengerConfig }
  | { ok: false; reason: "disabled" }
  | { ok: false; reason: "partial_config"; missing: string[] };

export function readMetaMessengerConfig(
  env: NodeJS.ProcessEnv = process.env,
  isProduction = false,
): MetaMessengerConfig | undefined {
  const result = readMetaMessengerConfigResult(env, isProduction);
  if (result.ok) return result.config;
  if (result.reason === "disabled") return undefined;
  throw new Error(
    `Meta Messenger transport partially configured. Missing required variables: ${result.missing.join(", ")}`,
  );
}

export function readMetaMessengerConfigResult(
  env: NodeJS.ProcessEnv = process.env,
  isProduction = false,
): MetaMessengerConfigReadResult {
  const pageAccessToken = env.META_MESSENGER_PAGE_ACCESS_TOKEN?.trim() || "";

  // Graph version and default clinic code may be pre-filled operational defaults.
  // They do not enable the transport by themselves.
  const transportIntent = [
    pageAccessToken,
    env.META_MESSENGER_PAGE_ID,
    env.META_WEBHOOK_VERIFY_TOKEN,
    env.META_APP_SECRET,
  ].some((value) => value?.trim());

  if (!transportIntent) {
    return { ok: false, reason: "disabled" };
  }

  const pageId = env.META_MESSENGER_PAGE_ID?.trim() || "";
  const verifyToken = env.META_WEBHOOK_VERIFY_TOKEN?.trim() || "";
  const graphApiVersion = env.META_GRAPH_API_VERSION?.trim() || "";
  const clinicCode = env.META_DEFAULT_CLINIC_CODE?.trim() || "";
  const appSecret = env.META_APP_SECRET?.trim() || null;

  const missing: string[] = [];
  if (!pageAccessToken) missing.push("META_MESSENGER_PAGE_ACCESS_TOKEN");
  if (!pageId) missing.push("META_MESSENGER_PAGE_ID");
  if (!verifyToken) missing.push("META_WEBHOOK_VERIFY_TOKEN");
  if (!graphApiVersion) missing.push("META_GRAPH_API_VERSION");
  if (!clinicCode) missing.push("META_DEFAULT_CLINIC_CODE");
  if (isProduction && !appSecret) missing.push("META_APP_SECRET");

  if (missing.length > 0) {
    return { ok: false, reason: "partial_config", missing };
  }

  return {
    ok: true,
    config: {
      pageAccessToken,
      pageId,
      verifyToken,
      appSecret,
      graphApiVersion,
      clinicCode,
    },
  };
}
