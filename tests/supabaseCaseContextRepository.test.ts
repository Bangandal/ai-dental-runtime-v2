import assert from "node:assert/strict";
import test from "node:test";

import { createSupabaseCaseContextRepository } from "../src/runtime/supabaseCaseContextRepository.ts";

test("loads and normalizes case + booking context", async () => {
  const repo = createSupabaseCaseContextRepository({
    rpc: async (name) => {
      if (name === "rpc_get_contact_case_context_v1") {
        return {
          data: [{
            current_case_id: "case_1",
            open_cases: [{ case_id: "case_1", case_type: "booking", topic: "crown", status: "open", priority: "high" }],
            recent_cases: [{ case_id: "case_9", case_type: "faq", topic: "insurance", status: "closed", priority: null }],
          }],
          error: null,
        };
      }
      return {
        data: [{
          active_hold: { service_interest: "cleaning", label: "Mon", status: "active" },
          latest_appointment: { service_interest: "exam", status: "booked", start_at: "2026-06-01T09:00:00Z" },
        }],
        error: null,
      };
    },
  });

  const result = await repo.loadCaseContext({ clinic_id: "clinic_1", contact_id: "contact_1" });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.current_case_id, "case_1");
  assert.equal(result.data.open_cases.length, 1);
  assert.equal(result.data.open_cases[0]?.case_id, "case_1");
  assert.equal(result.data.active_booking_context.active_hold?.status, "active");
});

test("case context rpc failure returns RuntimeResult error", async () => {
  const repo = createSupabaseCaseContextRepository({
    rpc: async () => ({ data: null, error: { message: "boom" } }),
  });

  const result = await repo.loadCaseContext({ clinic_id: "clinic_1", contact_id: "contact_1" });
  assert.equal(result.ok, false);
});
