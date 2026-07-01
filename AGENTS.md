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
- Write operations must be controlled by runtime code, typed, checked by policy, and auditable.
- AI must never directly create appointments or contact admins.
- Admin notifications are backend side effects delivered by configured notifier adapters, such as Telegram.
- Notification delivery must return structured proof: sent, queued, failed, disabled, or not_configured.
- Patient-facing claims that an admin was notified require delivery proof.
- Do not assume n8n or any downstream layer exists unless it is explicitly configured and tested.

## PR Description Checklist (required)
Every PR description must include:
1. Goal
2. Scope
3. Changed files
4. Non-goals
5. Tests/manual checks
