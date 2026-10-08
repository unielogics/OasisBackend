# 0110 SES feedback: /hooks/ses and the suppression list
Status: accepted (2026-10-08)

Closes review finding 19 (and review B34): bounce and complaint feedback was designed (docs/integrations/ses.md, `ses-events.ts`,
`sns.ts`, `webhook.ts`) but not mounted, and the messaging runtime built its EmailProvider without a suppression check.

* **HTTPS subscription, not SQS.** SES publishes configuration-set events to the SNS topic `oasis-ses-events`; SNS posts them to the
  public `POST /hooks/ses` (a hook module, raw body, the 1 MB webhook body limit). No queue to poll and no extra IAM. The route is public
  on purpose, so everything rests on the SNS signature.
* **Authentication.** SignatureVersion 1 (RSA-SHA1) or 2 (RSA-SHA256) over the documented string to sign; `SigningCertURL` must be https on
  `sns.<region>.amazonaws.com(.cn)` with a `.pem` path, no credentials, no custom port (checked before anything is fetched); certificates
  are fetched without redirects (5 s, 64 KB) and cached per URL in the process; the certificate must be RSA and valid at the injected
  clock. Only topics in `SES_SNS_TOPIC_ARNS` are accepted, and an **empty list refuses every message** (403) instead of meaning "any
  topic". A message older than 3,900 s is refused: SNS caps an HTTP/S retry policy at 3,600 s, so nothing legitimate is older.
* **Replay.** After the signature checks out, the SNS `MessageId` is claimed in `webhook_log` (provider `ses`; unique per provider and id).
  A second delivery is answered 200 `duplicate` and changes nothing; when recording fails the claim is released and the answer is 500, so
  SNS retries (SNS retries 5xx and 429 only). The raw body is not stored (it holds addresses); the suppression row is the record.
* **Subscription confirmation** is followed only for an allow-listed topic, and only when `SubscribeURL` is an SNS
  `Action=ConfirmSubscription` URL naming that same topic (defence in depth on top of the signature). A failed GET answers 502.
* **What is recorded** (one transaction per notification): hard bounces (Permanent, any subtype) and complaints (except `not-spam`) upsert
  `email_suppressions` keyed by the lowercased address: reason `bounce` or `complaint` (a complaint outranks a bounce and never goes back),
  bounce type and subtype, complaint feedback type, diagnostic, first and last seen, a count of distinct SES messages, and the last 20
  SES message ids. They also set `customers.email_bounced_at` (first time only) on every customer with that address, mark the
  `outbox_emails` row (`feedback`, `feedback_at`, `feedback_detail`, matched on `provider_message_id`), write an activity-log line on the
  job a receipt belonged to (`outbox_emails.appointment_id`, set by the payments outbox), and notify the managers once, when the
  address is newly suppressed. Soft bounces and deliveries only annotate the outbox row (`soft_bounce`, `delivered_at`); Reject and the
  other event types are acknowledged and ignored.
* **The list is account-wide, not per location.** SES itself suppresses per account; one address bouncing for one location bounces for
  all. It is the one table without `location_id`, on purpose.
* **Never mailed again.** `MessagingRuntime.emailProvider()` wraps whatever provider it builds (SES, the console driver, or a test
  double) with the suppression check, so a suppressed address never reaches SES. The queued row ends `suppressed` with the reason in
  `error` ("Not sent: j***@example.com is suppressed because it bounced (Permanent / General) on 2026-10-08") and `error_at`. An
  invitation or password reset to a suppressed address is not delivered (the Super Admin who asked still gets the link in the response,
  as for any undelivered link) and every Super Admin receives a notification naming the person; the email fallback of a queued staff
  text does the same.
* **Lifting a suppression** is `DELETE /api/v1/system/email-suppressions/:address` (`set.billing` and `cli.contact`, audited with the
  address masked); the next bounce re-suppresses it. `GET /api/v1/system/email-suppressions` (`set.billing`) lists the active ones,
  addresses masked unless the caller holds `cli.contact`.
* **Not done:** N consecutive soft bounces do not suppress (SES already retries a soft bounce for hours); `customers.email_bounced_at` is
  not cleared when staff change a customer's address (the customers module owns that write; the suppression check is by address, so a new
  address is mailed regardless).
