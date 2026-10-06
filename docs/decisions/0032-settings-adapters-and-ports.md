# 0032 Settings adapters and ports

Status: accepted (2026-10-06)

- **BusinessHoursPort** has a DB implementation (`DbBusinessHours`) wired into `createIdentity` in `src/server.ts`; a location
  with no rows reads as the design defaults, the same answer `GET /settings/hours` gives. The hours save reports employee
  schedule conflicts through `HoursWarningHooks` (`employeeScheduleConflicts`), which skips inactive people and anyone linked
  only to another location.
- **Recording notifiers.** `ActivityClosureNotifier` and `ActivityEmergencyNotifier` queue nothing; they write one
  `activity_log` line per reachable appointment (the emergency line carries the rendered message and reschedule code in
  `meta`) and an audit row, and report `queued`, so counters and history are real today and the SMS wave swaps the port.
  `AuditAccountNotifier` replaces the in-memory invite/reset notifier: it reports "not delivered" (a Super Admin still gets the
  link in the response) and audits the attempt **without the link**, which is a credential.
- **Ports live in one place.** `SettingsPorts` (`src/modules/settings/http/runtime.ts`) holds the counter, notifiers, effects,
  hours hooks and `checklistSync`; `configureSettings()` overrides them at boot and `createSettingsModule(overrides)` in tests.
  `checklistSync` is where the scheduling vertical propagates template edits to jobs that have not started (design 4.9); the
  default does nothing.
- **Actor ids.** `created_by`/`updated_by`/`started_by` columns reference `users`. A caller without a users row (the dev auth
  bypass) is stored as null instead of failing the foreign key.
- **Jobs.** Definitions live in `src/modules/settings/jobs` and are registered in `src/platform/job-registry.ts`; their
  handlers are plain functions of `{db, clock}` so tests drive them with a `FixedClock`. `enqueueStartupJobs` is the startup
  catch-up.
