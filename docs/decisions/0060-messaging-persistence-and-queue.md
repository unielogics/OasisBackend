# 0060 Messaging persistence: one outbox, caller-transaction enqueue, atomic claim
Status: accepted (2026-10-07)

Tables (migration `20261006200000_messaging.sql`): `sms_devices`, `message_threads` (one per customer), `messages`, `sms_outbox`,
`sms_usage` (the send window), `sms_processed_events`, `sms_inbox`, `sms_opt_outs`, `outbox_emails`. `emergency_notifications.message_id`
and `payment_links.sent_message_id` now carry foreign keys to `messages`.

- **Enqueue happens in the caller's transaction** (`DbMessageQueue`, the scheduling `MessageQueue` port and the equivalents for payments,
  settings and people). The message row, the outbox row, the thread and the `message.out` event commit or roll back with the booking.
  The pure `planEnqueue` (policy gate, GSM-7, STOP footer, segments, hold, TTL) is shared with the in-memory dispatcher.
- **A refused text is not persisted.** The caller gets `skipped` and writes its own activity line. Persisting every suppressed
  automation as a failed bubble (the first draft of smsgate.md section 6) would put a "failed" text in the thread of every walk-in
  who never opted in. Staff sends refuse with 422 instead.
- **The outbox row and the message share one uuid** (`sms_outbox.id = messages.id` = the SMS Gate message id of the first attempt).
  Every outbox update runs in a transaction that mirrors the state onto the message (`queued/sending/sent/delivered/failed/canceled/expired`;
  outbox `accepted` and `sent` both read as `sent`), publishes `message.status`, counts the device's totals, and follows
  `emergency_notifications.state`.
- **Claim is one UPDATE** guarded by `FOR UPDATE SKIP LOCKED`; the claim also pins the message to the claiming device, so a second
  device is configuration only. A webhook event locks the outbox row (`FOR UPDATE`) before deciding, and a late `accepted` never moves a
  message backwards: sent and delivered envelopes arrive together and, unlocked, overwrote each other (the concurrency test fails without it).
- **Sensitive classes** (`staff_invite`, `password_reset`) keep a redacted body on the message, never publish `message.out`, and lose
  the live link from `sms_outbox` as soon as the message is final (or six hours after `sent`, for carriers that send no receipts).
  `outbox_emails` wipes its variables the same way.
- **Device credentials and the webhook secret** are AES-256-GCM encrypted with `SECRETS_KEY` (`src/modules/messaging/crypto.ts`), lazily,
  so an app that never stores a credential boots without the key. The API returns only `hasPassword`; the signing secret is returned once on creation.
- **Inbound** is `sms_inbox` unique on `(device_id, provider_message_id)`; unknown senders are flagged `quarantined` and never become
  customers (B14). STOP/START by number update `sms_opt_outs` and the customer rows that carry the number in the same transaction.
