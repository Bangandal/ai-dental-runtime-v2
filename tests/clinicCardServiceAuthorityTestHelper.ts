export function clinicCardServiceAuthorityEnv(params: {
  service_key: string;
  aliases: readonly string[];
  doctor_id: number;
  cabinet_id: number;
  duration_minutes: number;
}): Record<string, string> {
  return {
    CLINICCARD_SERVICE_RESOURCE_POLICY_CONFIRMED: "true",
    CLINICCARD_SERVICE_RESOURCE_RULES_JSON: JSON.stringify([{
      service_key: params.service_key,
      aliases: params.aliases,
      doctor_id: params.doctor_id,
      cabinet_id: params.cabinet_id,
      duration_minutes: params.duration_minutes,
    }]),
  };
}
