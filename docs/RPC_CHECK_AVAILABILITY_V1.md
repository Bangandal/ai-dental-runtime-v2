# RPC: `core.rpc_check_availability_v1`

## Why this read-only RPC exists

Runtime V2 requires `availability.check` to be scheduling-sensitive and strictly read-only. The existing transactional booking RPC (`rpc_apply_booking_decision_v1`) mixes read and write actions (e.g., hold creation and booking-side updates), which is not suitable for availability-only reads.

`core.rpc_check_availability_v1` provides a dedicated read path that:
- validates clinic/provider scheduling context,
- generates candidate slots from working hours,
- excludes conflicting appointments,
- excludes conflicting active slot holds,
- returns normalized slot candidates.

It performs **no state mutations**.

## Availability vs Booking responsibilities

### `availability.check` (read-only)
Uses `core.rpc_check_availability_v1` to return available slot candidates.

Must not:
- create holds,
- create appointments,
- update cases,
- write events,
- send/prepare notifications.

### `hold.create` / `booking.confirm` / `cancel_hold` (write)
Continue using existing transactional booking flow (`rpc_apply_booking_decision_v1` or equivalent write-layer RPCs) where state mutation and transaction guarantees are required.

## Why old booking RPC is not removed

The existing booking RPC remains the write transaction layer for hold/book/cancel operations. Runtime V2 intentionally separates:
- read scheduling decisions (`availability.check`), from
- write booking transactions (`hold.create`, `booking.confirm`, `cancel_hold`).

This preserves operational continuity while introducing a safe, explicit read-only scheduling foundation.
