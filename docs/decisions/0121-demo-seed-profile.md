# 0121 The demo seed: the design's day on today's date, as it stands when the seed runs
Status: accepted (2026-10-08)

* **Why.** The live link runs with the real clock, so `parity-ops` (frozen at 2026-06-13 10:36 AM) leaves today's board empty. `demo`
  (`db/seeds/demo.ts`, `pnpm seed -- --profile design,demo`) puts the Operations design's day on today's business date.
* **A timeline, not a snapshot.** `DEMO_PLAN` gives each of a1-a12 a day: arrival, start in its bay, finish, pickup, payment. The plan
  reproduces the design board exactly at 10:36 AM (tested) and assigns bays so that no bay ever holds two cars (the design's own
  times overlap if durations are honoured: David's Full Detail is finished by 10:05 so Jonathan can start at 10:09). The seed writes
  what of that plan has happened at its clock: statuses, bay occupancy, checklist ticks in proportion to the time in the bay,
  photo rows, activity lines and delivered texts, payments. Nothing is dated after the clock (tested at five times of day and on the
  day the clocks go back).
* **Money follows the Payments design.** The eight jobs it names keep INV-20601..20608 (with David's loyalty discount and the tips);
  the others take counter numbers. Deposits and Nathan's prepayment were taken yesterday; prepayments arrive at the Payments
  design's times; a counter payment is taken when the car is finished. The latest counter card payment stays awaiting Squarespace
  (brand-only label) so "Payment pending" can be seen; before any exists, yesterday's last history card payment is the one waiting.
* **One story across screens.** The Payments history (29 days, without today's eight) is seeded with the appointment each invoice
  was for, so the calendar and Payments agree; the procedural calendar covers 30-60 days back (paid, numbered below the history)
  and tomorrow to 60 days ahead (invoiced at booking like a real booking, so add-ons and reschedules work on them). Every
  appointment has exactly one invoice and no invoice number is used twice (tested).
* **Idempotent per day.** A second run the same day changes nothing. A run on a later day adds that day's board on top (earlier
  days keep the state they were seeded with), so the intended use is a fresh schema per day of review.
* **Not covered:** photo rows have no objects behind them (as in `parity-ops`; the thumbnails show the placeholder), and past
  procedural appointments beyond the history carry one card or cash payment each with no tip or add-ons.
