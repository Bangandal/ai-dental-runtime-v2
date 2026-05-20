# Runtime Repository Boundary

This document defines the Runtime V2 repository boundary contract.

## Architecture Position

Runtime layer ↔ Repository layer ↔ Existing RPC layer ↔ Existing Supabase/Postgres DB

- Runtime never talks directly to raw DB tables.
- Repository contracts are an anti-corruption layer.
- Runtime consumes normalized repository contracts, not raw Supabase rows.
- Repository implementations (outside this PR) must adapt existing RPC outputs into runtime contracts.

## Source of Truth

This is **not** a new persistence architecture.

- Existing Supabase/Core schema remains source of truth.
- Existing RPC layer remains source of truth.
- Runtime repository contracts must adapt to existing backend reality.

## Scope of This PR

- Defines typed repository interfaces only.
- Defines normalized RPC mapping contracts only.
- Does not implement repositories.
- Does not query Supabase.
- Does not add schema migrations or new tables.

## Explicit TODO/Gap Markers

Some runtime needs are intentionally marked as future-facing gaps instead of being silently invented:

- `patient_subject` persistence may require future schema support.
- `lookupAppointment` may require future RPC implementation.
- Post-booking lookup context may require future RPC support.

These markers are documentation of integration risk and sequencing, not implemented behavior.
