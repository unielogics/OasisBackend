# 0055 Payments: reports, chart and CSV rules

Status: accepted (2026-10-06)

* **Ranges** are inclusive business days ending today in the business tz (`today`, `7d`, `30d`, `mtd`); an invoice belongs to
  a range by `biz_date`. KPIs, chart, by-method and filter counts ignore the filter and the search box; the pending banner and
  `awaitingProcessor` are global.
* **KPIs**: gross = items; net = gross + adjustments - the tax portion of refunds, removed once per tax rate on the aggregate
  (half-up); counts as in the design. "Credits issued: N clients" counted invoices in the design; the API returns both
  `creditInvoices` (the design's number) and `creditClients` (distinct customers), the dashboard shows the corrected one.
* **Chart**: per bucket `net = sum of per-invoice net` (each rounded half-up, as the design rounds each invoice) and
  `loss = sum(refunded + max(0, -adjustments))`; scale is `max(1, max(net + loss))`. `today` is hourly 8a-5p by the invoice's
  service time, **extended** (7a, 6p ...) when data falls outside instead of silently dropping it (review B3 / A20); other
  ranges are one bucket per day with the design's labels (`S 7`, a bare day number every third day for 30d).
* **By method** sums `pay` (minus `void`) and `credit_apply` by `method_kind`; five keys (`card`, `applePay`, `cash`,
  `storeCredit`, `other`); the dashboard adds an "Other" row only when non-zero.
* **List**: sort `biz_date desc, invoice_no desc` (numeric, so it equals the design's string compare for 5-digit numbers),
  keyset pagination, search over the joined text of id, client, vehicle and item names with LIKE wildcards escaped.
* **Pending banner** text is built server side; the design's singular "refund" is only right for one, so several read
  "2 refunds awaiting approval" and lead with the oldest request.
* **CSV**: UTF-8 BOM, CRLF, RFC 4180 quoting, money as plain decimals, dates and times in the business tz, text cells that start
  with `= + - @` (or tab / CR) get a leading apostrophe and numeric columns are exempt, scope = range + filter + search,
  filename `oasis-invoices_{from}_{to}.csv`, capped at 20,000 rows (larger exports are the P2 job).
* Whole-dollar KPI display (`money0`) is a dashboard concern; `payments/format.ts` carries the helper and tests assert that our
  cents render exactly the original's strings.
