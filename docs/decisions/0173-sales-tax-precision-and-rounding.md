# 0173 Sales tax: a precise rate (6.625%) and Square's rounding
Status: accepted (2026-10-13, owner plan "NEW PLAN (2026-10-13)", section C "Tax first"); built in wave K1e (backend). The
dashboard's twin (`src/lib/payments/cents.ts`) follows in wave K2 (package k-items-dash, section "Dashboard twin" below).
Production stays at 7% until the rollout step "Tax: set to 6.625%".

## Context

The shop charges New Jersey's sales tax, **6.625%**. Oasis was built on the design's **7%**, stored as an integer number of basis
points (`tax.rate_bp = 700`, `invoices.tax_bp`), so 662.5 bp could not be stored at all (SQR-12 used 663 bp as a stand-in). Oasis also
rounded half-up, the design's rule. Square's item library (ADR 0172) and the counter's POS app will compute the tax of the same
basket themselves, and the counter matcher (ADR 0171 D6) and payment links compare amounts **exactly**: one cent of difference leaves a
cent owing or sends a counter payment to "Square payments to match". So Oasis must store 6.625% exactly and round exactly as Square.

## What Square does (sandbox check SQR-18, 2026-10-13)

`pnpm verify:square --tax-only` sends 200 `CalculateOrder` requests to the sandbox (read-only; the catalog objects of the catalog cases
are made with a `verify-` name and deleted): single lines of every whole-dollar subtotal whose 6.625% tax ends in exactly half a cent
($4 + $8k up to $196, and $500), other dollar and cent amounts, the 7% half-cent amounts ($1.50, $2.50, $12.50, $37.50), multi-line
baskets, quantities 2 and 3, an order discount (fixed and percent), each at 6.625% and 7%, with the tax at ORDER scope, at LINE_ITEM
scope, and through catalog variations with a catalog TAX object and `auto_apply_taxes` (the POS path). Every answer is compared with six
candidate rules. Result (full table: `docs/integrations/square.md` section 15; recorded answers:
`test/fixtures/square-tax/sqr18-tax-rounding-2026-10-13.json`):

- **Exactly one rule matches all 200 answers: the tax of the order's taxable subtotal (after discounts), rounded ONCE, half to even.**
  It holds for ad-hoc lines, line-item taxes and catalog items alike.
- Square then spreads that total over the lines (`$4 + $4` at 6.625% = 53 cents shown as 26 + 27), so per-line rounding (52 or 54
  cents) is **not** Square's rule, and neither is half-up (`$4` = 26 cents at Square, 27 half-up; `$100` = $6.62, half-up $6.63).
- At 7% a whole-dollar subtotal never ends in half a cent, so both rules agree; they differ only on subtotals of $x.50 with x odd
  (`$1.50`: Square 10 cents, half-up 11).

| Subtotal | 6.625%: Square = Oasis (new) | half-up | 7%: Square = Oasis (new) | half-up |
|---|---|---|---|---|
| $4.00 | $0.26 | $0.27 | $0.28 | $0.28 |
| $12.00 | $0.80 | $0.80 | $0.84 | $0.84 |
| $20.00 | $1.32 | $1.33 | $1.40 | $1.40 |
| $36.00 | $2.38 | $2.39 | $2.52 | $2.52 |
| $40.00 | $2.65 | $2.65 | $2.80 | $2.80 |
| $50.00 | $3.31 | $3.31 | $3.50 | $3.50 |
| $100.00 | $6.62 | $6.63 | $7.00 | $7.00 |
| $129.00 | $8.55 | $8.55 | $9.03 | $9.03 |
| $500.00 | $33.12 | $33.13 | $35.00 | $35.00 |
| $4 + $4 | $0.53 (26 + 27) | per line: $0.54 | $0.56 | $0.56 |
| $20 + $36 − $4 discount | $3.44 | $3.45 | $3.64 | $3.64 |
| $1.50 | $0.10 | $0.10 | $0.10 | $0.11 |

## Decisions

