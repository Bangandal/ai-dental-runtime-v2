-- Staff inbox workflow and operational metrics layered on core.staff_requests.
-- Apply after core.staff_requests.sql.

alter table core.staff_requests
  add column if not exists workflow_status text not null default 'open'
    check (workflow_status in ('open', 'acknowledged', 'resolved'));
alter table core.staff_requests
  add column if not exists resolution_note text;
alter table core.staff_requests
  add column if not exists resolved_at timestamptz;

create index if not exists staff_requests_inbox_idx
  on core.staff_requests (clinic_id, workflow_status, created_at desc);

create or replace function core.rpc_list_staff_requests(
  p_clinic_id uuid,
  p_status text default null,
  p_limit integer default 50
) returns table(
  request_id uuid,
  clinic_id uuid,
  contact_id uuid,
  request jsonb,
  delivery_status text,
  workflow_status text,
  resolution_note text,
  created_at timestamptz,
  updated_at timestamptz,
  resolved_at timestamptz
)
language plpgsql security definer set search_path = pg_catalog, core as $$
begin
  if p_clinic_id is null then raise exception 'clinic_id_required'; end if;
  if p_status is not null and p_status not in ('open', 'acknowledged', 'resolved') then
    raise exception 'invalid_staff_workflow_status';
  end if;
  return query
    select r.request_id, r.clinic_id, r.contact_id, r.request, r.delivery_status,
           r.workflow_status, r.resolution_note, r.created_at, r.updated_at, r.resolved_at
      from core.staff_requests r
      where r.clinic_id = p_clinic_id
        and (p_status is null or r.workflow_status = p_status)
      order by
        case r.workflow_status when 'open' then 0 when 'acknowledged' then 1 else 2 end,
        r.created_at desc
      limit greatest(1, least(coalesce(p_limit, 50), 200));
end;
$$;

create or replace function core.rpc_update_staff_request_status(
  p_clinic_id uuid,
  p_request_id uuid,
  p_status text,
  p_resolution_note text default null
) returns table(
  request_id uuid,
  clinic_id uuid,
  contact_id uuid,
  request jsonb,
  delivery_status text,
  workflow_status text,
  resolution_note text,
  created_at timestamptz,
  updated_at timestamptz,
  resolved_at timestamptz
)
language plpgsql security definer set search_path = pg_catalog, core as $$
begin
  if p_status not in ('open', 'acknowledged', 'resolved') then
    raise exception 'invalid_staff_workflow_status';
  end if;
  if p_resolution_note is not null and length(p_resolution_note) > 1000 then
    raise exception 'resolution_note_too_long';
  end if;

  update core.staff_requests r
    set workflow_status = p_status,
        resolution_note = case when p_status = 'resolved' then nullif(trim(p_resolution_note), '') else null end,
        resolved_at = case when p_status = 'resolved' then coalesce(r.resolved_at, now()) else null end,
        updated_at = now()
    where r.clinic_id = p_clinic_id and r.request_id = p_request_id;

  if not found then raise exception 'staff_request_not_found'; end if;

  return query
    select r.request_id, r.clinic_id, r.contact_id, r.request, r.delivery_status,
           r.workflow_status, r.resolution_note, r.created_at, r.updated_at, r.resolved_at
      from core.staff_requests r
      where r.clinic_id = p_clinic_id and r.request_id = p_request_id;
end;
$$;

create or replace function core.rpc_staff_ops_metrics(
  p_clinic_id uuid default null
) returns table(
  open_requests bigint,
  acknowledged_requests bigint,
  queued_notifications bigint,
  processing_notifications bigint,
  dead_letter_notifications bigint,
  oldest_queued_age_seconds double precision
)
language sql security definer set search_path = pg_catalog, core as $$
  select
    (select count(*) from core.staff_requests r
      where (p_clinic_id is null or r.clinic_id = p_clinic_id) and r.workflow_status = 'open') as open_requests,
    (select count(*) from core.staff_requests r
      where (p_clinic_id is null or r.clinic_id = p_clinic_id) and r.workflow_status = 'acknowledged') as acknowledged_requests,
    (select count(*) from core.staff_notification_outbox o
      where (p_clinic_id is null or o.clinic_id = p_clinic_id) and o.status = 'queued') as queued_notifications,
    (select count(*) from core.staff_notification_outbox o
      where (p_clinic_id is null or o.clinic_id = p_clinic_id) and o.status = 'processing') as processing_notifications,
    (select count(*) from core.staff_notification_outbox o
      where (p_clinic_id is null or o.clinic_id = p_clinic_id) and o.status = 'dead_letter') as dead_letter_notifications,
    (select extract(epoch from now() - min(o.created_at))
      from core.staff_notification_outbox o
      where (p_clinic_id is null or o.clinic_id = p_clinic_id)
        and o.status in ('queued', 'processing')) as oldest_queued_age_seconds;
$$;

revoke all on function core.rpc_list_staff_requests(uuid, text, integer) from public, anon, authenticated;
revoke all on function core.rpc_update_staff_request_status(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function core.rpc_staff_ops_metrics(uuid) from public, anon, authenticated;
grant execute on function core.rpc_list_staff_requests(uuid, text, integer) to service_role;
grant execute on function core.rpc_update_staff_request_status(uuid, uuid, text, text) to service_role;
grant execute on function core.rpc_staff_ops_metrics(uuid) to service_role;
