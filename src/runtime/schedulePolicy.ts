/**
 * Clinic schedule policy.
 *
 * Single source of truth for the clinic working schedule, stored as data in
 * core.clinics.settings_json.schedule and consumed by both the conversational
 * runtime and the booking calendar. Pure, dependency-free functions: parse the
 * stored schedule, render a localized human summary for model context, and make
 * a deterministic decision about whether a requested day/time is allowed BEFORE
 * any availability.check.
 *
 * Service eligibility for service-restricted days (e.g. check-ups only) is NOT
 * inferred from free text here: the deterministic layer decides only from an
 * upstream typed signal (serviceIsCheckup); an unknown service is carried to the
 * model as a restriction flag. Changing the schedule means editing the clinic
 * record, not the code or prompt.
 */

export type WeekdayKey = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

export interface DaySchedule {
  closed?: boolean;
  open?: string; // "HH:MM"
  close?: string; // "HH:MM"
  lunch?: [string, string]; // ["HH:MM","HH:MM"]
  services?: "all" | "checkups_only";
}

export interface ClinicSchedule {
  timezone: string;
  slot_minutes: number;
  days: Partial<Record<WeekdayKey, DaySchedule>>;
}

export type ScheduleLocale = "uk" | "ru" | "cs" | "en";

export type ScheduleDecisionStatus =
  | "ok"
  | "closed_day"
  | "outside_hours"
  | "lunch_break"
  | "checkups_only"
  | "checkups_only_day";

export interface ScheduleDecision {
  allowed: boolean;
  status: ScheduleDecisionStatus;
  /** Machine reason, stable for tests/debug. */
  reason: string;
  /** Localized, patient-facing explanation + suggestion (empty when allowed). */
  message: string;
}

