# Agent Runtime Architecture Decision

## Goal

This document defines the agent-first, runtime-controlled architecture for AI Frontdesk Runtime V2 after live tests with an external agent runner.

The direction is:

- Strong agents may understand messy patient and operator conversations.
- Runtime must not try to own all conversational understanding.
- Runtime must own truth, tool execution, state, audit, and safety.
- Booking remains blocked until the CRM integration exists.
- Case Logic remains required, but as operational state owned by Runtime Core, not as a giant hardcoded conversation router.
- MCP/tools may expose runtime capabilities, but MCP is not the agent and does not own runtime truth.

## Core Principle

**Agent understands and plans. Runtime validates and executes. DB/CRM stores truth. MCP/tools expose runtime capabilities, but MCP is not the agent.**

This creates a clear boundary:

1. The agent interprets conversation context, asks questions, reasons about intent, and proposes tool calls or operational updates.
2. Runtime Core validates every requested action against policy, current state, identity, and backend capability.
3. Runtime Core executes approved tools through typed contracts and executor-controlled writes.
4. The database and CRM/calendar systems remain the authoritative source of operational truth.
5. MCP or other future tool layers are capability surfaces over Runtime Core; they do not replace the Patient Agent, Operator Agent, or Runtime Core.

## Roles

### Patient Agent

The Patient Agent is the patient-facing conversational agent.

It may:

- Talk directly to patients through supported channels.
- Understand messy or incomplete patient conversation context.
- Ask clarifying questions.
- Use clinical runtime tools exposed by Runtime Core.
- Propose case updates through runtime tools.
- Explain booking status based on backend tool results.

It must not:

- Edit code.
- Edit prompts.
- Edit SQL or database schema.
- Deploy runtime changes.
- Modify protected runner files.
- Directly write appointments.
- Send admin notifications directly.
- Claim booking success unless `booking.apply` or the equivalent backend booking executor reports success.

The Patient Agent can say that a booking request was received or handed off only when Runtime Core confirms the corresponding case or handoff action succeeded. It cannot present a booking as confirmed while booking is disabled, not configured, mocked, or awaiting CRM support.

### Operator Agent

The Operator Agent is the product-owner/admin-facing operational agent.

It may:

- Talk to the product owner or admin.
- Read runtime logs.
- Read runtime state.
- Read project documentation.
- Read GitHub PRs and issues.
- Inspect recent runtime errors and conversation state.
- Propose changes.
- Draft Codex prompts.
- Draft GitHub issues.
- Draft pull requests.
- Summarize operational problems and suggested fixes.

It must not, without explicit owner approval:

- Merge PRs.
- Deploy production.
- Change protected files.
- Modify production prompts.
- Modify DB schema.
- Write to CRM booking endpoints.

The Operator Agent can help operate and improve the system, but it is not a production deployment authority.

### Runtime Core

Runtime Core is the trusted backend boundary for operational truth and side effects.

Runtime Core owns:

- Contact identity.
- Case state.
- Tool execution.
- Booking validation.
- CRM/calendar adapters.
- Persistence.
- Audit logs.
- Debug logs.
- Policy gates for write actions.
- Typed tool contracts.

Runtime Core does not need to own every conversational inference. Its job is to convert agent proposals into safe, validated, auditable backend actions.

## Tool Groups

Tools are grouped by audience and permission boundary. Tool names are stable capability names, not proof that the tool is currently implemented.

### Clinical Tools

Clinical tools are available to the Patient Agent through Runtime Core policy.

| Tool | Purpose | Permission class |
| --- | --- | --- |
| `kb.search` | Search approved clinic knowledge and FAQ content. | Read-only |
| `case.upsert` | Create or update operational case state after runtime validation. | Proposal/write through Runtime Core |
| `case.list_active` | List active cases for a known contact/session. | Read-only |
| `case.add_note` | Add an operational note to a case after validation. | Proposal/write through Runtime Core |
| `handoff.create` | Create a human/admin handoff case or event. | Proposal/write through Runtime Core |
| `availability.check` | Check appointment availability when adapter support exists. | Read-only or limited/not configured before CRM |
| `booking.apply` | Apply a booking only after backend validation and CRM/calendar support. | Protected controlled write; disabled until CRM adapter exists |

### Ops Tools

Ops tools are available to the Operator Agent through runtime and repository policy.

