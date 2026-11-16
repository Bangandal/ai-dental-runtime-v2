import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseSchedule,
  getWeekdayKeyInTimezone,
  isCheckupService,
  buildScheduleSummary,
  evaluateScheduleRequest,
  type ClinicSchedule,
} from "../src/runtime/schedulePolicy.ts";

const RAW = {
  timezone: "Europe/Prague",
  slot_minutes: 30,
  days: {
    mon: { open: "07:00", close: "17:00", lunch: ["12:00", "13:00"], services: "all" },
    tue: { open: "07:00", close: "17:00", lunch: ["12:00", "13:00"], services: "all" },
    wed: { open: "07:00", close: "17:00", lunch: ["12:00", "13:00"], services: "all" },
    thu: { open: "07:00", close: "17:00", lunch: ["12:00", "13:00"], services: "all" },
    fri: { open: "07:00", close: "09:45", services: "checkups_only" },
    sat: { closed: true },
    sun: { closed: true },
  },
};
const SCH = parseSchedule(RAW) as ClinicSchedule;

// Known weekdays (Europe/Prague): 2026-11-16 = Mon ... 2026-11-22 = Sun
const MON = "2026-11-16", THU = "2026-11-19", FRI = "2026-11-20", SAT = "2026-11-21", SUN = "2026-11-22";

describe("parseSchedule", () => {
  it("parses a valid schedule", () => {
    assert.equal(SCH.timezone, "Europe/Prague");
    assert.equal(SCH.slot_minutes, 30);
    assert.equal(SCH.days.fri?.services, "checkups_only");
    assert.deepEqual(SCH.days.mon?.lunch, ["12:00", "13:00"]);
    assert.equal(SCH.days.sat?.closed, true);
  });
  it("returns null for absent/malformed input", () => {
    assert.equal(parseSchedule(null), null);
    assert.equal(parseSchedule({}), null);
    assert.equal(parseSchedule({ days: "x" }), null);
  });
});

describe("getWeekdayKeyInTimezone", () => {
  it("maps dates to weekday keys", () => {
    assert.equal(getWeekdayKeyInTimezone(MON, "Europe/Prague"), "mon");
    assert.equal(getWeekdayKeyInTimezone(FRI, "Europe/Prague"), "fri");
    assert.equal(getWeekdayKeyInTimezone(SUN, "Europe/Prague"), "sun");
  });
});

describe("isCheckupService", () => {
  it("detects checkup across languages", () => {
    for (const s of ["профілактичний огляд", "осмотр", "preventive check-up", "prohlídka"]) {
      assert.equal(isCheckupService(s), true, s);
    }
  });
  it("treats treatments as non-checkup", () => {
    for (const s of ["лікування карієсу", "коронка", "implant", "root canal"]) {
      assert.equal(isCheckupService(s), false, s);
    }
    assert.equal(isCheckupService(null), false);
  });
});

describe("evaluateScheduleRequest", () => {
  it("Friday + treatment → blocked, checkups_only, explains", () => {
    const d = evaluateScheduleRequest({ schedule: SCH, requestedDate: FRI, serviceType: "лечение кариеса", locale: "ru" });
    assert.equal(d.allowed, false);
    assert.equal(d.status, "checkups_only");
    assert.match(d.message, /осмотр/i);
  });
  it("Friday + checkup → allowed to proceed", () => {
    const d = evaluateScheduleRequest({ schedule: SCH, requestedDate: FRI, serviceType: "профилактический осмотр", locale: "ru" });
    assert.equal(d.allowed, true);
    assert.equal(d.status, "ok");
  });
  it("Friday within 07:00–09:45 (no service) → allowed", () => {
    const d = evaluateScheduleRequest({ schedule: SCH, requestedDate: FRI, requestedTime: "08:00" });
    assert.equal(d.allowed, true);
  });
  it("Friday after close (10:30) → outside_hours", () => {
    const d = evaluateScheduleRequest({ schedule: SCH, requestedDate: FRI, requestedTime: "10:30", serviceType: "огляд" });
    assert.equal(d.allowed, false);
    assert.equal(d.status, "outside_hours");
  });
  it("Saturday/Sunday → closed_day", () => {
    assert.equal(evaluateScheduleRequest({ schedule: SCH, requestedDate: SAT }).status, "closed_day");
    assert.equal(evaluateScheduleRequest({ schedule: SCH, requestedDate: SUN }).allowed, false);
  });
  it("Mon–Thu lunch (12:30) → lunch_break", () => {
    const d = evaluateScheduleRequest({ schedule: SCH, requestedDate: MON, requestedTime: "12:30", locale: "uk" });
    assert.equal(d.allowed, false);
    assert.equal(d.status, "lunch_break");
  });
  it("Mon–Thu in hours (09:30) → ok, proceed to availability", () => {
    const d = evaluateScheduleRequest({ schedule: SCH, requestedDate: THU, requestedTime: "09:30", serviceType: "лечение" });
    assert.equal(d.allowed, true);
    assert.equal(d.status, "ok");
  });
  it("Mon–Thu before open (06:00) → outside_hours", () => {
    assert.equal(evaluateScheduleRequest({ schedule: SCH, requestedDate: MON, requestedTime: "06:00" }).status, "outside_hours");
  });
});

describe("buildScheduleSummary", () => {
  it("renders a localized one-liner with Friday checkups note", () => {
    const ru = buildScheduleSummary(SCH, "ru");
    assert.match(ru, /07:00/);
    assert.match(ru, /только профилактические осмотры/);
    const en = buildScheduleSummary(SCH, "en");
    assert.match(en, /check-ups only/);
    assert.match(en, /Closed Sat & Sun/);
  });
});
