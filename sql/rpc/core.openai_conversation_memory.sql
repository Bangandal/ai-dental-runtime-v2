create table if not exists core.openai_conversation_memory (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null,
  channel text not null,
  external_user_id text,
  chat_id text,
  conversation_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  constraint openai_conversation_memory_identity_check check (
    external_user_id is not null or chat_id is not null
  )
);

create unique index if not exists openai_conversation_memory_unique_external_user
  on core.openai_conversation_memory (clinic_id, channel, external_user_id)
  where external_user_id is not null;

create unique index if not exists openai_conversation_memory_unique_chat
  on core.openai_conversation_memory (clinic_id, channel, chat_id)
  where chat_id is not null;

create index if not exists openai_conversation_memory_conversation_id_idx
  on core.openai_conversation_memory (conversation_id);

create or replace function core.rpc_get_openai_conversation_memory_v1(
  p_clinic_id uuid,
  p_channel text,
  p_external_user_id text,
  p_chat_id text
)
returns table(conversation_id text)
language plpgsql
security definer
as $$
begin
  if p_external_user_id is not null and btrim(p_external_user_id) <> '' then
    return query
    select m.conversation_id
    from core.openai_conversation_memory m
    where m.clinic_id = p_clinic_id
      and m.channel = p_channel
      and m.external_user_id = p_external_user_id
    limit 1;
    return;
  end if;

  if p_chat_id is not null and btrim(p_chat_id) <> '' then
    return query
    select m.conversation_id
    from core.openai_conversation_memory m
    where m.clinic_id = p_clinic_id
      and m.channel = p_channel
      and m.chat_id = p_chat_id
    limit 1;
  end if;
end;
$$;

create or replace function core.rpc_upsert_openai_conversation_memory_v1(
  p_clinic_id uuid,
  p_channel text,
  p_external_user_id text,
  p_chat_id text,
  p_conversation_id text
)
returns table(conversation_id text)
language plpgsql
security definer
as $$
begin
  if p_external_user_id is not null and btrim(p_external_user_id) <> '' then
    insert into core.openai_conversation_memory as m (
      clinic_id,
      channel,
      external_user_id,
      chat_id,
      conversation_id,
      updated_at,
      last_seen_at
    )
    values (
      p_clinic_id,
      p_channel,
      p_external_user_id,
      p_chat_id,
      p_conversation_id,
      now(),
      now()
    )
    on conflict (clinic_id, channel, external_user_id)
      where external_user_id is not null
    do update
      set conversation_id = excluded.conversation_id,
          chat_id = excluded.chat_id,
          updated_at = now(),
          last_seen_at = now();

    return query
    select m2.conversation_id
    from core.openai_conversation_memory m2
    where m2.clinic_id = p_clinic_id
      and m2.channel = p_channel
      and m2.external_user_id = p_external_user_id
    limit 1;
    return;
  end if;

  if p_chat_id is null or btrim(p_chat_id) = '' then
    raise exception 'external_user_id or chat_id is required';
  end if;

  insert into core.openai_conversation_memory as m (
    clinic_id,
    channel,
    external_user_id,
    chat_id,
    conversation_id,
    updated_at,
    last_seen_at
  )
  values (
    p_clinic_id,
    p_channel,
    null,
    p_chat_id,
    p_conversation_id,
    now(),
    now()
  )
  on conflict (clinic_id, channel, chat_id)
    where chat_id is not null
  do update
    set conversation_id = excluded.conversation_id,
        updated_at = now(),
        last_seen_at = now();

  return query
  select m2.conversation_id
  from core.openai_conversation_memory m2
  where m2.clinic_id = p_clinic_id
    and m2.channel = p_channel
    and m2.chat_id = p_chat_id
  limit 1;
end;
$$;