const WEEKDAY_ORDER: WeekdayKey[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

function timeToMinutes(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/** Weekday key ("mon"..."sun") for a YYYY-MM-DD date in the given IANA timezone. */
export function getWeekdayKeyInTimezone(dateYMD: string, timezone: string): WeekdayKey | null {
  // Anchor at noon UTC to avoid any date rollover near midnight for the tz label.
  const d = new Date(`${dateYMD}T12:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return null;
  const wd = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short" })
    .format(d)
    .toLowerCase();
  const key = wd.slice(0, 3) as WeekdayKey;
  return WEEKDAY_ORDER.includes(key) ? key : null;
}

/** Safely parse the stored schedule JSON; returns null when absent/malformed. */
export function parseSchedule(raw: unknown): ClinicSchedule | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const daysRaw = obj.days;
  if (!daysRaw || typeof daysRaw !== "object") return null;
  const days: Partial<Record<WeekdayKey, DaySchedule>> = {};
  for (const key of WEEKDAY_ORDER) {
    const dv = (daysRaw as Record<string, unknown>)[key];
    if (!dv || typeof dv !== "object") continue;
    const d = dv as Record<string, unknown>;
    const day: DaySchedule = {};
    if (d.closed === true) day.closed = true;
    if (typeof d.open === "string") day.open = d.open;
    if (typeof d.close === "string") day.close = d.close;
    if (Array.isArray(d.lunch) && d.lunch.length === 2 &&
        typeof d.lunch[0] === "string" && typeof d.lunch[1] === "string") {
      day.lunch = [d.lunch[0], d.lunch[1]];
    }
    if (d.services === "all" || d.services === "checkups_only") day.services = d.services;
    days[key] = day;
  }
  const timezone = typeof obj.timezone === "string" ? obj.timezone : "Europe/Prague";
  const slot = typeof obj.slot_minutes === "number" && obj.slot_minutes > 0 ? obj.slot_minutes : 30;
  return { timezone, slot_minutes: slot, days };
}

const DASH = "–"; // en dash

const SUMMARY_LABELS: Record<ScheduleLocale, {
  header: string; lunch: string; checkups: string; closed: string;
}> = {
  uk: { header: "Графік роботи", lunch: "обідня перерва", checkups: "лише профілактичні огляди", closed: "вихідний" },
  ru: { header: "Часы работы", lunch: "обеденный перерыв", checkups: "только профилактические осмотры", closed: "выходной" },
  cs: { header: "Otevírací doba", lunch: "polední přestávka", checkups: "pouze preventivní prohlídky", closed: "zavřeno" },
  en: { header: "Opening hours", lunch: "lunch break", checkups: "preventive check-ups only", closed: "closed" },
};

const WEEKDAY_NAMES: Record<ScheduleLocale, Record<WeekdayKey, string>> = {
  uk: { mon: "Пн", tue: "Вт", wed: "Ср", thu: "Чт", fri: "Пт", sat: "Сб", sun: "Нд" },
  ru: { mon: "Пн", tue: "Вт", wed: "Ср", thu: "Чт", fri: "Пт", sat: "Сб", sun: "Вс" },
  cs: { mon: "Po", tue: "Út", wed: "St", thu: "Čt", fri: "Pá", sat: "So", sun: "Ne" },
  en: { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" },
};

/** Stable signature so consecutive identical days collapse into one range. null = absent day. */
function daySignature(day: DaySchedule | undefined): string | null {
  if (!day) return null;
  if (day.closed || (!day.open && !day.close)) return "closed";
  const lunch = day.lunch ? `${day.lunch[0]}-${day.lunch[1]}` : "";
  return `${day.open}|${day.close}|${lunch}|${day.services ?? "all"}`;
}

/**
 * Localized schedule summary for injection into model context, rendered FROM the
 * configured days (grouping only days that genuinely match), so editing the clinic
 * record alone always yields a correct summary.
 */
export function buildScheduleSummary(schedule: ClinicSchedule, locale: ScheduleLocale = "en"): string {
  const L = SUMMARY_LABELS[locale] ?? SUMMARY_LABELS.en;
  const names = WEEKDAY_NAMES[locale] ?? WEEKDAY_NAMES.en;
  const segments: string[] = [];
  let i = 0;
  while (i < WEEKDAY_ORDER.length) {
    const sig = daySignature(schedule.days[WEEKDAY_ORDER[i]]);
    if (sig == null) { i++; continue; }
    let j = i;
    while (j + 1 < WEEKDAY_ORDER.length && daySignature(schedule.days[WEEKDAY_ORDER[j + 1]]) === sig) j++;
    const label = i === j
      ? names[WEEKDAY_ORDER[i]]
      : `${names[WEEKDAY_ORDER[i]]}${DASH}${names[WEEKDAY_ORDER[j]]}`;
    if (sig === "closed") {
      segments.push(`${label} ${L.closed}`);
    } else {
      const d = schedule.days[WEEKDAY_ORDER[i]] as DaySchedule;
      let seg = `${label} ${d.open}${DASH}${d.close}`;
      if (d.lunch) seg += ` (${L.lunch} ${d.lunch[0]}${DASH}${d.lunch[1]})`;
      if (d.services === "checkups_only") seg += ` (${L.checkups})`;
      segments.push(seg);
    }
    i = j + 1;
  }
  return `${L.header}: ${segments.join("; ")}.`;
}

const MSG: Record<ScheduleLocale, {
  closed: string; outside: (open: string, close: string) => string;
  lunch: (a: string, b: string) => string; checkups: string;
}> = {
  uk: {
    closed: "Цього дня клініка не працює. Оберіть, будь ласка, інший день.",
    outside: (o, c) => `У цей день ми працюємо з ${o} до ${c}. Оберіть, будь ласка, час у цьому проміжку.`,
    lunch: (a, b) => `З ${a} до ${b} обідня перерва. Оберіть, будь ласка, інший час.`,
    checkups: "У п'ятницю клініка приймає лише на профілактичні огляди. Для лікування пропоную записатися з понеділка по четвер.",
  },
  ru: {
    closed: "В этот день клиника не работает. Выберите, пожалуйста, другой день.",
    outside: (o, c) => `В этот день мы работаем с ${o} до ${c}. Выберите, пожалуйста, время в этом промежутке.`,
    lunch: (a, b) => `С ${a} до ${b} обеденный перерыв. Выберите, пожалуйста, другое время.`,
    checkups: "В пятницу клиника принимает только на профилактические осмотры. Для лечения предлагаю записаться с понедельника по четверг.",
  },
  cs: {
    closed: "V tento den má klinika zavřeno. Vyberte prosím jiný den.",
    outside: (o, c) => `V tento den máme otevřeno od ${o} do ${c}. Vyberte prosím čas v tomto rozmezí.`,
    lunch: (a, b) => `Od ${a} do ${b} je polední přestávka. Vyberte prosím jiný čas.`,
    checkups: "V pátek klinika přijímá pouze na preventivní prohlídky. Pro ošetření prosím zvolte pondělí až čtvrtek.",
  },
  en: {
    closed: "The clinic is closed on this day. Please choose another day.",
    outside: (o, c) => `On this day we are open from ${o} to ${c}. Please choose a time within that window.`,
    lunch: (a, b) => `From ${a} to ${b} is the lunch break. Please choose another time.`,
    checkups: "On Fridays the clinic accepts preventive check-ups only. For treatment, please book Monday to Thursday.",
  },
};

export interface ScheduleRequest {
  schedule: ClinicSchedule;
  requestedDate: string; // YYYY-MM-DD
  requestedTime?: string | null; // HH:MM
  /** Typed signal resolved upstream. true=check-up, false=treatment, null/undefined=unknown. */
  serviceIsCheckup?: boolean | null;
  locale?: ScheduleLocale;
}

/**
 * Deterministic decision for a requested day/time against the schedule. Call
 * BEFORE availability.check. When allowed=false, `message` is a ready
 * patient-facing explanation. On a check-ups-only day an unknown service type is
 * NOT guessed: it returns allowed=true with status "checkups_only_day" so the
 * model applies the restriction semantically.
 */
export function evaluateScheduleRequest(req: ScheduleRequest): ScheduleDecision {
  const locale = req.locale ?? "en";
  const L = MSG[locale] ?? MSG.en;
  const wk = getWeekdayKeyInTimezone(req.requestedDate, req.schedule.timezone);
  if (!wk) {
    return { allowed: true, status: "ok", reason: "unparseable_date", message: "" };
  }
  const day = req.schedule.days[wk];
  if (!day || day.closed) {
    return { allowed: false, status: "closed_day", reason: `closed_${wk}`, message: L.closed };
  }
  // Time-window checks apply to every service.
  const time = req.requestedTime ? timeToMinutes(req.requestedTime) : null;
  if (time != null && day.open && day.close) {
    const openM = timeToMinutes(day.open);
    const closeM = timeToMinutes(day.close);
    if (openM != null && closeM != null && (time < openM || time >= closeM)) {
      return { allowed: false, status: "outside_hours", reason: `outside_hours_${wk}`, message: L.outside(day.open, day.close) };
    }
    if (day.lunch) {
      const ls = timeToMinutes(day.lunch[0]);
      const le = timeToMinutes(day.lunch[1]);
      if (ls != null && le != null && time >= ls && time < le) {
        return { allowed: false, status: "lunch_break", reason: `lunch_${wk}`, message: L.lunch(day.lunch[0], day.lunch[1]) };
      }
    }
  }
  // Service-restricted day: decide only from a typed signal, never from free text.
  if (day.services === "checkups_only") {
    if (req.serviceIsCheckup === false) {
      return { allowed: false, status: "checkups_only", reason: `checkups_only_${wk}`, message: L.checkups };
    }
    if (req.serviceIsCheckup !== true) {
      return { allowed: true, status: "checkups_only_day", reason: `checkups_only_day_${wk}`, message: "" };
    }
  }
  return { allowed: true, status: "ok", reason: "allowed", message: "" };
}
