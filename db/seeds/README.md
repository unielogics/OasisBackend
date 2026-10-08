# Seeds

`pnpm seed -- --profile <name>[,<name>...]` runs the named profiles (each with its dependencies, once, in list order) inside
one transaction, after making sure the single location row and the default settings exist (both idempotent).
`pnpm seed -- --list` prints the registered profiles.

| Profile          | What it adds                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `empty`          | location and default settings only                                                                                       |
| `people`         | the five roles and the seven design employees (logins only when `SEED_DEV_PASSWORD` is set)                              |
| `domain`         | bays, hours, rules, the design closures and emergency history, catalog, VIP and arrival settings                         |
| `domain-design`  | the design customers and vehicles (synthetic numbers) and the VIP clients                                                |
| `base`, `design` | compositions: `people` + `domain`; `base` + `domain-design` (+ the simulator SMS device)                                 |
| `messaging`      | one simulator SMS device                                                                                                 |
| `geofence`       | placeholder shop coordinates for the arrival geofence (only when none are set)                                           |
| `memberships`    | the four plans and the design members with this cycle's credits                                                          |
| `parity-ops`     | the Operations design day frozen at 2026-06-13 10:36 AM and its calendar (parity database only)                          |
| `parity-pay`     | the Payments design's 105 invoices (parity database only)                                                                |
| `demo`           | the Operations design day on **today**, as it stands at the moment the seed runs, with the Payments history and calendar |

## The demo profile (`db/seeds/demo.ts`)

For a live link opened with the real clock: `pnpm seed -- --profile design,demo` on a fresh schema (the live stack harness:
`pnpm live:up --profile design,demo`). It depends on `design`, `memberships` and `geofence`.

- **Today's board.** The design's appointments a1-a11 at their design times today and a12 tomorrow. `DEMO_PLAN` gives each job a
  day (arrival, start in its bay, finish, pickup, payment) that reproduces the design's board exactly at 10:36 AM and never puts
  two cars in one bay; the seed writes whatever of that plan has happened by the clock it runs with. Seeded at 7 AM everything is
  booked or confirmed; at noon the morning jobs are finished and paid; after closing the whole day is done (the design's unpaid
  jobs wait for pickup with a balance to collect). Checklist ticks follow the elapsed share of a job in its bay; photo rows,
  activity lines and delivered texts exist only for steps that happened.
- **Money.** One invoice per appointment. The eight jobs the Payments design names keep its numbers (INV-20601 Maria ...
  INV-20608 Aisha); Grace, Tom, Elena and Nathan take the next counter numbers. Deposits (Sofia $50, Marcus $20) and Nathan's
  prepayment were taken yesterday at 4:30 PM, prepayments (Jonathan, Liam, Aisha) arrive at the Payments design's times, a car
  paid at the counter is paid two minutes after it is finished (tips with it), and David's loyalty discount is on his invoice.
  The latest counter card payment of the day stays **awaiting Squarespace** (brand-only label), so its invoice reads "Payment
  pending"; before any counter payment exists, yesterday's last history card payment is the one waiting.
- **Payments history.** The Payments design's invoices of the last 29 days (pay-domain section 6, without today's eight, which
  are the board's) relative to today, each with the completed (or canceled) appointment it was for. The pending refund, the
  canceled job, store credit and its FIFO allocations are as in `parity-pay`.
- **Calendar.** The design's procedural days (`designGenDay`) 30-60 days back (completed, paid, invoices numbered 20505
  downward so numbers run with time) and from tomorrow to 60 days ahead (booked or confirmed, invoiced at booking from the
  counter), skipping closed days; each job's detailer is the design's rotation moved on to someone who works that weekday.
- **Idempotent**: design appointments by customer, start and package; invoices by number and appointment; procedural days by
  date. A second run the same day changes nothing; a run on a later day adds that day's board on top of the earlier one, so
  reseed a fresh schema to get a clean day.

## Adding a profile

1. Create `db/seeds/<name>.ts` that calls `registerSeedProfile(name, { description, dependsOn?, run })`.
2. Import it from `db/seeds/index.ts` (one line) so the runner can see it.
3. `run(ctx)` receives `{ tx, clock, newId, rng, location, log }`. Use `ctx.clock.now()` for time (never `new Date()`),
   `ctx.newId()` for UUIDv7 ids and `ctx.rng(seed)` (mulberry32) for anything random so output is reproducible.
4. Make it idempotent (`on conflict do nothing` / natural keys); `dependsOn` profiles run first, once.

Parity profiles run against a separate database (`DATABASE_URL_PARITY`) with `CLOCK_FREEZE_AT=2026-06-13T10:36:00-04:00`
so `app_now()` and the injected clock agree. Seed phone numbers must be synthetic (555-01xx); non-production sends are
additionally restricted by `SMS_ALLOWLIST`.
