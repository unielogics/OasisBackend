# 0086 Standing appointments and the waitlist (P2, behind a feature switch)

Status: accepted (2026-10-07). Closes the stretch item 7 of the b6 list. Backend design 3.5, 4.9 and 8. Migration
`20261006300200_standing_waitlist.sql`; code in `src/modules/standing`. **No UI.**

* **The switch.** Setting `features.standing_waitlist` (default **false**; `GET/PUT /settings/features`, write needs `set.billing`).
  While off: every standing-series and waitlist endpoint answers 409 `FEATURE_DISABLED`, the three jobs return immediately, and a
  canceled slot is not offered. Each feature also needs its VIP toggle (`vip_settings.standing`, `.waitlist`, `.auto_confirm`,
  `.cadences`, `.offer_minutes`), which Settings already stores. Nothing existing changes with the switch off: the new hook in cancel
  (`SchedulingPorts.waitlist`) returns at its first line, and `appointments.standing_series_id` stays a plain uuid (the domain tables
  do not reference later verticals).
* **Standing series** (`standing_series`, `standing_occurrences`). `POST /standing-series` (`sched.edit`, Idempotency-Key required)
  for a **VIP** client (`STANDING_VIP_ONLY`), a cadence from the VIP settings (`STANDING_CADENCE_NOT_OFFERED`) and the "Standing
  appointments" toggle on (`STANDING_OFF`). The first visit's weekday is the series' weekday. Cadences: weekly, biweekly (every 2
  weeks), triweekly (every 3), **monthly = the same occurrence of the weekday** (the 2nd Saturday; a 5th becomes the last one of a
  shorter month). `PATCH` pauses, resumes or ends (final), changes the end date, auto-confirm or notes, and with `cancelUpcoming`
  cancels the visits that have not happened (ordinary cancels, so the cancellation policy applies; no text).
* **Materializer.** Books occurrences from the day after `generated_through` (or the start) through **four weeks from today** as
  ordinary appointments (`source = standing`, `standing_series_id` set, the series' vehicle, invoice created, checklist
  snapshotted) through `createAppointment` with a system actor that cannot override: a date that is closed, past or full is recorded in
  `standing_occurrences` as `skipped` with the error code and not retried; a date beyond the booking window stops the run and is picked
  up later. Idempotent per `(series, date)`. No "thanks for booking" text for a standing visit (one small change in booking.ts; the
  system actor's id is not a users row, so `created_by`/`added_by` are null for it). Runs at creation (the next four weeks appear
  at once) and as job `standing.materialize` (daily 04:00), also `POST /standing-series/materialize`.
* **Auto-confirm.** Job `standing.autoconfirm` (hourly): a still-`booked` standing visit starting within 48 hours is confirmed through the
  ordinary confirm command (the "confirmed" text is queued) when both the series and `vip_settings.auto_confirm` allow it.
* **Waitlist** (`waitlist_entries`, `waitlist_offers`). `POST /waitlist` (client, package, date, a start-time window) records `is_vip`.
  When a booked job is canceled, `slotFreed` offers its slot to waiting entries on that date whose window contains the slot's start,
  whose package fits the slot's length, who are not the canceler, and for whom the availability check (desk channel, no override)
  passes. With the VIP "Waitlist priority" toggle on, VIP entries get the offer first for `offer_minutes`; if none, or after they
  lapse (job `waitlist.offer_expiry`, every minute), everyone left is offered it for the same time. With the toggle off everyone is
  offered at once. The offer is a text through the queue ("... We are holding it for you for N minutes"). `POST
  /waitlist/:id/accept` (staff, Idempotency-Key) books the slot as an ordinary appointment, re-checking capacity, and withdraws the
  other offers on it: the first accept wins; a lapsed or missing offer is 409 `WAITLIST_NO_OFFER`; a slot taken in the meantime is
  409 `SLOT_UNAVAILABLE` and the offer stays until it lapses. An unanswered offer returns the entry to `waiting`; an entry whose date
  has passed becomes `expired`. A customer-facing accept (a link) belongs to the customer app and is not built.
* **Wiring.** Routes are registered from the scheduling module (`registerStandingRoutes`); the jobs get the real invoice gateway,
  messaging queue (`jobRuntime`), memberships and ledger settlement (`standingPorts`) and are registered with one line in
  `src/platform/job-registry.ts`.
* Tests: `test/standing/{cadence,standing,waitlist,jobs}.test.ts` (30).
