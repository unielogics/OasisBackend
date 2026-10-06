# Intentional differences from the original Payments bundle

Everything the oracle tests compare is exact (cents, labels, counts, order) except what is listed here. Each entry says
what the original does, what the backend does and why. Nothing here was needed to make a test pass; each is a decision
(ADRs 0050 to 0055) or a corrected design bug (plan D2/D3).

## What the tests assert exactly

For every range (`today`, `7d`, `30d`, `mtd`): every KPI (value, sub-label), the six raw aggregates in cents, collected by
method in cents, the four filter counts, chart bucket labels, tooltips, net and loss in cents and bar heights, the invoice
list for every filter (same rows, same order), and the pending banner. For 16 invoices: header, stat cards, breakdown lines,
action buttons, ledger rows (title, amount, notes) and credit line. For 21 command scenarios: the sheet preview numbers, the
guard messages, and the invoice figures after the command.

## Differences

| # | Original | Backend | Why |
|---|---|---|---|
| 1 | Money is float dollars (`Math.round(n*100)/100`) | Integer cents, half-up, one shared tax function (also for the adjust preview and by-item refund) | Plan 2.1, A9. No fixture or scenario value differs: every subtotal is a multiple of $5, so no tax lands on a half cent. |
| 2 | KPIs shown as whole dollars (`money0`) | API returns cents; `money0` in `payments/format.ts` renders them and a test asserts the strings equal the original's | Whole-dollar display is a UI concern. |
| 3 | `Credits issued: N clients` counts invoices with credit issued | API gives `creditInvoices` (the design's number, asserted) and `creditClients` (distinct customers) | A6: a label bug. In this data both are equal. |
| 4 | Banner always says "1 refund ..." and names the first pending in list order | "N refunds awaiting approval" for several; leads with the oldest request | A10: a singular hard-coded for any count. One pending in the fixtures, so the oracle text is identical. |
| 5 | Chart `today` silently drops invoices before 8:00 or after 5:59 PM | Buckets extend (`7a`, `6p`, ...) so nothing is dropped | A20. No fixture falls outside (`droppedFromChart = 0` in every range). |
| 6 | Status of a canceled invoice with nothing paid or refunded: `Canceled · refunded`; with a kept deposit: falls through to `Paid` | `canceled`, `canceled_kept` (label `Canceled · deposit kept`), `canceled_refunded` | Review B2, C2. The only canceled fixture (INV-20571, deposit refunded) reads `Canceled · refunded` in both. |
| 7 | Ledger lists `events.reverse()` (insertion order) | Newest first by `occurred_at`, then insertion order | Review B31. INV-20571's fixture refund time (Jun 11 9:12 AM) is **before** its deposit (11:00 AM), so the original shows the refund first and we show the deposit first; the oracle test reverses that one invoice. |
| 8 | Event time is free text (`Today 3:07 PM`, `Jun 11 · 9:12 AM`, `''`) | Real instants; `atLabel` formats `Today` / `Yesterday` / `Jun 11 · 9:12 AM`; fixture times are resolved against the clock | Plan D2. The first segment of each ledger meta line is therefore compared by value in the seed test (INV-20579: `2026-06-12T16:40-04:00`, INV-20571: `2026-06-11T09:12-04:00`) and ignored in the oracle comparison. |
| 9 | Refund events carry one `byRole` (`Management`); other events have none; approver `Rafael M. · Management` | Every event stores the actor's role snapshot, the names of the roles that granted the permission, so the user in the design with two roles reads `Management + Accounting` | Settings multi-role rule (ADR 0010). The scenario tests compare titles, amounts and notes and ignore the actor segment. |
| 10 | Collect with `Card on file` records `Visa ••4421` | `Card` (or the brand only), `awaiting_processor`, never invented digits | Plan: Squarespace exposes no last4 (ADR 0053). Cash collect is compared exactly. |
| 11 | `Payment link` shows a toast only | Creates a `payment_links` row and an SMS, no ledger event | Plan, review B9. |
| 12 | Approve has no requester check, no revalidation; Deny has no permission check | Requester cannot self-approve (unless unlimited or `approvals.allow_self`), revalidation excluding the request's own reservation, Deny needs `pay.refund` | A3, D3. `Your role can’t approve $80.00` is the 403 title, asserted equal to the original's toast. |
| 13 | Adjust settlement refund is created done, ignoring limits and the card cap | A normal refund event under the refund limit, card cap and processor rules | Review B27 (ADR 0051). Amounts are identical (57.78 in the oracle). |
| 14 | Refund by item has no item tracking | Item ids on the event, double refund rejected | Review B28. Values equal (`$42.80`, `$577.80`). |
| 15 | List sort: `off desc`, then `id` string compare, duplicate ids | `biz_date desc, invoice_no desc`; generated invoices renumbered down from 20608 skipping used ids (lowest INV-20506) | A1, review B55. The oracle test shows the row order is identical for every range and filter. |
| 16 | `Tax (7%)` label hard-coded | Tax rate is the invoice's `tax_bp` (the dashboard formats the label) | Plan: `tax.rate_bp` setting. |
| 17 | Client credit keyed by name, no expiry | By `customer_id`, FIFO lots with expiry (ADR 0052) | A4, A5, review B1. The five derived credits at load (Mateo 25, Priya 20, Victor 0, Ruby 20, Grace 20) are asserted. |
| 18 | Receipt toast says WhatsApp + email | SMS (opted-in) + email through the messenger port | Plan D1. |
| 19 | Adjust on a canceled invoice: button disabled | 409 `INVOICE_CANCELED` (backend.md said 403) | A state conflict, not a permission. |

## backend.md section 10.1 golden vectors re-verified against the original bundle

Derived by a Python port in the planning phase; re-verified here against values read from the original bundle. **No vector was
wrong.** Checked: the four summary rows (invoices, gross, net, refunds with counts, adjustments with counts, credits with counts,
outstanding with counts, and the Card / Apple Pay / Cash / Store credit totals: 7d 4739.10 / 1674.94 / 571.40 / 25.00, 30d
14296.74 / 10919.32 / 3718.04 / 25.00, mtd 6542.52 / 4440.62 / 1371.06 / 25.00, today 1333.85 / 196.88 / 0 / 0), the filter
counts at `7d` (32, 3, 3, 4, 2) and `30d` (105, 3, 5, 7, 4), the banner text, and the calc vectors for INV-20604, 20608, 20603,
20602, 20605, 20607, 20560, 20579, 20571 (net 27327) and 20566, the 10% discount of 15400 = 1540, and the tax roundings
(`taxCents(50)=4`, 150 = 11, 250 = 18). The derived client credits in pay-domain 6.1 are also correct. Items the oracle
cannot confirm because the design has no such state: the `canceled` and `canceled_kept` statuses, and everything that exists
only after the review fixes (FIFO expiry, void, tip, payment link).
