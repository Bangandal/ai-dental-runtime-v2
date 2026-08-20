# Availability Schedule V1

This V1 removes the previous silent `09:00-18:00 / 30 min / every date` assumption from live availability generation.

## Required configuration

- `CLINICCARD_WORKING_DAYS` — ISO weekdays, Monday=1 through Sunday=7.
- `CLINICCARD_WORKING_HOURS_START` — strict `HH:MM`.
- `CLINICCARD_WORKING_HOURS_END` — strict `HH:MM` and later than start.
- `CLINICCARD_SLOT_DURATION_MINUTES` — positive integer duration.
- `CLINICCARD_HOLIDAYS` — optional comma-separated `YYYY-MM-DD` closure dates.

`availability.check` fails closed when the required schedule configuration is absent or invalid. Configured days off and holidays return no slots. `booking.apply` uses the same duration and schedule gate and refuses writes outside it.

## What this configuration proves

It proves only what the clinic operator explicitly configured: clinic working weekdays, one daily working interval, configured closure dates, and the configured default slot duration. Existing ClinicCard visits remain authoritative conflict evidence and are re-read before a live booking write.

## What it does NOT prove

This is not yet a doctor-specific ClinicCard schedule source of truth. Until ClinicCard API discovery provides evidence, this V1 does not know about:

- doctor shifts that differ from the clinic-wide interval;
- vacations, sick leave, or ad-hoc absences;
- lunch/break intervals inside the configured day;
- service-to-doctor eligibility;
- service-specific duration;
- resource/cabinet closures that are not represented by a blocking visit;
- native ClinicCard free-slot semantics, if such an endpoint exists.

Therefore the configured schedule must reflect the clinic's real operational rules before enabling patient traffic. Future ClinicCard schedule/provider/service data should replace these configured assumptions where authoritative endpoints exist.
