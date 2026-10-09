# Email: AWS SES (and the console simulator)

Code: `src/integrations/email/`. Port: `EmailProvider.send({ to, template, vars, subject?, replyTo? })`.
Drivers are chosen by `EMAIL_PROVIDER=sim|ses` through `createEmailProvider(env, deps)`.

| Driver | Use | Behaviour |
|---|---|---|
| `sim` (`ConsoleProvider`) | dev, tests, parity | Renders exactly what SES would send, writes a multipart `.eml` to `EMAIL_CONSOLE_DIR` (default `./.data/mail`), keeps an in-memory mailbox (`provider.mailbox`, `last()`, `to(addr)`), and calls an optional `onSend(mail)` hook so the app can also persist to `outbox_emails` for the `/dev/mail` page. Delivers nothing. Open the `.eml` files in any mail client. |
| `ses` (`SesProvider`) | live | One SESv2 `SendEmail` per message: `FromEmailAddress`, `Destination.ToAddresses`, optional `ReplyToAddresses` and `ConfigurationSetName`, `Content.Simple` with a UTF-8 subject plus text and HTML parts, and an `EmailTags` entry `template=<key>`. Credentials come from the default AWS SDK chain (instance profile on EC2); nothing in this repo reads credentials or probes instance metadata. |

## Templates

`receipt`, `staff_invite`, `password_reset`, `device_alert`, `closure_notice` (`templateKeys`). Every template declares its variables; `renderTemplate` rejects unknown templates, unknown or missing variables, non-integer cents, and non-http(s) URLs. All values are control-character stripped, single-line values lose newlines, and the subject can never contain CR/LF. HTML is built from one content model, so escaping happens in exactly one place; the HTML is self-contained (inline styles, system fonts, no images, no stylesheets, no remote assets). The only external reference is a link the caller passes in.

Receipt line items travel in one variable; build it with `encodeReceiptItems([{ description, cents }])`. Money variables are integer cents (`subtotalCents`, `taxCents`, `tipCents`, `totalCents`, `paidCents`, `balanceCents`) and are formatted by the template. Receipt copy says nothing about the card processor beyond the optional `paymentSummary` text the caller supplies. SMS-opted-out customers get the email only; the SMS summary is a separate `receipt` SMS template.

## Environment variables

All declared in `src/config/env.ts` (the email shape lives in `src/integrations/email/env.ts` and is spread into `envSchema`):

| Variable | Default | Meaning |
|---|---|---|
| `EMAIL_PROVIDER` | `sim` | `ses` sends through Amazon SES. |
| `AWS_REGION` | `us-east-1` | Region of SES (and S3, SNS). |
| `SES_FROM_ADDRESS` | unset | Sender on a verified identity. Required for `ses`. |
| `SES_FROM_NAME` | `Oasis Auto Spa` | Display name in `From`. |
| `SES_REPLY_TO` | unset | Default `Reply-To`; a request's `replyTo` wins. |
| `SES_CONFIGURATION_SET` | unset | Configuration set attached to every send (publishes the feedback events). `pnpm aws:provision` creates `oasis-mail`. |
| `SES_SNS_TOPIC_ARNS` | empty | Comma-separated SNS topic ARNs `/hooks/ses` accepts. **Empty refuses every notification.** |
| `SES_ENDPOINT` | unset | SESv2 endpoint override for the AWS simulator (`scripts/verify-live/sim-aws.ts`) only. |
| `EMAIL_CONSOLE_DIR` | `./.data/mail` | Where the sim driver writes `.eml` files. |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | unset | A key in the environment (development; read by the AWS SDK; declared so the pair is validated and `GET /system/integrations` can name the source). Production uses the instance role, or the `oasis-app` key file (next row); ADR 0133. |
| `AWS_SHARED_CREDENTIALS_FILE` | unset | runtime=user: the `oasis-app` key in `/etc/oasis/aws-credentials`, handed to the services by systemd (the units set this). |
| `AWS_EC2_METADATA_DISABLED` | `false` | `true` keeps the SDK away from instance metadata; set with keys or a key file, never with the instance role. |

`GET /api/v1/system/integrations` (`set.billing`) reports for `email`: provider, whether it is configured, exactly which of these are
missing, the last send, the last error (masked), the last feedback received and the number of suppressed addresses.

## One-time AWS setup

**Use `pnpm aws:provision` ([../aws-setup.md](../aws-setup.md))**: it creates the identity, the configuration set `oasis-mail`, the
topic `oasis-ses-events` with its policy and the HTTPS subscription (all only once `--sender` is given; email comes last), and the
app's identity and policy, plan first and idempotently.
The manual steps below explain what it does (the names in them are examples). Everything is per region; use `AWS_REGION`.

