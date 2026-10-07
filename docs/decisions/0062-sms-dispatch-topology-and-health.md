# 0062 Dispatch topology, leader lock and device health consequences
Status: accepted (2026-10-07)

- `SMS_DISPATCH_MODE=jobs|inline|off`. The pg-boss worker runs `sms.dispatch` (a 55 s window ticking every `SMS_TICK_INTERVAL_MS`; pg-boss
  cron is one minute at best, and the design asks for a loop woken by a timer), `sms.reconcile`, `sms.device.healthcheck`,
  `sms.webhooks.register`, `email.send`. `inline` runs the same operations inside the API process (the live-stack harness starts the API
  with `JOBS_ENABLED=false`, so it needs this). A session advisory lock named per operation and database schema keeps two processes
  from running the loop at once; it protects the sliding-window accounting, not message uniqueness (the claim does that).
- The sliding window (30 segments per 30 minutes, 6 reserved for lane 0, env-tunable and overridable per device) is computed from
  `sms_usage`, which stores segments at the time the device accepted or sent them.
- **Health transitions** (`DeviceHealthMonitor`, persisted in `sms_devices`) run their consequences inside the saving transaction:
  `offline` creates a notification and a targeted `sms.device.health` SSE event for every manager, recovery creates a recovery notice, other
  changes are SSE only (no inbox noise for `degraded`). The alert source lists `sms_device_down` for managers and `new_reply` for unread replies.
  "Manager" = an active employee with a login who holds `set.billing` or `sched.override` (the same predicate the Operations board uses for alert 11,
  widened by `sched.override` so Management is woken; Accounting holds `set.billing`).
- A ping carries liveness but does not clear our own failed poll: after an outage the device shows `degraded` until the next successful poll.
- **E-mail fallback** applies to what an email template can carry: a staff invite or password reset that waited five minutes while the
  device was away is e-mailed once (the link is taken from the queued text). Customer-facing P0 texts have no email template: they wait
  and expire by class TTL (a welcome text after 15 minutes), and managers hold the device-down notification.
- The alerts scan job (`appointments.late_scan`) does not know the messaging alert source (the worker never calls
  `configureSchedulingJobs`); messaging publishes `alerts.changed` itself whenever its alerts change.
