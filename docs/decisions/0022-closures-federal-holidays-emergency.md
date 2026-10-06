# 0022 Closures, federal holidays and emergency closures

Status: accepted (2026-10-06)

- **Federal holidays.** The generator is a pure function (year to dated holidays), actual dates with no weekend observed
  shift (the design's Jul 4 on a Saturday stays on the 4th). The default set is the five in the design's seed (Memorial Day,
  Independence Day, Labor Day, Thanksgiving, Christmas Day); the other six federal holidays are available by key. Generated
  closures are `closed`, `notify=false` and never in the past, and a holiday that already has a closure that year (by key,
  by date or by name) is skipped. `closures` gets a `federal_year smallint` column (review C5) and
  `unique (location_id, federal_key, federal_year)` covers soft-deleted rows, so a removed holiday is not regenerated.
  Catch-up runs skip a year already recorded in `federal_holiday_runs`; the seed pre-marks 2026.
- **Notification safety.** `notify` only decides whether customers are messaged when a closure is created; deleting a
  closure sends nothing (review B24). Messaging goes through `ClosureNotifier` / `EmergencyNotifier` ports.
- **Affected counts are real.** Closed: non-canceled appointments starting that business day. Reduced: those starting
  outside the open window. They are behind `AffectedCounter`; the SQL implementation is the default.
- **dayInfo precedence.** Emergency closure rows, then a planned `closed` closure, then the weekly "Regular day off", then an
  active emergency covering the date (no rows), then a planned `reduced` closure, then the weekly hours. A weekly day off
  beats a reduced closure, as in the design. Today is not special-cased. `onlinePaused` is true on every date an active
  emergency with "pause" covers, regardless of rows.
- **Emergency close** (one transaction, one active per location by partial unique index plus an advisory lock): writes the
  emergency row and one closure row per open date (closed, or reduced to the window that stays open), soft-deleting the
  planned closures it replaces and remembering their ids; flags booked and confirmed appointments in the window (for
  `days`, including future dates, fixing the design's gap); creates reschedule links only when the include-link switch is on
  **and** `RESCHEDULE_LINK_ENABLED` is true, otherwise the sentence containing `{link}` is removed from the message. SMS is
  attempted for customers with a phone who have not opted out; otherwise email if present; otherwise the state is
  `skipped_opt_out` or `no_contact`. Vehicles already on site (arrived, cleaning) are reported, never touched.
- **Counters are rows.** notified = queued, sent or delivered notifications; rebooked = distinct appointments with
  `rebooked_at` or a used reschedule link. They are frozen into the history row at reopen. Reopen soft-deletes today's and
  future emergency rows, restores replaced planned closures dated today or later, and writes `Reopened by {user} · {n}
notified` (or `Reopened automatically` for the end-time job). Customers who did not rebook stay flagged; nothing is canceled.
- **Hours.** Warnings after a save are returned, never applied: upcoming booked/confirmed/arrived appointments whose start
  falls on a closed day or outside `[open, close)`, plus employee-schedule conflicts through a hook (employees arrive later).