1. **Verify the sending domain with Easy DKIM** (preferred over a single address; it also speeds up production access).
   - Console: SES, Configuration, Identities, Create identity, Domain, leave Easy DKIM with RSA_2048_BIT.
   - CLI: `aws sesv2 create-email-identity --email-identity oasisautospa.example` and read `DkimAttributes.Tokens`.
   - In DNS add the three CNAMEs SES shows: `<token>._domainkey.<domain>` pointing at `<token>.dkim.amazonses.com`. Status turns `SUCCESS` when SES sees them (minutes to a few hours).
   - Recommended: a custom MAIL FROM subdomain (MX plus SPF TXT records SES lists) and a DMARC TXT record (`_dmarc.<domain>`, start with `p=none` and an `rua=` mailbox) so SPF and DKIM align with the From domain.
   - `SES_FROM_ADDRESS` must be an address on the verified domain (or itself a verified identity).
2. **Sandbox.** A new account is in the sandbox per region: you may only send to verified addresses/domains or the mailbox simulator, at most 200 messages per 24 hours and 1 per second. While in the sandbox, verify each tester's address (`aws sesv2 create-email-identity --email-identity you@example.com`, then click the link). Ask for production access early (AWS replies within about 24 hours, longer if they need more detail):
   `aws sesv2 put-account-details --production-access-enabled --mail-type TRANSACTIONAL --website-url https://<site> --additional-contact-email-addresses <ops@...> --contact-language EN`
   (or Console, Account dashboard, Request production access). Describe the use case as one-to-one transactional mail (receipts, staff invitations, password resets, alerts) and state that bounces and complaints are processed automatically.
   Test without risk using `success@simulator.amazonses.com`, `bounce@simulator.amazonses.com` and `complaint@simulator.amazonses.com`; these work in the sandbox and do not count toward bounce rates.
3. **Configuration set and feedback topic.**
   ```
   aws sesv2 create-configuration-set --configuration-set-name oasis-mail
   aws sns create-topic --name oasis-ses-events          # Standard topic; SES does not support FIFO
   aws sesv2 create-configuration-set-event-destination \
     --configuration-set-name oasis-mail --event-destination-name oasis-sns-events \
     --event-destination '{"Enabled":true,"MatchingEventTypes":["BOUNCE","COMPLAINT","DELIVERY","REJECT"],"SnsDestination":{"TopicArn":"arn:aws:sns:<region>:<acct>:oasis-ses-events"}}'
   ```
   Topic access policy so SES may publish (replace the placeholders):
   ```json
   {
     "Version": "2012-10-17",
     "Id": "ses-publish",
     "Statement": [{
       "Effect": "Allow",
       "Principal": { "Service": "ses.amazonaws.com" },
       "Action": "sns:Publish",
       "Resource": "arn:aws:sns:<region>:<acct>:oasis-ses-events",
       "Condition": { "StringEquals": {
         "AWS:SourceAccount": "<acct>",
         "AWS:SourceArn": "arn:aws:ses:<region>:<acct>:configuration-set/oasis-mail"
       } }
     }]
   }
   ```
   Set `SES_CONFIGURATION_SET=oasis-mail` and `SES_SNS_TOPIC_ARNS=arn:aws:sns:<region>:<acct>:oasis-ses-events`.
   The parser accepts both payload shapes: configuration-set events (`eventType`) and identity feedback notifications (`notificationType`).
4. **Subscribe the app to the topic. Pick one.**
   - **HTTPS (default, needs a public endpoint).** `aws sns subscribe --topic-arn <arn> --protocol https --notification-endpoint https://<public-api-domain>/hooks/ses`. The app answers the `SubscriptionConfirmation` itself (signature verified, SubscribeURL host checked, then fetched). This route must be reachable by AWS, so it lives on the public API domain, not on the tailnet (the SMS Gate webhooks are the tailnet-only ones).
   - **SQS (no inbound endpoint).** Create a queue, allow `sns.amazonaws.com` to `sqs:SendMessage` from the topic ARN, `aws sns subscribe --protocol sqs --notification-endpoint <queue-arn>`, then poll from a job and pass each message body to `decisionsFromQueueBody(body)`. Both the default envelope and raw message delivery are handled. The queue policy is the trust boundary, so no signature check is needed (pass a `verifier` to also check wrapped envelopes).
