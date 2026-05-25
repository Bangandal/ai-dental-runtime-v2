create or replace function core.rpc_get_recent_messages_v1(
  p_contact_id uuid,
  p_limit integer default 4
)
returns table(
  role text,
  text text,
  created_at timestamptz
)
language sql
security definer
as $$
  select
    m.role,
    m.text,
    m.created_at
  from core.messages m
  where m.contact_id = p_contact_id
  order by m.created_at desc
  limit greatest(p_limit, 1);
$$;

grant execute on function core.rpc_get_recent_messages_v1(uuid, integer)
to service_role;
