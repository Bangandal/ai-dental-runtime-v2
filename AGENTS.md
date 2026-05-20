# AGENTS.md

## Purpose
This repository hosts the clean architecture foundation for AI Frontdesk Runtime V2.

## Contribution Rules
- Keep PRs small and scoped to a single objective.
- Use typed tool contracts (no untyped tool payload handling).
- Avoid broad rewrites or unrelated refactors.
- Do not hide business logic inside transport adapters.
- Do not implement regex-based semantic routing.
- Do not implement hardcoded service alias registries.
- All write actions must be executor-controlled and policy-gated.
- AI must never directly write appointments or send admin notifications.
- Admin notifications are backend side effects emitted as events/logs and handled by n8n.

## PR Description Checklist (required)
Every PR description must include:
1. Goal
2. Scope
3. Changed files
4. Non-goals
5. Tests/manual checks
