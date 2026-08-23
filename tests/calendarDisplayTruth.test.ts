import assert from "node:assert/strict";
import test from "node:test";

import { buildCalendarDisplayTruth, getCalendarWeekdayCode } from "../src/runtime/calendarDisplayTruth.ts";
import { buildAvailabilityPresentationTruth } from "../src/runtime/availabilityPresentationTruth.ts";
import type { AuthoritativeAvailabilityAttempt } from "../src/runtime/availabilityActionTruth.ts";
import type { RuntimeAgentToolRequest, RuntimeAgentToolResult } from "../src/runtime/openaiRuntimeAgent.ts";
import { buildAppointmentDisplayTruth } from "../src/runtime/appointmentDisplayTruth.ts";

test("B-07: 2026-08-25 is canonical Tuesday in every model-visible calendar surface", () => {
  const truth = buildCalendarDisplayTruth("2026-08-25");
  assert.ok(truth);
  assert.equal(truth.weekday_code, "tuesday");
  assert.equal(truth.weekday.ru, "вторник");
  assert.equal(truth.weekday.uk, "вівторок");
  assert.equal(truth.weekday.cs, "úterý");
  assert.equal(truth.weekday.en, "Tuesday");
  assert.match(truth.date_display.ru, /25/);
  assert.match(truth.date_display.en, /August/);
});

test("B-07: impossible calendar dates fail closed instead of overflowing into another month", () => {
  assert.equal(getCalendarWeekdayCode("2026-02-31"), null);
  assert.equal(buildCalendarDisplayTruth("2026-02-31"), null);
  assert.equal(buildCalendarDisplayTruth("2026-13-01"), null);
  assert.equal(buildCalendarDisplayTruth("25.08.2026"), null);
});

test("B-07: availability presentation carries Runtime-localized weekday/date truth", () => {
  const request: RuntimeAgentToolRequest = {
    tool: "availability.check",
    call_id: "avail-b07",
    arguments: { requested_date: "2026-08-25" },
  };
  const result: RuntimeAgentToolResult = {
    tool: "availability.check",
    call_id: "avail-b07",
    status: "success",
    data: {
      timezone: "Europe/Prague",
      slots: [
        {
          starts_at: "2026-08-25T12:00:00",
          ends_at: "2026-08-25T12:30:00",
        },
      ],
    },
  };
  const attempt: AuthoritativeAvailabilityAttempt = {
    attempted: true,
    request,
    pair: { request, result },
  };

  const truth = buildAvailabilityPresentationTruth(attempt);
  assert.ok(truth);
  assert.equal(truth.resolved_date, "2026-08-25");
  assert.equal(truth.resolved_weekday, "tuesday");
  assert.equal(truth.resolved_calendar.weekday.ru, "вторник");
  assert.equal(truth.resolved_calendar.weekday.en, "Tuesday");
  assert.match(truth.resolved_calendar.date_display.ru, /25/);
  assert.deepEqual(truth.allowed_slot_starts, ["12:00"]);
});

test("B-07: appointment display reuses the same canonical calendar truth", () => {
  const result: RuntimeAgentToolResult = {
    tool: "booking.apply",
    call_id: "book-b07",
    status: "success",
    data: {
      booking_status: "visit_created",
      created_visit: true,
      may_claim_booked: true,
      cliniccard_visit_id: "visit-b07",
      cliniccard_patient_id: "patient-b07",
      date: "2026-08-25",
      time_start: "12:00",
      time_end: "12:30",
    },
  };

  const truth = buildAppointmentDisplayTruth([result]);
  assert.ok(truth);
  assert.equal(truth.weekday.ru, "вторник");
  assert.equal(truth.weekday.en, "Tuesday");
});

test("B-07: appointment display fails closed for impossible dates", () => {
  const result: RuntimeAgentToolResult = {
    tool: "booking.apply",
    call_id: "book-b07-invalid",
    status: "success",
    data: {
      booking_status: "visit_created",
      created_visit: true,
      may_claim_booked: true,
      cliniccard_visit_id: "visit-b07-invalid",
      cliniccard_patient_id: "patient-b07-invalid",
      date: "2026-02-31",
      time_start: "12:00",
    },
  };

  assert.equal(buildAppointmentDisplayTruth([result]), null);
});
