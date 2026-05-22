# DENTAL_RUNTIME_AGENT_FACTORY

## Purpose

`createDentalRuntimeAgent` is the internal composition factory for Runtime V2.
It wires the OpenAI caller adapter, runtime loop, active tool executors, and Supabase-backed repositories into one `OpenAIRuntimeAgent` service.

This module provides internal dependency assembly only.
It does not add transport concerns.

## Dependency wiring

Factory input dependencies:

- `openaiClient`: injected OpenAI Responses-compatible client
- `model`: model name for runtime turn calls
- `rpc`: injected RPC caller used by Supabase repository adapters
- `conversationMemoryRepository?`: optional dialogue continuity store
- `now?`: optional deterministic clock input for policy/truth calculations

Factory assembly order:

1. `createOpenAIRuntimeAgentCaller({ client: openaiClient })`
2. `createSupabaseKnowledgeRepository({ rpc })`
3. `createSupabaseAvailabilityRepository({ rpc })`
4. `createKbSearchExecutor({ knowledgeRepository })`
5. `createAvailabilityCheckExecutor({ bookingRepository })`
6. Build `ToolExecutorRegistry` with only active tools
7. `createRuntimeAgentLoop({ model, caller, executors, conversationMemoryRepository, now })`

## Active tools (wired now)

Only these tools are active in this factory:

- `kb.search`
- `availability.check`

## Inactive future tools (not wired here)

These tools are intentionally not wired in PR32:

- `hold.create`
- `booking.confirm`
- `cancel_hold`
- `appointment.lookup`

Also not wired:

- `admin.notify`

If requested by the model, inactive tools are denied by runtime policy/active-tool checks and no executor/RPC path is run for them.

## Boundaries

This factory does not:

- add HTTP endpoints
- add n8n or Telegram integration
- add MCP transport
- perform booking writes
- alter runtime loop behavior
- alter policy behavior
- alter repository or executor business logic

## Why this matters for `/runtime/turn`

This composition establishes a single internal construction point for the runtime agent service.
A future `/runtime/turn` transport layer can call this factory, inject environment-specific dependencies, and execute `runTurn` without changing domain/runtime assembly logic.