5. **IAM** for the app role (EC2 instance profile) or user. Minimal policy for sending, plus optional SQS receive for the SQS path:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Sid": "SendFromVerifiedDomain",
         "Effect": "Allow",
         "Action": "ses:SendEmail",
         "Resource": [
           "arn:aws:ses:<region>:<acct>:identity/oasisautospa.example",
           "arn:aws:ses:<region>:<acct>:configuration-set/oasis-mail"
         ],
         "Condition": { "StringEquals": { "ses:FromAddress": "no-reply@oasisautospa.example" } }
       },
       {
         "Sid": "ReadFeedbackQueue",
         "Effect": "Allow",
         "Action": ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"],
         "Resource": "arn:aws:sqs:<region>:<acct>:oasis-ses-events"
       }
     ]
   }
   ```
   Drop the second statement for the HTTPS path. While in the sandbox the identity ARN list must also cover the verified recipient identities if you restrict `Resource` that tightly (or use `*` for the sandbox period). The SDK needs no other SES permission.

## The webhook (mounted)

`POST /hooks/ses` is the hook module `src/modules/messaging/email/hook.ts` (registered in `src/http/modules.ts`, ADR 0110). It takes the
raw body (SNS posts JSON as `text/plain`), at most 1 MB, and needs no session, CSRF token or Idempotency-Key.

| Situation | Answer |
|---|---|
| `SES_SNS_TOPIC_ARNS` empty | 403, nothing parsed |
| not JSON, or not an SNS envelope | 400 |
| topic not on the list, certificate URL not `https://sns.<region>.amazonaws.com/...pem`, bad signature, certificate not RSA or outside its validity, message older than 3,900 s | 403, nothing recorded |
| certificate download failed | 503 (SNS retries) |
| `SubscriptionConfirmation` for an allowed topic whose `SubscribeURL` is an SNS `ConfirmSubscription` URL for that topic | the URL is fetched, 200 (502 when the GET fails) |
| a `Notification` whose `MessageId` was handled before | 200 `duplicate`, nothing changes |
| a bounce, complaint or delivery | recorded in one transaction, 200 `recorded N`; 500 when recording fails (the claim is released so the retry is processed) |
| any other SES event (Reject, Send, Open, ...) or a non-SES message | 200, ignored |

What is recorded: hard bounces and complaints upsert `email_suppressions` (address, reason, bounce type and subtype, first and last seen,
count, source message ids) and set `customers.email_bounced_at`; the `outbox_emails` row gets `feedback` and `feedback_detail` (or
`delivered_at`); a bounced receipt leaves a line in its job's activity log; a newly suppressed address notifies the managers. The
messaging runtime checks the list before every send: a receipt to a suppressed address ends `suppressed` with the reason in `error`, and
an invitation or password reset notifies every Super Admin. `GET /api/v1/system/email-suppressions` lists the list and
`DELETE /api/v1/system/email-suppressions/:address` lifts one entry (audited).

## Bounce, complaint and delivery decisions (pure)

`decideFromNotification(message)` returns one decision per recipient:

| SES event | Decision | Intended effect |
|---|---|---|
| Bounce `Permanent` (any subtype) | `suppress` / `hard_bounce` | Add to the suppression list, set `customers.email_bounced_at`, fall back to SMS. |
| Bounce `Transient` or `Undetermined` | `soft_bounce` | Record only. The caller may suppress after N consecutive soft bounces. |
| Complaint (except feedback type `not-spam`) | `suppress` / `complaint` | Suppress; most ISPs strip the complainer, so every listed recipient is suppressed. |
| Delivery | `delivered` | Mark `outbox_emails` delivered by `messageId` (= `ses_message_id`). |
| Anything else (Send, Open, Click, DeliveryDelay, Reject, ...) | none | Ignored. |

Each decision carries `address` (lowercased), `messageId`, `feedbackId`, the SES timestamp, bounce type/subtype and diagnostic. The messaging runtime wraps its provider with the suppression check (`withSuppression`); a suppressed recipient raises `EmailError('SUPPRESSED')` with the reason before SES is called. SES also keeps its own account-level suppression list; ours is additional and also drives the choice to fall back to SMS.

## Errors

`EmailError.code`: `UNKNOWN_TEMPLATE`, `MISSING_VAR`, `UNKNOWN_VAR`, `INVALID_VAR`, `INVALID_ADDRESS`, `SUPPRESSED`, `PROVIDER_REJECTED` (not retryable: unverified identity, sandbox recipient, suspended account), `PROVIDER_UNAVAILABLE` (retryable: throttling, 5xx, network). Retry only when `error.retryable` is true. The SDK already retries throttling a few times internally.

## Verified against AWS documentation, and what is not

Verified (docs read while building this): SNS signature string-to-sign and cert URL rules; SES notification and event JSON shape (`notificationType` vs `eventType`, bounce types and subtypes, complaint feedback types); sandbox limits (200 per 24 h, 1 per second, verified recipients only) and the production-access request; Easy DKIM 2048-bit default; `ses:SendEmail` plus identity and configuration-set resources; SNS topic policy for SES.

Verified locally: `/hooks/ses` on the real app and Postgres with notifications signed by a certificate from a test CA (test/aws/ses-feedback.test.ts), and the whole path (invite, reset, receipt through SES, bounce, suppressed next receipt) through the spawned `src/server.ts` and `src/worker.ts` against the AWS simulator (test/aws/sim-e2e.test.ts).

Not verified against a live account (no credentials): the exact `AccessDenied` behaviour when only the identity ARN is listed and a configuration set is used (the policy lists both); whether `ses:FromAddress` matches a From header with a display name (pnpm verify:aws --send exercises exactly that format); SES custom MAIL FROM record values; real SNS delivery to `/hooks/ses`. docs/aws-setup.md step 9 is the live check (one email, one `bounce@simulator.amazonses.com` round trip).
