export type AdminNotifyMode = "telegram" | "disabled";

export interface AdminNotifyConfig {
  mode: AdminNotifyMode;
  telegram_chat_id: string | null;
  telegram_thread_id: string | null;
}

const VALID_MODES: ReadonlySet<string> = new Set(["telegram", "disabled"]);

/** Reads ADMIN_NOTIFY_MODE / ADMIN_TELEGRAM_CHAT_ID / ADMIN_TELEGRAM_THREAD_ID. Never throws — falls back to disabled. */
export function loadAdminNotifyConfig(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): AdminNotifyConfig {
  const modeRaw = env["ADMIN_NOTIFY_MODE"]?.trim() ?? "disabled";
  const mode = VALID_MODES.has(modeRaw) ? (modeRaw as AdminNotifyMode) : "disabled";
  const telegramChatId = env["ADMIN_TELEGRAM_CHAT_ID"]?.trim() || null;

  if (mode === "telegram" && !telegramChatId) {
    return { mode: "disabled", telegram_chat_id: null, telegram_thread_id: null };
  }

  return {
    mode,
    telegram_chat_id: telegramChatId,
    telegram_thread_id: env["ADMIN_TELEGRAM_THREAD_ID"]?.trim() || null,
  };
}
