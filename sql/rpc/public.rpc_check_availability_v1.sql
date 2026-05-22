create or replace function public.rpc_check_availability_v1(
  p_clinic_id uuid,
  p_requested_date date,
  p_requested_time text default null,
  p_service_interest text default null,
  p_limit integer default 3
)
returns jsonb
language sql
stable
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'slot_key', a.slot_key,
        'starts_at', a.starts_at,
        'ends_at', a.ends_at,
        'doctor_id', a.doctor_id,
        'timezone', a.timezone
      )
      order by a.starts_at
    ),
    '[]'::jsonb
  )
  from core.rpc_check_availability_v1(
    p_clinic_id => p_clinic_id,
    p_service_interest => p_service_interest,
    p_requested_date => p_requested_date,
    p_requested_time => p_requested_time,
    p_timezone => null,
    p_limit => p_limit
  ) a;
$$;
