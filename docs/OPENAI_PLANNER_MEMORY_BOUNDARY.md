# OpenAI Planner + Conversation Memory Boundary

## Intent

OpenAI Planner performs semantic perception only: it turns user language + runtime context into a raw planning output object.

## Boundary rules

- OpenAI conversation memory is dialogue continuity only.
- Supabase/Postgres and runtime context remain business truth.
- Planner output is raw and untrusted until `parsePlannerOutput` runs elsewhere.
- Tool Policy still authorizes or denies execution.
- Executors still perform deterministic actions.
- OpenAI planner never calls tools directly.
- OpenAI planner never writes DB/calendar/CRM state.

## Conversation ID handling

The planner adapter accepts an optional `conversation_id` and returns an optional `conversation_id` from the OpenAI caller response.

Persistence of that identifier is intentionally out of scope for this PR and belongs to repository-backed case/contact state in a later PR.
