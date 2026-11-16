import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseSchedule,
  getWeekdayKeyInTimezone,
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

describe("evaluateScheduleRequest", () => {
  it("Friday + known treatment → blocked, checkups_only, explains", () => {
    const d = evaluateScheduleRequest({ schedule: SCH, requestedDate: FRI, serviceIsCheckup: false, locale: "ru" });
    assert.equal(d.allowed, false);
    assert.equal(d.status, "checkups_only");
    assert.match(d.message, /осмотр/i);
  });
  it("Friday + known check-up → allowed to proceed", () => {
    const d = evaluateScheduleRequest({ schedule: SCH, requestedDate: FRI, serviceIsCheckup: true, locale: "ru" });
    assert.equal(d.allowed, true);
    assert.equal(d.status, "ok");
  });
  it("Friday + unknown service → allowed but flagged checkups_only_day (deferred to model)", () => {
    const d = evaluateScheduleRequest({ schedule: SCH, requestedDate: FRI, requestedTime: "08:00" });
    assert.equal(d.allowed, true);
    assert.equal(d.status, "checkups_only_day");
    assert.equal(d.message, "");
  });
  it("Friday after close (10:30) → outside_hours (time wins over service)", () => {
    const d = evaluateScheduleRequest({ schedule: SCH, requestedDate: FRI, requestedTime: "10:30", serviceIsCheckup: true });
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
  it("Mon–Thu in hours (09:30), treatment → ok (all services allowed)", () => {
    const d = evaluateScheduleRequest({ schedule: SCH, requestedDate: THU, requestedTime: "09:30", serviceIsCheckup: false });
    assert.equal(d.allowed, true);
    assert.equal(d.status, "ok");
  });
  it("Mon–Thu before open (06:00) → outside_hours", () => {
    assert.equal(evaluateScheduleRequest({ schedule: SCH, requestedDate: MON, requestedTime: "06:00" }).status, "outside_hours");
  });
});

describe("buildScheduleSummary", () => {
  it("renders a localized one-liner grouped from config", () => {
    const ru = buildScheduleSummary(SCH, "ru");
    assert.match(ru, /Пн–Чт 07:00–17:00/);
    assert.match(ru, /только профилактические осмотры/);
    assert.match(ru, /выходной/);
    const en = buildScheduleSummary(SCH, "en");
    assert.match(en, /Mon–Thu 07:00–17:00/);
    assert.match(en, /check-ups only/);
    assert.match(en, /Sat–Sun closed/);
  });
  it("is config-driven: a differing weekday is not grouped into Mon–Thu", () => {
    const raw2 = JSON.parse(JSON.stringify(RAW));
    raw2.days.tue.open = "08:00"; // Tuesday differs
    const sch2 = parseSchedule(raw2) as ClinicSchedule;
    const en = buildScheduleSummary(sch2, "en");
    assert.match(en, /Mon 07:00–17:00/);
    assert.match(en, /Tue 08:00–17:00/);
    assert.match(en, /Wed–Thu 07:00–17:00/);
  });
});
