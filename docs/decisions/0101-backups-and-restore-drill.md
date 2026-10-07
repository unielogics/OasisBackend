# 0101 Backups: snapshot-consistent dumps, manifest, retention, encrypted off-host copy, restore drill
Status: accepted (2026-10-07)

* **One exported snapshot for the dump and the counts.** `backup.sh` opens a `REPEATABLE READ` session, exports its snapshot, runs
  `pg_dump --snapshot`, and counts every table in that same session. The manifest therefore holds exactly the rows in the dump while
  the application keeps writing, and the drill can compare for equality instead of tolerating drift. (Tested with a row committed
  between the snapshot and the dump.)
* **Retention is grandfather-father-son with hard links:** 7 nightly, the Sunday one for 4 weeks, the first-of-month one for 12 months.
  Hard links make a week or month copy free and independent of the daily prune. `pre-deploy`, `pre-rotate` and `manual` backups are
  kept apart (5 each) so a busy deploy day cannot push the nightly ones out.
* **Custom format, not plain SQL**, with a SHA-256 sidecar and a manifest (counts, applied migrations, release, server version). Custom
  format restores selectively and in parallel and `pg_restore --list` proves the archive is readable at backup time.
* **The off-host copy is encrypted before it leaves the host** with AES-256-GCM (`deploy/lib/backup-crypt.mjs`, Node's crypto, no extra
  package): the authentication tag covers the whole file, so truncation or tampering fails to decrypt rather than producing a damaged
  dump. S3 server-side encryption is added on top; an unencrypted upload is allowed but warned about.
* **A backup that has never been restored is a hope.** `restore-drill.sh` restores the newest backup into a scratch database (role
  `oasis_drill`, which can create databases and nothing else) monthly, and checks: checksum, `pg_restore --exit-on-error`, row counts
  against the manifest, migration count, and the ledger invariants recomputed from raw `ledger_events` against `invoice_calc`
  (paid, refunded, balance rule, unique sequence, orphaned events, the append-only trigger). `--mode schema` does the same inside a
  scratch schema for hosts where a database cannot be created, which is how the test suite runs it.
* **`ledger-check.sh` is the same set of checks, read-only, against the live database,** so an operator investigating a mismatch runs
  exactly what the drill runs. The invariants live in one file (`deploy/lib/ledger-checks.sh`).
* **After a restore, texts must not go out twice.** The restored outbox still holds messages as pending that were sent after the backup.
  The runbook starts the API with `SMS_DISPATCH_MODE=off`, cancels what was already sent, then re-enables dispatch. Point-in-time
  recovery (WAL archiving) is not provided; the recovery point is the last backup, at most a day old.
