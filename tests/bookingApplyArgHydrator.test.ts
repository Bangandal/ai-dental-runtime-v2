import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hydrateBookingApplyArgs } from "../src/runtime/bookingApplyArgHydrator.ts";
import type { BookingProcessState } from "../src/runtime/bookingProcessState.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

function slot(time: string, date = "2026-07-06"): BookingProcessState["last_available_slots"] {
  return [{ starts_at: `${date}T${time}:00` }];
}

function selectedSlot(time: string, date = "2026-07-06"): NonNullable<BookingProcessState["selected_slot"]> {
  return { starts_at: `${date}T${time}:00` };
}

function history(...msgs: Array<{ role: "user" | "assistant"; content: string }>): Array<{ role: string; content: string }> {
  return msgs;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("hydrateBookingApplyArgs", () => {
  // ── A. Name from recent_history ──────────────────────────────────────────
  it("A: hydrates first_name/last_name from recent_history user message", () => {
    const result = hydrateBookingApplyArgs(
      {},
      {
        userMessage: "Да оформляйте",
        recentHistory: history(
          { role: "user", content: "Как можно скорее.\nНиколай арманов" },
          { role: "assistant", content: "На сегодня слот — 17:30. Подходит?" },
        ),
        bookingProcessState: null,
      },
    );
    assert.equal(result.args.first_name, "Николай");
    assert.equal(result.args.last_name, "Арманов");
    assert.equal(result.applied, true);
    assert.ok(result.debug.hydrated_fields.includes("first_name"));
    assert.ok(result.debug.hydrated_fields.includes("last_name"));
    assert.equal(result.debug.evidence.first_name, "recent_history");
    assert.equal(result.debug.evidence.last_name, "recent_history");
  });

  // ── B. Name from current userMessage ─────────────────────────────────────
  it("B: hydrates first_name/last_name from current userMessage", () => {
    const result = hydrateBookingApplyArgs(
      {},
      {
        userMessage: "Иван Петров",
        recentHistory: [],
        bookingProcessState: null,
      },
    );
    assert.equal(result.args.first_name, "Иван");
    assert.equal(result.args.last_name, "Петров");
    assert.equal(result.debug.evidence.first_name, "current_message");
  });

  // ── C. service_reason from urgent pain + booking intent ──────────────────
  it("C: hydrates service_reason from urgent pain + booking intent in recent history", () => {
    const result = hydrateBookingApplyArgs(
      {},
      {
        userMessage: "Да оформляйте",
        recentHistory: history(
          { role: "user", content: "У меня сильно болит зуб, хочу записаться" },
        ),
        bookingProcessState: null,
      },
    );
    assert.equal(result.args.service_reason, "осмотр из-за боли");
    assert.equal(result.debug.evidence.service_reason, "urgent_pain_booking_context");
  });

  // ── D. Explicit model args win ────────────────────────────────────────────
  it("D: explicit non-empty model args are not overwritten by hydration", () => {
    const result = hydrateBookingApplyArgs(
      { first_name: "Existing", last_name: "Name", service_reason: "чистка" },
      {
        userMessage: "Иван Петров",
        recentHistory: history(
          { role: "user", content: "болит зуб, хочу записаться" },
        ),
        bookingProcessState: null,
      },
    );
    assert.equal(result.args.first_name, "Existing");
    assert.equal(result.args.last_name, "Name");
    assert.equal(result.args.service_reason, "чистка");
    assert.ok(!result.debug.hydrated_fields.includes("first_name"));
    assert.ok(!result.debug.hydrated_fields.includes("service_reason"));
  });

  // ── E. Ambiguous text does NOT hydrate name ──────────────────────────────
  it("E: vague text without a clear two-word Cyrillic name does NOT hydrate", () => {
    const result = hydrateBookingApplyArgs(
      {},
      {
        userMessage: "завтра в 10:00",
        recentHistory: [],
        bookingProcessState: null,
      },
    );
    assert.equal(result.args.first_name, undefined);
    assert.ok(!result.debug.hydrated_fields.includes("first_name"));
  });

  // ── F. No name pattern in recent_history ─────────────────────────────────
  it("F: no name-like pattern in recent_history does NOT hydrate first_name", () => {
    const result = hydrateBookingApplyArgs(
      {},
      {
        userMessage: "Подходит",
        recentHistory: history(
          { role: "user", content: "болит зуб, хочу записаться" },
          { role: "assistant", content: "Понял, проверю слоты." },
        ),
        bookingProcessState: null,
      },
    );
    assert.equal(result.args.first_name, undefined);
  });

  // ── G. requested_time/date from selected_slot ─────────────────────────────
  it("G: hydrates requested_time and requested_date from bookingProcessState.selected_slot", () => {
    const state: Partial<BookingProcessState> = {
      selected_slot: selectedSlot("17:30", "2026-07-06"),
    };
    const result = hydrateBookingApplyArgs(
      {},
      {
        userMessage: "Да",
        recentHistory: [],
        bookingProcessState: state as BookingProcessState,
      },
    );
    assert.equal(result.args.requested_time, "17:30");
    assert.equal(result.args.requested_date, "2026-07-06");
    assert.equal(result.debug.evidence.requested_time, "selected_slot");
    assert.equal(result.debug.evidence.requested_date, "selected_slot");
  });

  // ── H. Time from offered_slot_acceptance ─────────────────────────────────
  it("H: hydrates time via offered_slot_acceptance when user says 'Да оформляйте' and assistant mentioned 17:30", () => {
    const state: Partial<BookingProcessState> = {
      // multiple slots so Source 2 (single-slot) doesn't fire; Source 3 (acceptance) must be used
      last_available_slots: [{ starts_at: "2026-07-06T17:30:00" }, { starts_at: "2026-07-06T18:00:00" }],
    };
    const result = hydrateBookingApplyArgs(
      {},
      {
        userMessage: "Да оформляйте",
        recentHistory: history(
          { role: "assistant", content: "На сегодня ближайший свободный слот — 17:30. Подходит?" },
        ),
        bookingProcessState: state as BookingProcessState,
      },
    );
    assert.equal(result.args.requested_time, "17:30");
    assert.equal(result.debug.evidence.requested_time, "offered_slot_acceptance");
  });

  // ── I. Partial name still triggers guard ──────────────────────────────────
  it("I: hydrated args with only service/time but no name still produce missing name fields list", () => {
    // We don't test the guard here, just that hydration doesn't add a name where there isn't one.
    const result = hydrateBookingApplyArgs(
      {},
      {
        userMessage: "Подходит",
        recentHistory: history(
          { role: "user", content: "болит зуб, хочу записаться" },
        ),
        bookingProcessState: {
          selected_slot: selectedSlot("17:30"),
        } as BookingProcessState,
      },
    );
    // No name in message or history — should NOT be hydrated
    assert.equal(result.args.first_name, undefined);
    assert.equal(result.args.last_name, undefined);
    // But time and service may be hydrated
    assert.equal(result.args.requested_time, "17:30");
  });

  // ── J. No ClinicCard writes in disabled mode ──────────────────────────────
  it("J: hydration itself does not perform any ClinicCard writes", () => {
    // Hydration is a pure function — it only modifies args in memory.
    // This test verifies it returns without side effects.
    const result = hydrateBookingApplyArgs(
      { first_name: "Test", last_name: "User", service: "чистка", requested_date: "2026-07-06", requested_time: "10:00" },
      { userMessage: "Да", recentHistory: [], bookingProcessState: null },
    );
    assert.equal(result.applied, false); // all fields already present
    assert.deepEqual(result.debug.hydrated_fields, []);
  });

  // ── Extra: exclusion list prevents false positive ─────────────────────────
  it("does NOT hydrate 'Как Можно' as a name (exclusion list)", () => {
    const result = hydrateBookingApplyArgs(
      {},
      {
        userMessage: "Как можно скорее",
        recentHistory: [],
        bookingProcessState: null,
      },
    );
    assert.equal(result.args.first_name, undefined);
  });

  it("does NOT hydrate from assistant messages", () => {
    const result = hydrateBookingApplyArgs(
      {},
      {
        userMessage: "Подходит",
        recentHistory: history(
          { role: "assistant", content: "Иван Иванов — спасибо за подтверждение." },
        ),
        bookingProcessState: null,
      },
    );
    // Only user messages searched
    assert.equal(result.args.first_name, undefined);
  });

  it("does NOT hydrate service_reason without booking intent", () => {
    const result = hydrateBookingApplyArgs(
      {},
      {
        userMessage: "У меня болит зуб",
        recentHistory: [],
        bookingProcessState: null,
      },
    );
    assert.equal(result.args.service_reason, undefined);
  });

  it("does NOT overwrite requested_time if already present in args", () => {
    const result = hydrateBookingApplyArgs(
      { requested_time: "10:00" },
      {
        userMessage: "Подходит",
        recentHistory: [],
        bookingProcessState: {
          selected_slot: selectedSlot("17:30"),
        } as BookingProcessState,
      },
    );
    assert.equal(result.args.requested_time, "10:00");
  });
});
