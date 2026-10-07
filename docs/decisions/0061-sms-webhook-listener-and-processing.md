# 0061 The SMS Gate webhook: second listener, persist then apply, one transaction per event
Status: accepted (2026-10-07)

- The route exists only on a second Fastify instance bound to `HOOKS_HOST:HOOKS_PORT` (default 127.0.0.1:3002) that `src/server.ts` starts
  next to the public listener; the public app registers nothing under `/hooks/smsgate` and answers 404 (both tested). `tailscale serve`
  fronts the hooks port; nothing about the path is reachable from the internet.
- The device row is found by the URL's `deviceKey`; the signature is checked against **that device's** secret over the raw bytes
  (24 h tolerance: the app retries for about two days). Failures are not stored (an unauthenticated caller must not be able to fill a table).
- A verified envelope is inserted into `webhook_log` (unique per envelope id) and answered 200; applying it runs after the answer,
  in one transaction: envelope marker (`sms_processed_events`), outbox and message state, the inbound router with its effects (opt-out
  tables, the scheduling confirm command, replies through the queue, staff alerts), and device health. A failure rolls everything
  back, leaves the row `received`, and the 30 s sweep retries it (abandoned after 24 h). A repeat of an applied envelope answers 200.
- The envelope's `deviceId` is the tablet's own id; it is stored as `remote_device_id` and replaced by our device uuid before ingest.
- **One reply per text.** A customer's "C" confirms through the scheduling `confirmAppointment` command, whose "confirmed" text is
  re-keyed to the router's `confirm_ack` reply with the same dedupe key, so the customer receives one text, not two.
- A simulated device (`provider: sim`) emits its signed webhooks to the same handler in-process, so verification and persistence are
  exercised exactly as for the tablet; the HTTP simulator server is tested over a real socket.
