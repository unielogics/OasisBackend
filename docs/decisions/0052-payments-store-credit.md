# 0052 Payments: store credit lots, FIFO allocation and expiry

Status: accepted (2026-10-06)

* A **lot** is one `credit_issue` event or one done refund with `dest = 'credit'`. Issued credit expires at `expires_at`: the
  end of the business day (business tz) 30 or 90 days after issue; refund-to-credit lots never expire. A pending refund to
  credit is not credit until it is approved (its `resolved_at` is when the lot becomes usable).
* Applying credit allocates **FIFO by earliest expiry** (no expiry last, then earliest issue) over the lots that are not yet
  expired **at that instant** and writes `credit_allocations (apply_event_id, lot_event_id, cents)` at apply time. The balance
  is the remaining of the lots not expired now. Review B1 example: lot A 25.00 (day 30), lot B 20.00 (no expiry); apply 10 on
  day 10 takes A, apply 10 on day 40 (A expired) takes B and leaves B at 10.00; a running-sum view would have charged A
  twice and overstated the balance. `credit_apply` is `min(balance, invoice balance)`, never partial by amount.
* Spending and reading-then-spending a customer's credit take a transaction advisory lock on the customer
  (`credit:<customerId>`), so two invoices applying at once cannot spend the same lot twice (tested).
* Credit is keyed by `customer_id` (not the client's name as in the design), so two clients with one name never share a
  balance.
