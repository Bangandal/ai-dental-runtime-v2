import type { AdminNotifier, AdminNotificationResult } from "../integrations/adminNotify/adminNotifyTypes.ts";
import {
  buildStaffNotificationPayload,
  type StaffNotificationOutboxRepository,
} from "./supabaseStaffNotificationOutboxRepository.ts";

export interface StaffNotificationOutboxWorkerRunResult {
  claimed: number;
  sent: number;
  retried: number;
  terminal: number;
  persistence_failures: number;
}

export interface StaffNotificationOutboxWorker {
  runOnce(): Promise<StaffNotificationOutboxWorkerRunResult>;
}

export interface StaffNotificationOutboxWorkerDeps {
  repository: StaffNotificationOutboxRepository;
  notifier: AdminNotifier;
  batchSize?: number;
  maxAttempts?: number;
  onEvent?: (event: Record<string, unknown>) => void;
}

const BACKOFF_SECONDS = [15, 60, 300, 900, 3600, 6 * 3600];

function retryDelaySeconds(attemptCount: number): number {
  return BACKOFF_SECONDS[Math.min(Math.max(attemptCount - 1, 0), BACKOFF_SECONDS.length - 1)]!;
}

function failureResult(reason: string, traceId: string, errorCode: string): AdminNotificationResult {
  return {
    type: "admin_notification",
    status: "failed",
    channel: "telegram",
    reason,
    trace_id: traceId,
    error_code: errorCode,
  };
}

export function createStaffNotificationOutboxWorker(
  deps: StaffNotificationOutboxWorkerDeps,
): StaffNotificationOutboxWorker {
  const batchSize = Math.max(1, Math.min(50, Math.trunc(deps.batchSize ?? 10)));
  const maxAttempts = Math.max(1, Math.min(20, Math.trunc(deps.maxAttempts ?? 8)));

  return {
    async runOnce() {
      const stats: StaffNotificationOutboxWorkerRunResult = {
        claimed: 0,
        sent: 0,
        retried: 0,
        terminal: 0,
        persistence_failures: 0,
      };
      const claimed = await deps.repository.claim({ limit: batchSize });
      if (!claimed.ok) {
        deps.onEvent?.({
          event: "staff_notification_outbox_claim_failed",
          error_code: claimed.error.code,
        });
        stats.persistence_failures += 1;
        return stats;
      }

      stats.claimed = claimed.data.length;
      for (const item of claimed.data) {
        const payload = buildStaffNotificationPayload(item);
        let delivery: AdminNotificationResult;
        try {
          delivery = await deps.notifier.notify(payload);
        } catch (error) {
          delivery = failureResult(
            payload.reason,
            payload.trace_id,
            error instanceof Error ? error.name : "staff_notification_exception",
          );
        }

        const providerTerminal = delivery.status === "sent"
          || delivery.status === "disabled"
          || delivery.status === "not_configured";
        const attemptsExhausted = item.attempt_count >= maxAttempts;
        const terminal = providerTerminal || attemptsExhausted;
        const retryAfter = terminal ? null : retryDelaySeconds(item.attempt_count);

        const completed = await deps.repository.complete({
          outbox_id: item.outbox_id,
          request_id: item.request_id,
          delivery,
          retry_after_seconds: retryAfter,
          terminal,
        });
        if (!completed.ok) {
          stats.persistence_failures += 1;
          deps.onEvent?.({
            event: "staff_notification_outbox_complete_failed",
            outbox_id: item.outbox_id,
            request_id: item.request_id,
            attempt_count: item.attempt_count,
            error_code: completed.error.code,
          });
          continue;
        }

        if (delivery.status === "sent") stats.sent += 1;
        else if (terminal) stats.terminal += 1;
        else stats.retried += 1;

        deps.onEvent?.({
          event: "staff_notification_outbox_processed",
          outbox_id: item.outbox_id,
          request_id: item.request_id,
          attempt_count: item.attempt_count,
          delivery_status: delivery.status,
          terminal,
          retry_after_seconds: retryAfter,
        });
      }
      return stats;
    },
  };
}
