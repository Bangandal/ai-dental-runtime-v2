create or replace function public.rpc_kb_search_v1(
  p_clinic_id uuid,
  p_query_vec vector,
  p_k integer default 5,
  p_min_similarity real default 0.2
)
returns jsonb
language sql
stable
as $$
  select kb.rpc_retrieve_context_json(
    p_clinic_id => p_clinic_id,
    p_query_vec => p_query_vec,
    p_k => p_k,
    p_min_similarity => p_min_similarity
  );
$$;
