# 0042 Lifecycle guards, bay choice and concurrency

Status: accepted (2026-10-06)

- **One transaction per command**: `SELECT ... FOR UPDATE` on the appointment, guard, update with a version bump, activity
  entry, queued message, audit row, ops events. A failure rolls everything back.
- **`advance` requires `expectedStatus`** (review B6): a mismatch is 409 `STALE_STATE` with `meta.currentStatus`, so a stale
  screen, a double click or a swipe cannot skip a state. A completed job has no next step (Collect Payment is an invoice
  command). Permissions are per step (confirm and arrive: `sched.edit` or `jobs.status`; start and complete: `jobs.status`).
- **Bay choice** (`start`): the request `bayId`, else the planned bay if free and active, else the lowest-numbered free active
  bay. Every bay busy: 409 `BAY_BUSY` naming the occupant ("Finish Maria’s vehicle first"); no active bay: `NO_BAY_FREE`; an
  explicit bay in maintenance: `BAY_UNAVAILABLE`. Choosing runs under `pg_advisory_xact_lock(bays:<location>)`, so two cars
  never see the same free bay; `uq_bay_occupied (bay_id) where status = 'cleaning'` is the last guard and its violation maps
  to `BAY_BUSY`.
- **`assign-bay`** (drag): guards in the design's order (already in a bay, busy bay) plus the new ones (job not today, bay not
  active). Booked and confirmed jobs arrive implicitly and both steps are logged.
- **Late is computed** (`now > start + ops.late_grace_min`, booked or confirmed), never stored; it clears on arrive and
  reschedule. **No-show** only after the same moment.
- **Cancel** needs a reason and only applies to booked or confirmed jobs; the invoice is canceled through the gateway. The
  alert "Unconfirmed" action re-sends the reminder instead of confirming (the design's `Send reminder` confirmed).
- **Estimated completion** = cleaning start + duration, floored at now when overrunning (the design used the scheduled
  start).
- **Add-ons**: any status except canceled and no-show; the price is the catalog's at that moment and is snapshotted;
  removing keeps the checklist items hidden (`removed_at`) and re-adding restores them with their marks.
- **Photos**: presigned POST, HEIC rejected, 15 MB, completion HEAD-verifies size and type, soft delete plus object removal
  after commit, a thumbnail job per photo, abandoned uploads removed after 15 minutes.
