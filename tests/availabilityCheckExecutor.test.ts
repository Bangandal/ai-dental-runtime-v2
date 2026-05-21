import assert from "node:assert/strict";
import test from "node:test";

import { createAvailabilityCheckExecutor } from "../src/runtime/availabilityCheckExecutor.ts";
import type { RuntimeResult } from "../src/runtime/runtimeRepositories.ts";
import type { ToolExecutionContext } from "../src/runtime/toolExecutor.ts";

const BASE_CONTEXT: ToolExecutionContext = {
  clinic_id: "clinic_1",
  requested_date: "2026-06-01",
  requested_time: "09:00",
  service_interest: "cleaning",
  timezone: "America/New_York",
  limit: 3,
};

test("availability executor fails if clinic_id missing and does not call repository", async () => {
  let repositoryCalled = false;
  const executor = createAvailabilityCheckExecutor({
    bookingRepository: {
      async checkAvailability() {
        repositoryCalled = true;
        return {
          ok: true,
          data: { slots: [] },
        };
      },
    },
  });

  const result = await executor({ ...BASE_CONTEXT, clinic_id: undefined });

  assert.equal(repositoryCalled, false);
  assert.equal(result.tool, "availability.check");
  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "availability_missing_clinic_id");
  assert.equal(result.error.retryable, false);
});

test("availability executor fails if requested_date missing and does not call repository", async () => {
  let repositoryCalled = false;
  const executor = createAvailabilityCheckExecutor({
    bookingRepository: {
      async checkAvailability() {
        repositoryCalled = true;
        return {
          ok: true,
          data: { slots: [] },
        };
      },
    },
  });

  const result = await executor({ ...BASE_CONTEXT, requested_date: undefined });

  assert.equal(repositoryCalled, false);
  assert.equal(result.tool, "availability.check");
  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "availability_missing_requested_date");
  assert.equal(result.error.retryable, false);
});

test("availability executor calls bookingRepository.checkAvailability with mapped context fields", async () => {
  let receivedInput: unknown;
  const executor = createAvailabilityCheckExecutor({
    bookingRepository: {
      async checkAvailability(input) {
        receivedInput = input;
        return {
          ok: true,
          data: { slots: [] },
        };
      },
    },
  });

  await executor(BASE_CONTEXT);

  assert.deepEqual(receivedInput, {
    clinic_id: "clinic_1",
    requested_date: "2026-06-01",
    requested_time: "09:00",
    service_interest: "cleaning",
    timezone: "America/New_York",
    limit: 3,
  });
});

test("availability executor returns success with normalized slots", async () => {
  const executor = createAvailabilityCheckExecutor({
    bookingRepository: {
      async checkAvailability(): Promise<RuntimeResult<{ slots: Array<{ slot_id: string; starts_at: string; ends_at: string }>; timezone?: string | null }>> {
        return {
          ok: true,
          data: {
            slots: [
              {
                slot_id: "slot_1",
                starts_at: "2026-06-01T13:00:00.000Z",
                ends_at: "2026-06-01T13:30:00.000Z",
              },
            ],
            timezone: "America/New_York",
          },
        };
      },
    },
  });

  const result = await executor(BASE_CONTEXT);

  assert.equal(result.tool, "availability.check");
  assert.equal(result.status, "success");
  assert.deepEqual(result.data, {
    slots: [
      {
        slot_id: "slot_1",
        starts_at: "2026-06-01T13:00:00.000Z",
        ends_at: "2026-06-01T13:30:00.000Z",
      },
    ],
    timezone: "America/New_York",
  });
});

test("availability executor returns failed result when repository fails", async () => {
  const executor = createAvailabilityCheckExecutor({
    bookingRepository: {
      async checkAvailability() {
        return {
          ok: false,
          error: {
            code: "availability_backend_unavailable",
            message: "backend unavailable",
            retryable: true,
          },
        };
      },
    },
  });

  const result = await executor(BASE_CONTEXT);

  assert.equal(result.tool, "availability.check");
  assert.equal(result.status, "failed");
  assert.deepEqual(result.error, {
    code: "availability_backend_unavailable",
    message: "backend unavailable",
    retryable: true,
  });
});

test("availability executor module does not import forbidden integrations or write paths", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/runtime/availabilityCheckExecutor.ts", import.meta.url), "utf8");

  assert.doesNotMatch(source, /supabase|openai|calendar|n8n|telegram/i);
  assert.doesNotMatch(source, /rpc_apply_booking_decision_v1/);
  assert.doesNotMatch(source, /createHold|confirmBooking|cancelHold|admin\.notify/);
});
