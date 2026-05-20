# Runtime V2 Implementation Roadmap

This roadmap defines phased delivery for AI Frontdesk Runtime V2 from foundation to bounded runtime evolution.

## 1) Architecture Foundation
- Finalize principles, boundaries, and glossary.
- Lock planner/policy/executor separation.

## 2) Project Skeleton and Core Contracts
- Create runtime module structure.
- Define TypeScript contracts for truth snapshot, planner output, tool request/result, and debug envelope.

## 3) OpenAI Responses API + Conversations Memory
- Add conversation client abstractions.
- Persist/resolve conversation references per contact/case.

## 4) AI Turn Planner
- Implement planner interface and prompt contract.
- Enforce structured JSON planner output with validation.

## 5) Tool Policy
- Add allow/deny policy engine using truth snapshot + planner output.
- Add policy reasons for observability and replay.

## 6) `kb.search` Tool with pgvector
- Implement retrieval executor against Supabase/Postgres.
- Return scored chunks with trace metadata.

## 7) FAQ Grounded Answers
- Compose AI answers grounded in retrieval chunks.
- Add fallback behavior when retrieval is weak/empty.

## 8) `availability.check`
- Add calendar availability query executor (read-only).
- Normalize slot outputs for planner/reply pipeline.

## 9) `hold.create`
- Implement hold lifecycle with TTL and expiration checks.
- Persist hold state in business memory.

## 10) `booking.confirm`
- Implement transactional appointment creation from active hold.
- Emit business events for downstream notifications.

## 11) Telegram / n8n Adapter Layer
- Implement transport adapters as thin I/O layers.
- Keep business logic in runtime executors/policy only.

## 12) Debug / Replay
- Persist debug envelopes for every turn.
- Build deterministic replay utilities for incident analysis.

## 13) Future Bounded Agent Runtime
- Introduce bounded specialized sub-agents under shared policy.
- Preserve executor-only writes, state authority, and traceability.

## Non-goals of Current Foundation PR
- No production runtime implementation.
- No actual OpenAI API integration yet.
- No database migrations yet.
- No booking executor implementation yet.
- No Telegram implementation yet.
- No legacy migration.