| # | Decision |
|---|---|
| T1 | **Rates are stored in thousandths of a percent ("dbp", tenths of a basis point)**: 7000 = 7%, 6625 = 6.625%, 0 to 100000. The setting `tax.rate_bp` is **replaced** by `tax.rate_dbp` (default 7000; a stored value is carried over × 10 by the migration) and `invoices.tax_bp` by `invoices.tax_dbp` (every row × 10). Keeping the old columns "in step" was rejected: 662.5 cannot be stored in them, and two sources of one rate drift. |
| T2 | **Each invoice keeps its own rounding rule**, `invoices.tax_rounding`: `half_up` for every invoice that existed before the migration (their numbers never change; production had 0 invoices), **`half_even` (Square's rule) for every new invoice**, whatever the rate. The gateway writes it explicitly; the column default is the same. |
| T3 | **The tax is rounded once per invoice on its adjusted subtotal** (items + adjustments, never below 0), as before and as Square does. Tips stay untaxed. Nothing is rounded per line. |
| T4 | **One rule, every twin**: `salesTaxCents(sub, {dbp, rounding})` in `src/platform/money.ts` (TS) and `sales_tax_cents(sub, dbp, rounding)` in SQL (`invoice_calc_of`), equal for every input (property tests); `calc.ts` (`calcInvoice`, `itemsRefundValue`, `adjustPreview`), `jobs-integrity.ts`, the memberships coverage preview, the in-memory gateway, the reports and the seeds all go through them. The refunds' tax part removed from net revenue stays half-up, per rate, in dbp (the same numbers as before for every whole-bp rate). |
| T5 | **Where the rate is edited**: nowhere before (the setting had no route or screen). Now Settings → Billing & integrations: `GET /settings/billing` gains a `salesTax` block and `PUT /settings/billing/sales-tax {percent: "6.625", version}` (`set.billing`) takes a percentage with up to three decimals, 0 to 100 (`"7"`, `"6.625"`, `"6.625%"`); anything else is 422 on `percent`. A change applies to invoices made from then on. |
| T6 | **DTOs**: invoices (Payments detail, the operations board's invoice summary) gain `taxDbp` and `taxRounding`. `taxBp` stays one release, **deprecated**: the rate rounded half-up to whole basis points (6.625% reads 663), for a dashboard that predates this ADR. |
| T7 | **Labels**: "7%", "6.625%" (`taxPercentLabel`: up to three decimals, no trailing zeros). The Square payment link's tax line reads "Sales tax (6.625%)"; its amount is still the invoice's own tax as a plain line (a link sets no Square tax, so Square adds none). |
| T8 | **Verification**: `pnpm verify:square` gains SQR-18 (the CalculateOrder table against `salesTaxCents`, FAIL on any cent of difference; `--tax-only` runs just SQR-01, SQR-18 and the cleanup). The Square item library's `tax` check (ADR 0172) compares the shop's Square tax with `tax.rate_dbp` as exact decimals (`percentage` "6.625" = 6625 dbp) and blocks the item sync on a mismatch. |

## Data

Migration `20261015150000_tax_precision.sql`:
- `sales_tax_cents(bigint, integer, text)`: immutable SQL; `half_even` = floor plus one when the remainder is more than half, or exactly
  half with an odd floor; `half_up` = `(sub × dbp + 50000) / 100000`.
- `invoices.tax_dbp integer not null check (0..100000)` (backfilled `tax_bp × 10`), `invoices.tax_rounding text not null check in
  ('half_up','half_even')` (existing rows `half_up`, default `half_even`); `invoices.tax_bp` dropped.
- `invoice_calc_of` recomputed with `sales_tax_cents` and the dbp net; for a `half_up` invoice with `tax_dbp = tax_bp × 10` every column
  is identical to before (the `(n×10 + 50000)/100000` and `(n + 5000)/10000` forms are the same integer).
- Settings: a stored `tax.rate_bp` row becomes `tax.rate_dbp` (value × 10, version and author kept); the old key is gone.

## Dashboard twin (wave K2, package k-items-dash: `src/lib/payments/cents.ts`)

The live dashboard must compute exactly what the server computes:
- Read `taxDbp` and `taxRounding` from the invoice (fall back to `taxBp × 10` and `half_up` only for a response without them).
- `tax = salesTax(sub, dbp, rounding)` with `sub = max(items + adj, 0)`; `n = sub × dbp`; `q = floor(n / 100000)`, `r = n − q × 100000`;
  `half_up`: `floor((2n + 100000) / 200000)`; `half_even`: `q` if `2r < 100000`, `q + 1` if `2r > 100000`, else `q` when `q` is even and
  `q + 1` when odd. Integer math only (`n` stays far below 2^53).
- `net = items + adj − halfUp(refunded × 100000 / (100000 + dbp))` (`divHalfUp(refunded × 100000, 100000 + dbp)`).
- By-item refund value = `min(refundable, lines + salesTax(lines, dbp, rounding))`; adjustment preview: `newTotal = newSub + salesTax(max(newSub, 0), dbp, rounding) + tip`.
- DV-213 label: `taxPercentLabel(dbp)` = whole part, then up to three decimals without trailing zeros, then "%" ("Tax (6.625%)").
- Vectors to copy (`dbp`, `rounding`, `sub` → `tax`): 6625 half_even: 400 → 26, 1200 → 80, 2000 → 132, 3600 → 238, 5200 → 344,
  10000 → 662, 50000 → 3312, 800 → 53, 2400 → 159, 6000 → 398, 14000 → 928, 5500 → 364, 12900 → 855, 150 → 10; 6625 half_up:
  400 → 27, 10000 → 663, 5200 → 345; 7000 half_even: 150 → 10, 250 → 18, 18400 → 1288, every whole-dollar subtotal = half_up;
  7000 half_up (the design's, unchanged): 50 → 4, 150 → 11, 250 → 18, 1000 → 70, 18400 → 1288, 54000 → 3780, 15400 → 1078,
  35000 → 2450. Labels: 7000 → "7%", 6625 → "6.625%", 6250 → "6.25%", 1 → "0.001%".
- Settings → Billing & integrations: a "Sales tax" row editing `percent` (text input, up to three decimals) with `PUT
  /settings/billing/sales-tax`, showing the server's 422 message on `percent`; a DV line in `design-patches/DEVIATIONS.md`.

## Rollout

1. Deploy (rate still 7%; new invoices round half to even, which for whole-dollar 7% subtotals changes nothing).
2. Square production: the shop's tax in Square must be 6.625% ADDITIVE at the location (Test connection's `tax` check, ADR 0172).
3. The orchestrator sets 6.625% in Settings → Billing & integrations (or `PUT /settings/billing/sales-tax {percent: "6.625"}`), then
   confirms with a test invoice: $100.00 → $6.62.
4. `pnpm verify:square --tax-only` against the sandbox whenever the Square-Version is bumped.

## Not changed

- Squarespace sync and its matcher keep comparing Squarespace's own tax numbers as diagnostics.
- The public booking and the assistant quote prices before tax; nothing there computes tax.
