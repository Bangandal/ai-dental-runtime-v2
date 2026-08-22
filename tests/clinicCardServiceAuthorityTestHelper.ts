export function clinicCardServiceAuthorityEnv(params: {
  service_key: string;
  aliases: readonly string[];
  doctor_id: number;
  cabinet_id: number;
  duration_minutes: number;
  availability?: {
    working_days: readonly number[];
    working_hours_start: string;
    working_hours_end: string;
    closed_dates?: readonly string[];
  };
}): Record<string, string> {
  const availability = params.availability ?? {
    working_days: [1, 2, 3, 4, 5, 6, 7],
    working_hours_start: "00:00",
    working_hours_end: "23:59",
    closed_dates: [],
  };

  return {
    CLINICCARD_SERVICE_RESOURCE_POLICY_CONFIRMED: "true",
    CLINICCARD_SERVICE_RESOURCE_RULES_JSON: JSON.stringify([{
      service_key: params.service_key,
      aliases: params.aliases,
      doctor_id: params.doctor_id,
      cabinet_id: params.cabinet_id,
      duration_minutes: params.duration_minutes,
      availability: {
        working_days: availability.working_days,
        working_hours_start: availability.working_hours_start,
        working_hours_end: availability.working_hours_end,
        closed_dates: availability.closed_dates ?? [],
      },
    }]),
  };
}
