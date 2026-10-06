# 0043 Operations read models: KPIs, alerts, windows, staff, calendar

Status: accepted (2026-10-06)

- **Windows**: `next24` = today + tomorrow in the business tz (the design's behaviour), `today`, `tomorrow`, `week` = today
  through today + 6. KPIs and alerts ignore search and range, as in the design.
- **KPIs**: Appointments 24h counts non-canceled, non-no-show jobs today and tomorrow, sub = upcoming booked + confirmed;
  Active jobs = in a bay; Ready for pickup = completed and not collected, bounded to yesterday..tomorrow (review B29);
  Pending payments = today's jobs with a balance, sub = the sum in cents; Bay time free = 2 x remaining open minutes less the
  minutes today's booked, confirmed, arrived and cleaning jobs still commit (buffer included, clipped to [now, close]), shown
  as tenths of an hour; Members today through the membership port; Revenue today cash-basis through the payments port.
- **Alerts** 1-9 come from appointments in the same generation order as the design (jobs in start order: rules 1-6, then 7,
  8 and 8b, then the credit), then a stable sort by priority (1 for a VIP client's job; arrival-type alerts only when
  `arrival_settings.vip_first`). Changes from the design: "Needs bay" only for jobs of today, the special-instructions
  ellipsis only when truncated, "arriving soon" uses `prep_at_min`, the ETA alert only up to `ops.eta_visible_max_min`, the
  credit alert needs a real unused credit, 8b is new (geofence check-in with auto-arrive off). Alerts 10-12 come from an
  `ExternalAlertSource`. The per-minute scan `appointments.late_scan` publishes `alerts.changed` only when the set of
  `(key, priority)` differs from the last announced one.
- **Bay staff** are derived: active employees of the location who hold the Crew role, or a custom role granting `jobs.status`,
  or a per-person Allow of it, and no per-person Deny. Management, Accounting and Super Admin grant it incidentally and do
  not make someone a detailer. The Unassigned column is a pseudo-column. Titles and avatar colours come from the employee.
- **Calendar**: counts are rows; closed days include today and carry `needsRebook`; a day response lists bookings the hour
  rows cannot show in `outsideHours` (closed day, before opening, after closing). Week and month grids are derived by the
  client from `/calendar/summary`.
- **Search** covers name, make, model, colour, plate and package; the phone only with `cli.contact`, so a number typed into
  the box never reveals who owns it. Contact fields in the file are masked with the helpers in `people/redact.ts`.
- **Money labels**: `Paid`, `Deposit · $228.20 due`, `$165 due` (cents shown only when not whole, plan D2).
