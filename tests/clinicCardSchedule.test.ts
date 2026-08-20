import assert from "node:assert/strict";
import test from "node:test";

import {
  isClinicWorkingDate,
  isSlotWithinClinicSchedule,
  loadClinicCardScheduleConfig,
} from "../src/integrations/cliniccard/clinicCardSchedule.ts";

const SCHEDULE_ENV: Record<string, string> = {
  CLINICCARD_WORKING_DAYS: "1,2,3,4,5",
  CLINICCARD_WORKING_HOURS_START: "09:00",
  CLINICCARD_WORKING_HOURS_END: "18:00",
  CLINICCARD_SLOT_DURATION_MINUTES: "30",
  CLINICCARD_HOLIDAYS: "",
};

test("schedule config fails closed when working days are missing", () => {
  const env: Record<string, string | undefined> = { ...SCHEDULE_ENV };
  delete env.CLINICCARD_WORKING_DAYS;
  const result = loadClinicCardScheduleConfig(env);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "cliniccard_schedule_config_missing_field");
    assert.match(result.error.message, /CLINICCARD_WORKING_DAYS/);
  }
});

test("schedule config requires explicit working hours and duration", () => {
  for (const key of [
    "CLINICCARD_WORKING_HOURS_START",
    "CLINICCARD_WORKING_HOURS_END",
    "CLINICCARD_SLOT_DURATION_MINUTES",
  ] as const) {
    const env: Record<string, string | undefined> = { ...SCHEDULE_ENV };
    delete env[key];
    const result = loadClinicCardScheduleConfig(env);
    assert.equal(result.ok, false, key);
    if (!result.ok) assert.match(result.error.message, new RegExp(key));
  }
});

test("schedule config rejects invalid weekday, hours, duration and holiday", () => {
  const cases: Array<Record<string, string>> = [
    { ...SCHEDULE_ENV, CLINICCARD_WORKING_DAYS: "1,8" },
    { ...SCHEDULE_ENV, CLINICCARD_WORKING_HOURS_START: "9:00" },
    { ...SCHEDULE_ENV, CLINICCARD_WORKING_HOURS_END: "09:00" },
    { ...SCHEDULE_ENV, CLINICCARD_SLOT_DURATION_MINUTES: "0" },
    { ...SCHEDULE_ENV, CLINICCARD_HOLIDAYS: "2026-02-30" },
  ];
  for (const env of cases) {
    const result = loadClinicCardScheduleConfig(env);
    assert.equal(result.ok, false);
  }
});

test("schedule config normalizes weekdays and holidays", () => {
  const result = loadClinicCardScheduleConfig({
    ...SCHEDULE_ENV,
    CLINICCARD_WORKING_DAYS: "5,1,3,1",
    CLINICCARD_HOLIDAYS: "2026-12-25, 2026-01-01,2026-12-25",
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.data.working_days, [1, 3, 5]);
    assert.deepEqual(result.data.holidays, ["2026-01-01", "2026-12-25"]);
  }
});

test("working-date gate excludes weekends and configured holidays", () => {
  const result = loadClinicCardScheduleConfig({
    ...SCHEDULE_ENV,
    CLINICCARD_HOLIDAYS: "2026-07-20",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(isClinicWorkingDate("2026-07-17", result.data), true);  // Friday
  assert.equal(isClinicWorkingDate("2026-07-18", result.data), false); // Saturday
  assert.equal(isClinicWorkingDate("2026-07-19", result.data), false); // Sunday
  assert.equal(isClinicWorkingDate("2026-07-20", result.data), false); // Monday holiday
});

test("slot gate requires the full configured duration to fit inside working hours", () => {
  const result = loadClinicCardScheduleConfig({
    ...SCHEDULE_ENV,
    CLINICCARD_WORKING_DAYS: "1,2,3,4,5,6,7",
    CLINICCARD_WORKING_HOURS_START: "12:00",
    CLINICCARD_WORKING_HOURS_END: "17:00",
    CLINICCARD_SLOT_DURATION_MINUTES: "60",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(isSlotWithinClinicSchedule("2026-07-20", "12:00", 60, result.data), true);
  assert.equal(isSlotWithinClinicSchedule("2026-07-20", "11:30", 60, result.data), false);
  assert.equal(isSlotWithinClinicSchedule("2026-07-20", "16:00", 60, result.data), true);
  assert.equal(isSlotWithinClinicSchedule("2026-07-20", "16:30", 60, result.data), false);
});
