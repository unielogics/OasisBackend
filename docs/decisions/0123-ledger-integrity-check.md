# 0123 Nightly ledger integrity check
Status: accepted (2026-10-08)

* **What it proves** (`ledger.integrity_check`, 03:45 business time, `src/modules/payments/jobs-integrity.ts`):
  1. every invoice's `invoice_calc_of` row, which the screens and reports read, equals `calcInvoice` recomputed in TypeScript
     from its lines and ledger events, field by field (the golden tests prove the two agree on fixtures; this proves it on the
     live data, so a hand edit, a bad migration or a drifted function shows up);
  2. the append-only triggers `ledger_events_guard` and `credit_allocations_guard` exist in the schema and are enabled;
  3. every `credit_apply` is covered by FIFO allocations that sum to it, and no store-credit lot is allocated beyond its amount.
* **Recorded per business date.** `ledger_integrity_runs` keeps one row per location and date: `ok`, the number of invoices
  checked, the findings (`{code, detail, invoiceNo}`, no customer data) and the job id. A re-run the same day with the same result
  writes nothing, so the job can run twice (proven through the real worker in `test/jobs/matrix.test.ts`).
* **Alert.** A new set of problems notifies the managers ("Ledger check found a problem", the first finding); the same problems
  found again are not announced twice the same day, and are announced again the next night while they last. The worker log has
  every finding.
* **Read only.** Nothing in the ledger is written or repaired: a finding is a question for a person (an accountant, the
  developer), not something to fix automatically.
