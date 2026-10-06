# 0031 Emergency closing over HTTP

Status: accepted (2026-10-06)

- **"Rest of today" after closing** (review B38) is 422 `EMERGENCY_NOTHING_TO_CLOSE`, checked in the command layer
  (`assertTodayClosable`) because `closeShop` itself falls back to the end of the day. It applies when today is closed (planned
  closure or day off) or now is at or after the closing time; before opening it is allowed. An already active emergency answers
  409 first. Preview applies the same check.
- **Auto-reopen.** `POST /emergency/close` enqueues `emergency.auto_reopen` (pg-boss delayed to `ends_at`, `singletonKey` = the
  emergency id, data carries the id so a job from a rolled-back or superseded close does nothing) from inside the close
  transaction; an enqueue failure is logged and never fails the close. `emergency.sweep` (hourly and at startup) reopens any
  active emergency whose end time passed. Both go through `reopenIfDue`, which re-checks under the advisory lock.
- **Events.** The service publishes `emergency.started` and `emergency.ended` on `ops`; the design lists `emergency.reopened`.
  `reopenCommand` (route and jobs) publishes `emergency.reopened` as well, so a consumer of either name works. Dropping
  `emergency.ended` means editing `src/modules/settings/emergency.ts` and its test in a later pass.
- **Days already over stay closed.** Reopen soft-deletes emergency closure rows dated today or later and restores the planned
  closures they replaced; earlier days of a multi-day closure remain as the record that the shop was closed.
- **No contact data in lists.** Preview, affected and needs-rebooking rows carry name, vehicle, time, date and status only.
- **Idle strip.** `strip.text` is composed on the server from live counts with singular and plural fixed (`1 appointment`,
  `1 vehicle`), `Closed now` outside the open window and `Closed today · {reason}` on a closed day. `closeRoleNames` come from
  `role_permissions` (plus the locked role), Management first and Super Admin last, as the design words it.
- **Crew alert.** "Alert on-shift crew" inserts a `notifications` row and a targeted `notification.new` event for each active
  employee with a login whose schedule covers now (start inclusive, end exclusive). "Protect member credits" needs Memberships
  and is left as an unset port.
