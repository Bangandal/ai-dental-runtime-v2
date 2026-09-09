-- Durable operational requests, independent of appointments and conversation turn counters.
-- Run this migration before deploying staff-request handling. Missing RPCs fail closed.
create table if not exists core.staff_requests (
  request_id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null,
  contact_id uuid not null,
  trace_id text not null,
  request jsonb not null,
  source_message text not null,
  source text not null default 'patient_report' check (source = 'patient_report'),
  delivery_status text not null default 'pending'
    check (delivery_status in ('pending', 'sent', 'queued', 'failed', 'disabled', 'not_configured')),
  delivery jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (clinic_id, contact_id, trace_id)
);

alter table core.staff_requests enable row level security;
revoke all on core.staff_requests from public, anon, authenticated;
grant select on core.staff_requests to service_role;

create or replace function core.rpc_create_staff_request(
  p_clinic_id uuid, p_contact_id uuid, p_trace_id text,
  p_request jsonb, p_source_message text
) returns table(request_id uuid, created boolean, delivery_status text)
language plpgsql security definer set search_path = pg_catalog, core as $$
declare v_id uuid;
begin
  if p_clinic_id is null or p_contact_id is null or coalesce(length(trim(p_trace_id)), 0) = 0
    or coalesce(p_request->>'kind', '') not in ('callback', 'document_update', 'live_transfer')
    or coalesce(p_request->>'patient_target', '') not in ('self', 'other_person')
    or coalesce(length(trim(p_request->>'summary')), 0) not between 1 and 1000
    or coalesce(length(trim(p_request->>'person_ref')), 0) not between 1 and 200 then
    raise exception 'invalid_staff_request';
  end if;
  -- Contact/clinic binding comes from the authenticated shared Runtime pipeline.
  insert into core.staff_requests as r (clinic_id, contact_id, trace_id, request, source_message)
    values (p_clinic_id, p_contact_id, p_trace_id, p_request, coalesce(p_source_message, ''))
    on conflict (clinic_id, contact_id, trace_id) do nothing returning r.request_id into v_id;
  if v_id is not null then
    return query select v_id, true, 'pending'::text;
  else
    return query select r.request_id, false, r.delivery_status from core.staff_requests r
      where r.clinic_id = p_clinic_id and r.contact_id = p_contact_id and r.trace_id = p_trace_id;
  end if;
end;
$$;

create or replace function core.rpc_record_staff_request_delivery(
  p_clinic_id uuid, p_contact_id uuid, p_request_id uuid, p_delivery jsonb
) returns table(ok boolean)
language plpgsql security definer set search_path = pg_catalog, core as $$
declare v_updated integer;
begin
  if coalesce(p_delivery->>'status', '') not in ('sent', 'queued', 'failed', 'disabled', 'not_configured') then
    raise exception 'invalid_staff_request_delivery';
  end if;
  update core.staff_requests r set delivery_status = p_delivery->>'status', delivery = p_delivery, updated_at = now()
    where r.request_id = p_request_id and r.clinic_id = p_clinic_id and r.contact_id = p_contact_id
      and r.trace_id = p_delivery->>'trace_id' and r.delivery_status = 'pending';
  get diagnostics v_updated = row_count;
  return query select v_updated = 1;
end;
$$;

revoke all on function core.rpc_create_staff_request(uuid, uuid, text, jsonb, text) from public, anon, authenticated;
revoke all on function core.rpc_record_staff_request_delivery(uuid, uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function core.rpc_create_staff_request(uuid, uuid, text, jsonb, text) to service_role;
grant execute on function core.rpc_record_staff_request_delivery(uuid, uuid, uuid, jsonb) to service_role;
