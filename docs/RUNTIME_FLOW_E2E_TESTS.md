# Runtime Flow E2E Tests (PR35)

## Purpose
These tests validate the internal end-to-end runtime flow through `RuntimeTurnService` with mocks only.

Flow under test:

`RuntimeTurnService -> DentalRuntimeAgent -> Runtime Agent Tool Loop -> Policy -> Executors -> RPC -> tool_results -> AI final_patient_reply`

## What is mocked
- **OpenAIResponsesClient** (`responses.create`): returns planned tool calls and final AI replies.
- **RpcCaller**: simulates successful and failed `kb.search` / `availability.check` calls.
- **ConversationMemoryRepository**: simulates conversation load/save for continuity.

No HTTP transport, no n8n, and no Telegram integration is used in this suite.

## Coverage
The suite `tests/runtimeFlowE2E.test.ts` covers:

1. **FAQ flow**
   - AI asks for `kb.search`.
   - RPC returns KB chunks.
   - Tool result is `success`.
   - Second AI call receives `tool_results` and returns final patient reply.

2. **Availability flow**
   - AI asks for `availability.check` with date/time.
   - RPC returns slots.
   - Tool result is `success`.
   - Second AI call receives slots-derived `tool_results` and returns final patient reply.

3. **Memory continuity**
   - Turn 1 saves `conversation_id`.
   - Turn 2 loads and reuses prior `conversation_id`.

4. **Inactive future tool denial**
   - AI requests inactive `booking.confirm`.
   - No RPC call is made.
   - Tool result is `denied` with `tool_not_active`.
   - Second AI call still runs with denied `tool_results` and returns a safe final reply.

5. **Malformed OpenAI output**
   - Malformed response falls back to a safe final patient reply.
   - No tool execution and no RPC calls.

6. **Tool/RPC failure**
   - `kb.search` RPC returns failure.
   - Tool result becomes `failed`.
   - Second AI call still occurs and returns final patient reply.

7. **No forbidden integrations**
   - Runtime service/factory/loop source is checked for n8n/Telegram imports.

## Guarantees from this suite
- Internal runtime orchestration works without transport.
- AI remains responsible for tool selection/reasoning and final patient reply.
- Backend remains responsible for execution, policy gating, and deterministic outcomes.
- Booking write flows are not activated in this PR.
