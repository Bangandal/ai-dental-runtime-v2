# Runtime Supabase RPC Alignment

## KB search

- Runtime `kb.search` now creates an embedding from raw query text before calling Supabase.
- Runtime calls `public.rpc_kb_search_v1` via Supabase JS as `rpc("rpc_kb_search_v1", ...)`.
- `public.rpc_kb_search_v1` is a read-only wrapper that delegates to `kb.rpc_retrieve_context_json`.
- `clinic_id` must be a UUID-compatible value because wrapper input is typed as `uuid`.
- Current `/runtime/turn` mapping sets `clinic_id = clinic_code`; for MVP smoke, `clinic_code` must therefore be a real clinic UUID unless a future resolver layer maps code → UUID before repository RPC calls.

## Availability check

- Runtime `availability.check` now calls `public.rpc_check_availability_v1` via `rpc("rpc_check_availability_v1", ...)`.
- This path is read-only and does not call booking mutation RPCs.
- Booking/hold writes remain in transactional booking RPCs and are not used by `availability.check`.

## Why wrappers are used

Supabase JS RPC calls are most reliable when calling public function names without schema-qualified dotted names. Public wrappers preserve this runtime behavior while still delegating to schema-specific implementation functions.
