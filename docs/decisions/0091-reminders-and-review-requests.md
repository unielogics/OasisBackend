# 0091 Reminders and review requests

Status: accepted (2026-10-07).

* **`appointments.reminders`** runs every 5 minutes. For a booked or confirmed appointment and each offset of settings
  `reminders.offsets_min` (default 1440 and 120) it queues one SMS when the moment `start - offset` has arrived and is less than an
  hour old. A booked (unconfirmed) appointment gets the `confirm_request` text ("Reply C to confirm"); a confirmed one the
  `reminder` text. If several offsets are due at once only the closest is sent.
* **Offsets are elapsed time.** "24 h before" is `start - 1440 minutes`, so for a 09:00 EDT visit on 2027-03-14 it is 08:00 EST the day
  before. The words ("tomorrow at 9:00 AM") come from business calendar dates, not from adding 24 hours to now: the existing
  `formatWhen` helper does the latter and mislabels a visit two days away as "tomorrow" within an hour of midnight on 2027-03-13.
  (Not changed here: it belongs to messaging; the job uses calendar dates.)
* **Never twice.** The message carries the idempotency key `reminder:<appointment>:<offset>:<start>` (messages has a unique index), each
  appointment is processed in its own transaction under a row lock, and the status is re-checked under the lock, so a cancel that
  commits first wins and a crash after the commit repeats nothing (`test/jobs/kill.test.ts` kills the worker with SIGKILL after the
  effect). A reschedule changes the start, so the new time gets its own reminders.
* **Not for a booking made inside the window**: a reminder is skipped when the appointment was created after its moment (the booking
  text and the confirmation already went out).
* **Class**: `confirm_request` and `reminder` are automated, not transactional, so quiet hours hold them (review B13). The lead's
  brief said "transactional class"; the messaging module's registry and the binding review say otherwise and were followed.
* **Quiet hours never push a reminder past the visit.** The held text gets its full TTL from the release moment, so a 2 h reminder
  for a 07:30 visit (due 05:30, held to 08:00) would arrive after the car was in the bay. The job drops a reminder whose release is
  less than 10 minutes before the start and gives the others a TTL that ends at the start.
* **`appointments.review_request`** runs every 10 minutes, only when settings `reviews.enabled` is on (default off), 2 h after
  `completed_at` and for up to 24 h, once per appointment (`review:<appointment>`). The star in the copy is stripped on send.
