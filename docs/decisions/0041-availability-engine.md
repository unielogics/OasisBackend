# 0041 Availability engine: capacity, holds and overrides

Status: accepted (2026-10-06)

`availability.ts` is pure; `availability-loader.ts` loads one business date and `slots.ts` is the booking guard.

- **Candidates**: the slot grid from opening time; last start = close - cutoff (the cutoff applies to the START). Any start
  may be booked on the desk (the grid is for listing); without `allow_overrun` a job that would end after closing is `cutoff`.
- **Capacity is count based**: a candidate `[s, s + duration + buffer)` is free when the sweep-line maximum of existing
  intervals inside it is at most (active bays - 1). Bays in maintenance or blocked do not count; `bay_id` and
  `planned_bay_id` are advisory and never counted (the design's own fixtures overlap inside a bay).
- **Existing intervals**: booked, confirmed, arrived: `[start, end + buffer)`. Cleaning: `[cleaning_started_at, max(started +
  duration, now) + buffer)`. Completed: `[start, completed_at + buffer)` (a finished job stops holding its bay). Canceled and
  no-show: none. Add-ons never change the duration.
- **VIP holds**: a weekly `(weekday, time)` hold applies to the slot starting exactly then. For a non-VIP caller it is
  `vip_held` while `now < S - release_hours` (a Saturday 8:00 hold with release 48 is held at Thursday 07:59 and free at
  08:00), and while unreleased it also takes one bay for the slot length, unless a real VIP booking sits at S. VIP callers
  ignore holds. Precedence: closed, outside hours, past, outside window, blocked by real bookings, vip_held, blocked by holds,
  available.
- **Windows** (online only): VIP `window_vip_days`, others `window_std_days`; online also needs `online_lead_minutes`; an
  emergency with "pause online booking" closes the day for the online channel only. The desk ignores windows.
- **Overrides**: a desk caller may override `blocked` (capacity), `vip_held`, a closed day (closure), or a start outside the
  open window (hours) with `override.reason` when they hold `sched.override`; the reason is stored in
  `appointment_overrides` and audited. `past` and online windows are never overridable. A VIP client booking today on a
  `blocked` slot may use the **same-day guarantee** without the permission while they have used fewer than
  `same_day_per_month` in the business-tz month (counted from `appointment_overrides`); it records kind
  `same_day_guarantee`.
- **Concurrency**: `POST /appointments`, reschedule and reopen recompute the state of the exact start inside the transaction
  under `pg_advisory_xact_lock(slots:<location>:<date>)`. Six clients racing for the last two bays: exactly two win.
- **Reopen** of a no-show whose start has passed ignores the past check (capacity, hours and closures still apply); a new
  `start` is validated like a reschedule.
- **Auto-planned bay** (`booking_rules.auto_plan_bay`): the active bay with the fewest overlapping planned or occupying jobs,
  lowest number on a tie.