| Tool | Purpose | Permission class |
| --- | --- | --- |
| `runtime.health` | Read runtime health/status. | Read-only |
| `runtime.recent_turns` | Read recent turn/debug records. | Read-only |
| `runtime.errors` | Read recent runtime errors. | Read-only |
| `runtime.conversation_state` | Read compact conversation and case state. | Read-only |
| `github.prs.read` | Read GitHub PR metadata and status. | Read-only |
| `codex.prompt.create` | Draft a Codex prompt for a future code change. | Proposal |

## Case Ownership

Case belongs to Runtime Core.

The agent may notice that a case should be opened, updated, noted, handed off, or closed. That observation is only a proposal until Runtime Core validates it and persists it.

Rules:

- Runtime Core owns case identity, status, transitions, timestamps, and audit records.
- The Patient Agent may propose case updates through tools such as `case.upsert` and `case.add_note`.
- Runtime Core validates proposed case updates against contact identity, current case state, policy, and allowed transition rules.
- Runtime Core persists approved case updates.
- Case is operational state, not a hardcoded semantic router.
- Case is not the same as Appointment.

A Case tracks an operational thread of work: booking intent, reschedule request, cancellation, status inquiry, urgent request, or admin/human handoff. An Appointment is a confirmed calendar/CRM object produced only by approved backend execution.

## Case Lifecycle

### Open a Case When

Runtime Core should open or maintain an active case when the conversation includes one of the following operational intents:

- Booking intent.
- Reschedule intent.
- Cancel intent.
- Process status inquiry.
- Admin/human handoff.
- Urgent request.

Examples:

- “Can I book a cleaning tomorrow?”
- “I need to move my appointment.”
- “Cancel my visit.”
- “Did anyone call me back?”
- “Please have a person contact me.”
- “My tooth hurts badly and I need help today.”

### Do Not Open a Case For

Runtime Core should not open a case for low-operational-value conversation with no action intent, including:

- Simple FAQ.
- Greeting.
- Casual clarification with no action intent.

Examples:

- “Hi.”
- “What are your hours?”
- “Do you take children?”
- “What does whitening mean?”

If a FAQ turns into a booking, handoff, urgent request, or status inquiry, Runtime Core may then open a case.

### Close a Case When

Runtime Core may close a case when one of the following backend-confirmed outcomes occurs:

- `booking.apply` succeeds.
- `handoff.create` succeeds and the case is intentionally transferred to human/admin handling.
- Cancellation is confirmed.
- Admin marks the case resolved.
- The case expires by timeout.

Case closure must be auditable. The closing reason should be explicit enough for an operator to understand whether the case ended because of successful booking, handoff, cancellation, admin resolution, or timeout.

## CRM Blocked State

Booking is blocked until a CRM adapter exists.

Before CRM integration:

- `case.upsert` can work.
- `handoff.create` can work.
- `booking.apply` should return `disabled` or `not_configured` and must not create a real appointment.
- `availability.check` can be limited, mocked, or return `not_configured`, depending on the current environment.

The Patient Agent must not claim that an appointment is booked unless Runtime Core has successfully executed the booking through the configured backend booking path. A case, handoff, note, or request is not a confirmed appointment.

CRM is required for booking because Runtime Core needs an authoritative backend system to validate slot availability, prevent duplicate bookings, persist appointments, support reschedules/cancellations, and provide auditability. Without CRM/calendar integration, runtime can collect intent and coordinate handoff, but it cannot truthfully confirm booking success.

## Permission Model

Permissions are separated by action class.

### Read-Only Actions

Read-only actions inspect state without changing protected systems.

Examples:

- Search knowledge base content with `kb.search`.
- Read active cases with `case.list_active`.
- Read runtime health with `runtime.health`.
- Read recent turns with `runtime.recent_turns`.
- Read runtime errors with `runtime.errors`.
- Read compact conversation state with `runtime.conversation_state`.
- Read GitHub PRs with `github.prs.read`.

### Proposal Actions

Proposal actions create a suggested operational change that Runtime Core must validate before persistence or execution.

Examples:

- Propose creating or updating a case with `case.upsert`.
- Propose adding a case note with `case.add_note`.
- Propose a handoff with `handoff.create`.
- Draft a Codex prompt with `codex.prompt.create`.

### Draft PR Actions

Draft PR actions may prepare code review artifacts but do not grant deployment authority.

Examples:

