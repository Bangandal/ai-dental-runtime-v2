-- Durable operational staff requests and notification outbox.
-- Apply before deploying Runtime code that sends p_notification_context.
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

create table if not exists core.staff_notification_outbox (
  outbox_id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique references core.staff_requests(request_id) on delete cascade,
  clinic_id uuid not null,
  contact_id uuid not null,
  notification_context jsonb not null,
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'sent', 'dead_letter')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz not null default now(),
  locked_at timestamptz,
  last_error_code text,
  last_delivery jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_at timestamptz,
  dead_lettered_at timestamptz
);

create index if not exists staff_notification_outbox_ready_idx
  on core.staff_notification_outbox (status, next_attempt_at, created_at)
  where status in ('queued', 'processing');

alter table core.staff_requests enable row level security;
alter table core.staff_notification_outbox enable row level security;
revoke all on core.staff_requests from public, anon, authenticated;
revoke all on core.staff_notification_outbox from public, anon, authenticated;
grant select on core.staff_requests to service_role;
grant select on core.staff_notification_outbox to service_role;

create or replace function core.rpc_create_staff_request(
  p_clinic_id uuid, p_contact_id uuid, p_trace_id text,
  p_request jsonb, p_source_message text, p_notification_context jsonb
) returns table(request_id uuid, created boolean, delivery_status text, notification_queued boolean)
language plpgsql security definer set search_path = pg_catalog, core as $$
declare
  v_id uuid;
  v_created boolean := false;
begin
  if p_clinic_id is null or p_contact_id is null or coalesce(length(trim(p_trace_id)), 0) = 0
    or coalesce(p_request->>'kind', '') not in ('callback', 'document_update', 'live_transfer')
    or coalesce(p_request->>'patient_target', '') not in ('self', 'other_person')
    or coalesce(length(trim(p_request->>'summary')), 0) not between 1 and 1000
    or coalesce(length(trim(p_request->>'person_ref')), 0) not between 1 and 200 then
    raise exception 'invalid_staff_request';
  end if;

  if p_notification_context is not null and (
    coalesce(p_notification_context->>'clinic_id', '') <> p_clinic_id::text
    or coalesce(length(trim(p_notification_context->>'channel')), 0) = 0
    or coalesce(length(trim(p_notification_context->>'trace_id')), 0) = 0
    or coalesce(length(trim(p_notification_context->>'reason')), 0) = 0
  ) then
    raise exception 'invalid_staff_notification_context';
  end if;

  insert into core.staff_requests as r (clinic_id, contact_id, trace_id, request, source_message)
    values (p_clinic_id, p_contact_id, p_trace_id, p_request, coalesce(p_source_message, ''))
    on conflict (clinic_id, contact_id, trace_id) do nothing
    returning r.request_id into v_id;

  if v_id is not null then
    v_created := true;
  else
    select r.request_id into v_id
      from core.staff_requests r
      where r.clinic_id = p_clinic_id
        and r.contact_id = p_contact_id
        and r.trace_id = p_trace_id;
  end if;

  if p_notification_context is not null then
    insert into core.staff_notification_outbox as o (
      request_id, clinic_id, contact_id, notification_context
    ) values (
      v_id, p_clinic_id, p_contact_id, p_notification_context
    ) on conflict (request_id) do nothing;

    -- Queue persistence is durable, but it is explicitly not delivery proof.
    update core.staff_requests r
      set delivery_status = 'queued', updated_at = now()
      where r.request_id = v_id and r.delivery_status = 'pending';
  end if;

  return query
    select r.request_id,
           v_created,
           r.delivery_status,
           exists(select 1 from core.staff_notification_outbox o where o.request_id = r.request_id)
      from core.staff_requests r
      where r.request_id = v_id;
end;
$$;

-- Backward-compatible wrapper for rollback/older callers. It intentionally does not queue.
create or replace function core.rpc_create_staff_request(
  p_clinic_id uuid, p_contact_id uuid, p_trace_id text,
  p_request jsonb, p_source_message text
) returns table(request_id uuid, created boolean, delivery_status text)
language sql security definer set search_path = pg_catalog, core as $$
  select x.request_id, x.created, x.delivery_status
  from core.rpc_create_staff_request(
    p_clinic_id, p_contact_id, p_trace_id, p_request, p_source_message, null::jsonb
  ) x;
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
  update core.staff_requests r
    set delivery_status = p_delivery->>'status', delivery = p_delivery, updated_at = now()
    where r.request_id = p_request_id
      and r.clinic_id = p_clinic_id
      and r.contact_id = p_contact_id
      and r.delivery_status in ('pending', 'queued');
  get diagnostics v_updated = row_count;
  return query select v_updated = 1;
end;
$$;

