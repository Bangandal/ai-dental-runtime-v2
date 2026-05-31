create or replace function public.rpc_merge_conversation_state(
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
language sql
security definer
as $$
  select *
  from core.rpc_merge_conversation_state(
    p_clinic_id,
    p_contact_id,
    p_user_text,
    p_reply_text,
    coalesce(p_slot_updates, '{}'::jsonb),
    p_requested_action,
    p_conversation_intent,
    p_handoff_recommended,
    p_confidence,
    coalesce(p_control_flags, '{}'::jsonb)
  );
$$;

grant execute on function public.rpc_merge_conversation_state(
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
