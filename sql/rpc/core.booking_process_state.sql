-- Booking process state persistence in core.convo_state.state_json
-- Uses the existing convo_state table to store booking progress as a JSONB key.
-- Two functions: get (returns null when no row or no key) and upsert (insert-or-update).

create or replace function core.rpc_get_booking_process_state_v1(
  p_clinic_id uuid,
  p_contact_id uuid
)
returns table(state jsonb)
language plpgsql
security definer
as $$
begin
  return query
  select cs.state_json -> 'booking_process_state'
  from core.convo_state cs
  where cs.clinic_id = p_clinic_id
    and cs.contact_id = p_contact_id
  limit 1;
end;
$$;

create or replace function core.rpc_upsert_booking_process_state_v1(
  p_clinic_id uuid,
  p_contact_id uuid,
  p_state jsonb
)
returns void
language plpgsql
security definer
as $$
begin
  update core.convo_state
     set state_json = jsonb_set(coalesce(state_json, '{}'), '{booking_process_state}', p_state, true),
         updated_at = now()
   where clinic_id = p_clinic_id
     and contact_id = p_contact_id;

  if not found then
    insert into core.convo_state (clinic_id, contact_id, state_json, updated_at)
    values (p_clinic_id, p_contact_id,
            jsonb_build_object('booking_process_state', p_state),
            now());
  end if;
end;
$$;

grant execute on function core.rpc_get_booking_process_state_v1(uuid, uuid) to service_role;
grant execute on function core.rpc_upsert_booking_process_state_v1(uuid, uuid, jsonb) to service_role;
