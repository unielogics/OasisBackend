# 0092 Retention, store-credit expiry and VIP release

Status: accepted (2026-10-07).

* **`maintenance.purge`** (every 10 minutes) is unchanged: idempotency keys, realtime events (10 minutes), webhook log (90 days).
  **`maintenance.retention`** (daily 03:40) adds sessions (7 days past expiry or revocation), password resets (30 days), messages with
  their outbox rows, the SMS inbox and sent or failed emails (24 months), SMS processed events (90 days), SMS usage (7 days) and VIP
  release markers (7 days). Deletes are batched (5,000 rows, at most 40 batches a run). **The audit log and the ledger are never
  purged.**
* **`photos.retention`** (daily 04:20): the stored objects of deleted photos (including uploads that never completed) are removed and
  then their row (a photo row cannot exist without its key); photos older than 24 months lose their objects and their row. Storage first, row
  second, so a crash repeats a delete of a missing object (a success for both providers) and never orphans an object. If anything could
  not be removed the job fails after finishing the rest, so it retries and then dead-letters.
* **`credit.expire`** (daily 00:10). Expiry is enforced at query time (a lot past `expires_at` is out of the balance and cannot be
  allocated) and the ledger is append-only, so the job writes no ledger row. For each expired `credit_issue` lot it computes the
  unspent remainder (cents minus the FIFO allocations), records the lot once in `credit_expiries` and tells the managers
  (`credit.expired` notification) and the payments channel. A lot that FIFO consumed completely announces nothing. No text goes to the
  customer: the designs have no copy for it.
* **`vip.hold_release_scan`** (every 5 minutes) publishes `availability.changed {date}` when a held slot reaches `start - release hours`
  (elapsed hours, the same arithmetic as the availability engine, with a DST-aware slot start). Each (hold, slot) is announced once
  (`vip_hold_releases`). The engine decides availability at query time, so the event only makes open screens refetch. The waitlist
  offer is not built (P2: no table yet).
* **Not built**: `appointments.no_show_scan`, `ledger.integrity_check`, `notifications.alerts_refresh` (the per-minute alert scan
  already computes that set), `standing.*`, `waitlist.*`, `sqsp.token.refresh`, `sqsp.webhooks.ensure`; see `docs/jobs.md`.