- Draft a branch plan.
- Draft issue text.
- Draft a PR description.
- Draft a Codex implementation prompt.
- Open or update a draft PR if repository policy allows it.

Draft PR actions must remain scoped and reviewable. They do not imply merge approval.

### Protected Actions Requiring Explicit Owner Approval

The following actions require explicit owner approval and must not be performed autonomously by the Patient Agent or Operator Agent:

- Merge PR.
- Deploy production.
- Modify DB schema.
- Modify protected runner files.
- Modify production prompt.
- Write to CRM booking endpoint.

Protected actions are high-impact because they can change production behavior, production data, booking truth, or the execution environment.

## Memory Policy

Do not send the full transcript every turn.

Runtime should provide compact, relevant state to the agent. The compact state should preserve enough context for useful reasoning while minimizing token usage, privacy exposure, and confusion from stale messages.

Use compact state fields such as:

- `recent_messages` — a short rolling window of recent user/assistant turns.
- `conversation_summary` — a concise summary of stable conversational context.
- `active_cases` — current operational cases owned by Runtime Core.
- `known_contact` — known identity and contact fields relevant to the current session.
- `clinic_facts` — stable clinic facts needed for the current answer.
- `last_tool_results` — recent backend results relevant to the next response.
- `audit_references` — IDs or links to logs/events rather than the full transcript.

The memory contract should distinguish conversational context from operational truth. Conversation memory may help the agent understand a follow-up, but DB/CRM-backed runtime state controls execution.

## Future MCP/Tools Layer

MCP may be used later to expose runtime capabilities to agents and operators. In this architecture, MCP is a tool transport/capability layer, not the agent and not the source of truth.

Rules:

- MCP tools should call Runtime Core capabilities.
- MCP tools should use typed contracts.
- MCP tools should preserve Runtime Core policy gates.
- MCP tools should not bypass executor-controlled writes.
- MCP tools should not directly own case state, booking truth, or CRM writes.

## Non-Goals

This architecture decision intentionally does not include:

- Code behavior changes.
- DB/schema changes.
- Booking implementation.
- MCP implementation.
- Prompt rewrite.
- Agent runner implementation.

## Acceptance Questions

After this decision, a developer should be able to answer the following:

### What is Patient Agent?

The Patient Agent is the patient-facing conversational agent. It understands and responds to patient conversations, uses clinical runtime tools, and proposes case or booking-related actions, but it cannot edit code, prompts, SQL, deploy, directly write appointments, or claim booking success without backend success.

### What is Operator Agent?

The Operator Agent is the product-owner/admin-facing operational agent. It reads logs, runtime state, documentation, and GitHub PRs; proposes changes; drafts Codex prompts, issues, and PRs; and cannot merge, deploy, change protected files, modify schema, modify production prompts, or write CRM booking endpoints without explicit owner approval.

### What stays inside Runtime Core?

Runtime Core owns contact identity, case state, tool execution, booking validation, CRM/calendar adapters, persistence, audit/debug logs, policy gates, and typed tool contracts.

### Who owns Case Logic?

Runtime Core owns Case Logic. Agents may propose case updates, but Runtime Core validates and persists them. Case Logic is operational state management, not a hardcoded conversation router.

### When is a case opened?

A case is opened for booking intent, reschedule intent, cancel intent, process status inquiry, admin/human handoff, or urgent request. It is not opened for simple FAQ, greeting, or casual clarification with no action intent.

### When is a case closed?

A case is closed when `booking.apply` succeeds, `handoff.create` succeeds, cancellation is confirmed, admin resolves the case, or the case expires by timeout.

### What can agents do without approval?

Agents can perform allowed read-only actions and submit proposal/draft actions through Runtime Core policy. Examples include searching the knowledge base, reading active cases or runtime state, proposing case updates, creating handoff proposals, reading GitHub PRs, and drafting Codex prompts or PR text.

### What requires explicit owner approval?

Merging PRs, deploying production, modifying DB schema, modifying protected runner files, modifying production prompts, and writing to CRM booking endpoints require explicit owner approval.

### Why is booking blocked until CRM?

Booking is blocked until CRM because Runtime Core needs an authoritative backend adapter to validate availability, prevent conflicts, persist confirmed appointments, support lifecycle operations, and audit booking results. Until then, runtime can record cases and create handoffs, but `booking.apply` must be disabled or `not_configured`.
