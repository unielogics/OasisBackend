# Payments oracle values

The Payments design (`design/original/payments.bundle.html` in the dashboard repo) is the source of truth. These JSON files
are what the ORIGINAL bundle computes, extracted from its live logic instance (clock `2026-06-13T10:36 -04:00`, role `mgmt`,
light theme). They are committed so the backend tests need no browser; re-extract only if the design changes.

| File | Content |
|---|---|
| `fixtures.json` | The 105 invoices exactly as the original builds them (`state.txs`; ids collide in the original, so rows are matched by position) |
| `calcs.json` | `logic.calc(tx)` for each of them (floats in dollars) |
| `views.json` | For each range (`today`, `7d`, `30d`, `mtd`) and filter (`all`, `unpaid`, `refunds`, `adjusted`, `credits`): `renderVals()` KPIs, bars (labels, tooltips, heights), methods, filter chips, rows and pending banner, plus raw float aggregates and chart buckets computed with the original's own `calc` |
| `details.json` | The selected-invoice panel (`renderVals().d`: header, stat cards, breakdown lines, actions, ledger, credit line) for 16 invoices incl. INV-20603 and one per status the fixtures reach, and the pending banner text |
| `scenarios.json` | The original's sheet logic (refund full / by item / custom / cash / over limit, adjust $ and % with settlement, issue credit, apply credit, collect, approve, deny, as mgmt, support or super): sheet summary, guard text, submit label, toast and the invoice afterwards |
| `DEVIATIONS.md` | Every intentional difference between the API and the original |

## Re-extracting

The extraction script drives the dashboard harness (`~/oasis/dashboard/tools/parity`: `startOriginalServer`, `OriginalDriver`,
`serializeVals`) and reads the original's logic instance through React. It writes only into this directory; nothing is written
to the dashboard repo.

```bash
cd ~/oasis/dashboard
export PATH=$HOME/.local/bin:$PATH NODE_OPTIONS=--max-old-space-size=2048
npx tsx ~/oasis/wt/p1-payments/test/golden/pay/extract-oracle.mjs [outDir]   # about 25 s, one Chromium
```

The harness sets `PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-arm64` itself. Run it alone (one heavy process at a time).

## Where it is asserted

| Test | Asserts |
|---|---|
| `test/payments/fixtures.test.ts` | the generated fixtures (`db/seeds/payments.ts`) equal `fixtures.json` field by field (proves the RNG call order); `calcInvoice` equals `calcs.json` for all 105 |
| `test/payments/seed-sql.test.ts` | the seeded SQL `invoice_calc_of` equals the TS twin and `calcs.json` for every invoice |
| `test/payments/oracle.test.ts` | summary KPIs, sub labels, by-method, filter counts, chart buckets and heights, banner, the invoice list for every range x filter, and the detail panels equal `views.json` / `details.json` |
| `test/payments/scenarios.test.ts` | the API's command results and guard messages equal `scenarios.json` |