create or replace function core.rpc_claim_staff_notification_outbox(
  p_limit integer default 10
) returns table(
  outbox_id uuid,
  request_id uuid,
  clinic_id uuid,
  contact_id uuid,
  request jsonb,
  notification_context jsonb,
  attempt_count integer
)
language plpgsql security definer set search_path = pg_catalog, core as $$
begin
  return query
  with candidates as (
    select o.outbox_id
      from core.staff_notification_outbox o
      where (
        (o.status = 'queued' and o.next_attempt_at <= now())
        or (o.status = 'processing' and o.locked_at < now() - interval '2 minutes')
      )
      order by o.next_attempt_at, o.created_at
      for update skip locked
      limit greatest(1, least(coalesce(p_limit, 10), 50))
  ), claimed as (
    update core.staff_notification_outbox o
      set status = 'processing',
          locked_at = now(),
          attempt_count = o.attempt_count + 1,
          updated_at = now()
      from candidates c
      where o.outbox_id = c.outbox_id
      returning o.outbox_id, o.request_id, o.clinic_id, o.contact_id,
                o.notification_context, o.attempt_count
  )
  select c.outbox_id, c.request_id, c.clinic_id, c.contact_id,
         r.request, c.notification_context, c.attempt_count
    from claimed c
    join core.staff_requests r on r.request_id = c.request_id;
end;
$$;

create or replace function core.rpc_complete_staff_notification_outbox(
  p_outbox_id uuid,
  p_request_id uuid,
  p_delivery jsonb,
  p_retry_after_seconds integer,
  p_terminal boolean
) returns table(ok boolean)
language plpgsql security definer set search_path = pg_catalog, core as $$
declare
  v_status text;
  v_updated integer;
  v_staff_status text;
begin
  v_status := coalesce(p_delivery->>'status', '');
  if v_status not in ('sent', 'queued', 'failed', 'disabled', 'not_configured') then
    raise exception 'invalid_staff_request_delivery';
  end if;

  if v_status = 'sent' then
    update core.staff_notification_outbox o
      set status = 'sent', locked_at = null, last_error_code = null,
          last_delivery = p_delivery, sent_at = now(), updated_at = now()
      where o.outbox_id = p_outbox_id and o.request_id = p_request_id and o.status = 'processing';
    get diagnostics v_updated = row_count;
    if v_updated <> 1 then return query select false; return; end if;
    update core.staff_requests r
      set delivery_status = 'sent', delivery = p_delivery, updated_at = now()
      where r.request_id = p_request_id;
    return query select true;
    return;
  end if;

  if coalesce(p_terminal, false) then
    v_staff_status := case
      when v_status in ('disabled', 'not_configured', 'failed') then v_status
      else 'failed'
    end;
    update core.staff_notification_outbox o
      set status = 'dead_letter', locked_at = null,
          last_error_code = nullif(p_delivery->>'error_code', ''),
          last_delivery = p_delivery, dead_lettered_at = now(), updated_at = now()
      where o.outbox_id = p_outbox_id and o.request_id = p_request_id and o.status = 'processing';
    get diagnostics v_updated = row_count;
    if v_updated <> 1 then return query select false; return; end if;
    update core.staff_requests r
      set delivery_status = v_staff_status, delivery = p_delivery, updated_at = now()
      where r.request_id = p_request_id;
    return query select true;
    return;
  end if;

  update core.staff_notification_outbox o
    set status = 'queued', locked_at = null,
        next_attempt_at = now() + make_interval(secs => greatest(coalesce(p_retry_after_seconds, 15), 1)),
        last_error_code = nullif(p_delivery->>'error_code', ''),
        last_delivery = p_delivery, updated_at = now()
    where o.outbox_id = p_outbox_id and o.request_id = p_request_id and o.status = 'processing';
  get diagnostics v_updated = row_count;
  if v_updated <> 1 then return query select false; return; end if;
  update core.staff_requests r
    set delivery_status = 'queued', delivery = p_delivery, updated_at = now()
    where r.request_id = p_request_id;
  return query select true;
end;
$$;

revoke all on function core.rpc_create_staff_request(uuid, uuid, text, jsonb, text, jsonb) from public, anon, authenticated;
revoke all on function core.rpc_create_staff_request(uuid, uuid, text, jsonb, text) from public, anon, authenticated;
revoke all on function core.rpc_record_staff_request_delivery(uuid, uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function core.rpc_claim_staff_notification_outbox(integer) from public, anon, authenticated;
revoke all on function core.rpc_complete_staff_notification_outbox(uuid, uuid, jsonb, integer, boolean) from public, anon, authenticated;
grant execute on function core.rpc_create_staff_request(uuid, uuid, text, jsonb, text, jsonb) to service_role;
grant execute on function core.rpc_create_staff_request(uuid, uuid, text, jsonb, text) to service_role;
grant execute on function core.rpc_record_staff_request_delivery(uuid, uuid, uuid, jsonb) to service_role;
grant execute on function core.rpc_claim_staff_notification_outbox(integer) to service_role;
grant execute on function core.rpc_complete_staff_notification_outbox(uuid, uuid, jsonb, integer, boolean) to service_role;
