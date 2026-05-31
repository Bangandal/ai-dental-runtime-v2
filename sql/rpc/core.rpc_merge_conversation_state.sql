create or replace function core.rpc_merge_conversation_state(
  p_clinic_id uuid,
  p_contact_id uuid,
  p_user_text text,
  p_reply_text text,
  p_slot_updates jsonb default '{}'::jsonb,
  p_requested_action text default 'continue',
  p_conversation_intent text default 'unknown',
  p_handoff_recommended boolean default false,
  p_confidence text default 'medium',
  p_control_flags jsonb default '{}'::jsonb
)
returns table(ok boolean)
language plpgsql
security definer
as $$
declare
  v_existing_state jsonb := '{}'::jsonb;
  v_next_state jsonb := '{}'::jsonb;
  v_slot_updates jsonb := coalesce(p_slot_updates, '{}'::jsonb);
  v_control_flags jsonb := coalesce(p_control_flags, '{}'::jsonb);
  v_turn_count integer := 0;
begin
  select coalesce(cs.state_json, '{}'::jsonb)
    into v_existing_state
  from core.convo_state cs
  where cs.clinic_id = p_clinic_id
    and cs.contact_id = p_contact_id
  for update;

  v_next_state := coalesce(v_existing_state, '{}'::jsonb)
    || jsonb_build_object(
      'last_user_message_text', p_user_text,
      'last_assistant_message_text', p_reply_text,
      'last_bot_action', p_requested_action,
      'last_intent', p_conversation_intent,
      'conversation_intent', p_conversation_intent,
      'handoff_recommended', p_handoff_recommended,
      'confidence', p_confidence
    );

  if jsonb_typeof(v_slot_updates) = 'object' and v_slot_updates <> '{}'::jsonb then
    v_next_state := jsonb_set(
      v_next_state,
      '{collected}',
      coalesce(v_next_state->'collected', '{}'::jsonb) || v_slot_updates,
      true
    );
  end if;

  if jsonb_typeof(v_control_flags->'collected') = 'object' then
    v_next_state := jsonb_set(
      v_next_state,
      '{collected}',
      coalesce(v_next_state->'collected', '{}'::jsonb) || (v_control_flags->'collected'),
      true
    );
  end if;

  if jsonb_typeof(v_control_flags->'missing_fields') = 'array' then
    v_next_state := jsonb_set(v_next_state, '{missing_fields}', v_control_flags->'missing_fields', true);
  end if;

  if jsonb_typeof(v_control_flags->'task_state') = 'object' then
    v_next_state := jsonb_set(
      v_next_state,
      '{task_state}',
      coalesce(v_next_state->'task_state', '{}'::jsonb) || (v_control_flags->'task_state'),
      true
    );
  end if;

  if jsonb_typeof(v_control_flags->'openai_conversation_id') = 'string' then
    v_next_state := jsonb_set(v_next_state, '{openai_conversation_id}', v_control_flags->'openai_conversation_id', true);
    v_next_state := jsonb_set(v_next_state, '{conversation_id}', v_control_flags->'openai_conversation_id', true);
  end if;

  if jsonb_typeof(v_control_flags->'last_bot_question') = 'string' then
    v_next_state := jsonb_set(v_next_state, '{last_bot_question}', v_control_flags->'last_bot_question', true);
  end if;

  if jsonb_typeof(v_control_flags->'topic_memory') = 'object' then
    v_next_state := jsonb_set(v_next_state, '{topic_memory}', v_control_flags->'topic_memory', true);
  end if;

  if jsonb_typeof(v_next_state->'turn_count') = 'number' then
    v_turn_count := (v_next_state->>'turn_count')::integer;
  end if;

  v_next_state := jsonb_set(v_next_state, '{turn_count}', to_jsonb(v_turn_count + 1), true);
  v_next_state := jsonb_set(v_next_state, '{updated_at}', to_jsonb(now()), true);

  update core.convo_state cs
     set state_json = v_next_state,
         updated_at = now()
   where cs.clinic_id = p_clinic_id
     and cs.contact_id = p_contact_id;

  if not found then
    insert into core.convo_state (clinic_id, contact_id, state_json, updated_at)
    values (p_clinic_id, p_contact_id, v_next_state, now());
  end if;

  return query select true;
end;
$$;

grant execute on function core.rpc_merge_conversation_state(
  uuid,
  uuid,
  text,
  text,
  jsonb,
  text,
  text,
  boolean,
  text,
  jsonb
) to service_role;
