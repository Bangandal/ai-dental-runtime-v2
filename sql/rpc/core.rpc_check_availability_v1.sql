-- core.rpc_check_availability_v1
-- READ-ONLY RPC: safe for Runtime V2 availability.check
-- This function MUST NOT perform transactional mutations (no INSERT/UPDATE/DELETE).
-- It computes normalized slot candidates only.

create or replace function core.rpc_check_availability_v1(
  p_clinic_id uuid,
  p_service_interest text,
  p_requested_date date,
  p_requested_time text default null,
  p_timezone text default null,
  p_limit integer default 5
)
returns table (
  slot_key text,
  doctor_id uuid,
  doctor_name text,
  starts_at timestamptz,
  ends_at timestamptz,
  timezone text,
  service_interest text
)
language sql
stable
as $$
with clinic as (
  select c.id, coalesce(p_timezone, c.timezone, 'UTC') as tz
  from core.clinics c
  where c.id = p_clinic_id
), provider_hours as (
  select
    d.id as doctor_id,
    d.full_name as doctor_name,
    wh.day_of_week,
    wh.start_time,
    wh.end_time,
    coalesce(wh.slot_minutes, 30) as slot_minutes,
    coalesce(wh.timezone, (select tz from clinic)) as tz
  from core.doctors d
  join core.doctor_working_hours wh on wh.doctor_id = d.id
  where d.clinic_id = p_clinic_id
    and d.is_active = true
), requested_day as (
  select
    ph.*,
    ((p_requested_date::text || ' ' || ph.start_time::text) || ' ' || ph.tz)::timestamptz as range_start,
    ((p_requested_date::text || ' ' || ph.end_time::text) || ' ' || ph.tz)::timestamptz as range_end
  from provider_hours ph
  where ph.day_of_week = extract(dow from p_requested_date)::int
), candidate_slots as (
  select
    rd.doctor_id,
    rd.doctor_name,
    gs as starts_at,
    gs + make_interval(mins => rd.slot_minutes) as ends_at,
    rd.tz as timezone
  from requested_day rd
  cross join lateral generate_series(
    rd.range_start,
    rd.range_end - make_interval(mins => rd.slot_minutes),
    make_interval(mins => rd.slot_minutes)
  ) as gs
  where p_requested_time is null
     or to_char(gs at time zone rd.tz, 'HH24:MI') = p_requested_time
), unconflicted as (
  select cs.*
  from candidate_slots cs
  where not exists (
    select 1
    from core.appointments a
    where a.clinic_id = p_clinic_id
      and a.doctor_id = cs.doctor_id
      and a.status in ('booked','confirmed')
      and tstzrange(a.starts_at, a.ends_at, '[)') && tstzrange(cs.starts_at, cs.ends_at, '[)')
  )
  and not exists (
    select 1
    from core.slot_holds h
    where h.clinic_id = p_clinic_id
      and h.doctor_id = cs.doctor_id
      and h.status = 'active'
      and h.expires_at > now()
      and tstzrange(h.starts_at, h.ends_at, '[)') && tstzrange(cs.starts_at, cs.ends_at, '[)')
  )
)
select
  encode(digest(concat_ws('|', p_clinic_id::text, doctor_id::text, starts_at::text, ends_at::text), 'sha256'), 'hex') as slot_key,
  doctor_id,
  doctor_name,
  starts_at,
  ends_at,
  timezone,
  p_service_interest as service_interest
from unconflicted
where exists (select 1 from clinic)
order by starts_at
limit greatest(coalesce(p_limit, 5), 1);
$$;
