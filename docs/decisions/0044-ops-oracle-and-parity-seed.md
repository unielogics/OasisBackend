# 0044 Operations oracle tests and the parity-ops seed

Status: accepted (2026-10-06)

The original Operations bundle is the oracle. `test/golden/ops/extract/extract-original.ts` runs from the dashboard checkout
(`OriginalDriver`, `serve-original`, clock 2026-06-13T10:36:00-04:00, light theme) and writes `original.json`: the board
(KPIs, alerts, groups, queue, completed, bays, arrivals, staff columns) for each range tab, the New Appointment slot grid,
per-appointment totals and checklist progress, `countFor` and `dayInfo` for -210..+210 days, and the rendered day, week and
month views. It writes nothing inside the dashboard repository.

The `parity-ops` seed profile (`db/seeds/scheduling.ts`) builds the same world as data: a1-a12, their add-ons, checklists
with the design's done marks, photo rows, activity, and the design's procedural calendar days (`genDay`, its PRNG consumed in
the same order) as real rows for 210 days either side, except today and tomorrow (the design's calendar counts four jobs on
tomorrow that its board never lists; the seed keeps tomorrow to the fixture so the board matches). It is anchored on the
design's frozen instant whatever the injected clock says. Invoices (cents), tips, deposits and memberships are not seeded
here (other verticals own those tables); `PARITY_OPS_MONEY` and `PARITY_OPS_MEMBERS` describe them for the tests and for
those seeds, and the tests feed them through the in-memory ports.

Oracle tests assert every value exactly except the deviations in `test/golden/ops/DEVIATIONS.md`, which are asserted as exact
`[original, new]` pairs: a listed deviation that stops happening fails the test as surely as a new difference.
