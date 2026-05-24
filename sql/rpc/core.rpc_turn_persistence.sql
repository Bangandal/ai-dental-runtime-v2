-- Turn persistence RPC signatures for live /runtime/turn durability trail.

create or replace function core.rpc_get_or_create_contact(
  p_clinic_id uuid,
  p_channel text,
  p_external_user_id text default null,
  p_chat_id text default null,
  p_username text default null,
  p_first_name text default null,
  p_last_name text default null
)
returns table(contact_id uuid)
language sql
security definer
as $$
  select null::uuid as contact_id where false;
$$;

create or replace function core.rpc_register_inbound_event(
  p_clinic_id uuid,
  p_contact_id uuid,
  p_channel text,
  p_external_user_id text default null,
  p_chat_id text default null,
  p_trace_id uuid,
  p_raw_payload jsonb default null
)
returns table(inbound_event_id uuid)
language sql
security definer
as $$
  select null::uuid as inbound_event_id where false;
$$;

create or replace function core.rpc_save_message(
  p_clinic_id uuid,
  p_contact_id uuid,
  p_role text,
  p_text text,
  p_trace_id uuid
)
returns table(message_id uuid)
language sql
security definer
as $$
  select null::uuid as message_id where false;
$$;

create or replace function core.rpc_merge_conversation_state(
  p_clinic_id uuid,
  p_contact_id uuid,
  p_state_json jsonb
)
returns table(contact_id uuid)
language sql
security definer
as $$
  select null::uuid as contact_id where false;
$$;
