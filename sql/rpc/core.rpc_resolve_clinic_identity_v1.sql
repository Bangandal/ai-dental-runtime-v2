create or replace function core.rpc_resolve_clinic_identity_v1(
  p_clinic_identifier text
)
returns table(clinic_id uuid, clinic_code text)
language sql
security definer
as $$
  select c.id as clinic_id, c.code as clinic_code
  from core.clinics c
  where c.id::text = p_clinic_identifier
     or c.code = p_clinic_identifier
  limit 1;
$$;

grant execute on function core.rpc_resolve_clinic_identity_v1(text) to service_role;
