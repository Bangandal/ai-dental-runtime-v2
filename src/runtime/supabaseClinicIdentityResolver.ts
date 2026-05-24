import type { RpcCaller, RuntimeResult } from "./runtimeRepositories.ts";

export interface ClinicIdentityResolver {
  resolveClinicIdentity(input: { clinic_identifier: string }): Promise<RuntimeResult<{ clinic_id: string; clinic_code: string }, "clinic_not_found" | "clinic_resolve_failed" | "clinic_resolve_invalid">>;
}

export function createSupabaseClinicIdentityResolver(deps: { rpc: RpcCaller }): ClinicIdentityResolver {
  return {
    async resolveClinicIdentity(input) {
      const { data, error } = await deps.rpc<Array<{ clinic_id?: unknown; clinic_code?: unknown }>>(
        "rpc_resolve_clinic_identity_v1",
        { p_clinic_identifier: input.clinic_identifier },
      );
      if (error) return fail("clinic_resolve_failed", "Failed to resolve clinic identity");
      const row = data?.[0];
      if (!row) return fail("clinic_not_found", "Clinic was not found", false);
      const clinicId = typeof row.clinic_id === "string" ? row.clinic_id : null;
      const clinicCode = typeof row.clinic_code === "string" ? row.clinic_code : null;
      if (!clinicId || !clinicCode) return fail("clinic_resolve_invalid", "Clinic resolver returned invalid identity", false);
      return { ok: true, data: { clinic_id: clinicId, clinic_code: clinicCode } };
    },
  };
}

function fail(code: "clinic_not_found" | "clinic_resolve_failed" | "clinic_resolve_invalid", message: string, retryable = true): RuntimeResult<never, typeof code> {
  return { ok: false, error: { code, message, retryable } };
}
