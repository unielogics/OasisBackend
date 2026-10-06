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

Existing contract (`src/config/env.ts`): `EMAIL_PROVIDER`, `AWS_REGION`, `SES_FROM_ADDRESS` (required for `ses`).

New, exported as `emailEnvShape` for the integrator to spread into `envSchema` (not edited here):

| Variable | Default | Meaning |
|---|---|---|
| `SES_FROM_NAME` | `Oasis Auto Spa` | Display name in `From`. |
| `SES_REPLY_TO` | unset | Default `Reply-To`; a request's `replyTo` wins. |
| `SES_CONFIGURATION_SET` | unset | Configuration set attached to every send (needed for event publishing). |
| `SES_SNS_TOPIC_ARNS` | empty | Comma-separated SNS topic ARNs `/hooks/ses` accepts (`sesTopicArns(env)` parses it). Must be non-empty in production. |
| `EMAIL_CONSOLE_DIR` | `./.data/mail` | Where the sim driver writes `.eml` files. |

## One-time AWS setup

Everything below is per region; use the region in `AWS_REGION`.

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
   aws sesv2 create-configuration-set --configuration-set-name oasis-prod
   aws sns create-topic --name oasis-ses-feedback          # Standard topic; SES does not support FIFO
   aws sesv2 create-configuration-set-event-destination \
     --configuration-set-name oasis-prod --event-destination-name sns-feedback \
     --event-destination '{"Enabled":true,"MatchingEventTypes":["BOUNCE","COMPLAINT","DELIVERY"],"SnsDestination":{"TopicArn":"arn:aws:sns:<region>:<acct>:oasis-ses-feedback"}}'
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
       "Resource": "arn:aws:sns:<region>:<acct>:oasis-ses-feedback",
       "Condition": { "StringEquals": {
         "AWS:SourceAccount": "<acct>",
         "AWS:SourceArn": "arn:aws:ses:<region>:<acct>:configuration-set/oasis-prod"
       } }
     }]
   }
   ```
   Set `SES_CONFIGURATION_SET=oasis-prod` and `SES_SNS_TOPIC_ARNS=arn:aws:sns:<region>:<acct>:oasis-ses-feedback`.
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
           "arn:aws:ses:<region>:<acct>:configuration-set/oasis-prod"
         ],
         "Condition": { "StringEquals": { "ses:FromAddress": "no-reply@oasisautospa.example" } }
       },
       {
         "Sid": "ReadFeedbackQueue",
         "Effect": "Allow",
         "Action": ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"],
         "Resource": "arn:aws:sqs:<region>:<acct>:oasis-ses-feedback"
       }
     ]
   }
   ```
   Drop the second statement for the HTTPS path. While in the sandbox the identity ARN list must also cover the verified recipient identities if you restrict `Resource` that tightly (or use `*` for the sandbox period). The SDK needs no other SES permission.

## Mounting the webhook

```ts
const verifier = new SnsVerifier({ clock, allowedTopicArns: sesTopicArns(env), maxAgeSec: 3600 })
const handle = createSesWebhookHandler({
  verifier,
  onDecisions: async (decisions) => { /* persist, see below */ },
})
// SNS posts JSON with content-type text/plain; Fastify's built-in text/plain parser already yields the raw string.
app.post('/hooks/ses', async (req, rep) => { const r = await handle(req.body as string); rep.code(r.status).send(r.body) })
```

Status codes: 200 handled or ignored, 400 malformed, 403 signature/topic/certificate-URL rejected, 503 or 502 or 500 for transient trouble so SNS retries (certificate unreachable, confirmation GET failed, persistence failed). The route is public and must skip session auth and CSRF.

Verification follows the AWS SNS documentation: certificate URL must be `https://sns.<region>.amazonaws.com(.cn)/....pem` (no credentials, no custom port); the string to sign is the byte-sorted `Name\nValue\n` list (`Message, MessageId, Subject (only if present), Timestamp, TopicArn, Type`; confirmations use `Message, MessageId, SubscribeURL, Timestamp, Token, TopicArn, Type`); SignatureVersion 1 is RSA-SHA1 and 2 is RSA-SHA256; the signing certificate must be RSA and within its validity window per the injected `Clock`; the topic must be on the allow-list. The certificate is fetched through an injectable `fetchCertificate` (default: `fetch` with 5 s timeout, no redirects, 64 KB cap) and cached per URL. The signature is the authentication; TLS to `sns.*.amazonaws.com` provides the transport trust for the certificate download.

## Bounce, complaint and delivery decisions (pure)

`decideFromNotification(message)` returns one decision per recipient:

| SES event | Decision | Intended effect |
|---|---|---|
| Bounce `Permanent` (any subtype) | `suppress` / `hard_bounce` | Add to the suppression list, set `customers.email_bounced_at`, fall back to SMS. |
| Bounce `Transient` or `Undetermined` | `soft_bounce` | Record only. The caller may suppress after N consecutive soft bounces. |
| Complaint (except feedback type `not-spam`) | `suppress` / `complaint` | Suppress; most ISPs strip the complainer, so every listed recipient is suppressed. |
| Delivery | `delivered` | Mark `outbox_emails` delivered by `messageId` (= `ses_message_id`). |
| Anything else (Send, Open, Click, DeliveryDelay, Reject, ...) | none | Ignored. |

Each decision carries `address` (lowercased), `messageId`, `feedbackId`, the SES timestamp, bounce type/subtype and diagnostic. Wire the suppression list into sending with `createEmailProvider(env, { isSuppressed })`; a suppressed recipient raises `EmailError('SUPPRESSED')` before SES is called. SES also keeps its own account-level suppression list; ours is additional and also drives the choice to fall back to SMS.

## Errors

`EmailError.code`: `UNKNOWN_TEMPLATE`, `MISSING_VAR`, `UNKNOWN_VAR`, `INVALID_VAR`, `INVALID_ADDRESS`, `SUPPRESSED`, `PROVIDER_REJECTED` (not retryable: unverified identity, sandbox recipient, suspended account), `PROVIDER_UNAVAILABLE` (retryable: throttling, 5xx, network). Retry only when `error.retryable` is true. The SDK already retries throttling a few times internally.

## Verified against AWS documentation, and what is not

Verified (docs read while building this): SNS signature string-to-sign and cert URL rules; SES notification and event JSON shape (`notificationType` vs `eventType`, bounce types and subtypes, complaint feedback types); sandbox limits (200 per 24 h, 1 per second, verified recipients only) and the production-access request; Easy DKIM 2048-bit default; `ses:SendEmail` plus identity and configuration-set resources; SNS topic policy for SES.

Not verified against a live account (no credentials): the exact `AccessDenied` behaviour when only the identity ARN is listed and a configuration set is used (the policy above lists both); SES custom MAIL FROM record values (use the ones the console shows); real SNS delivery to `/hooks/ses` (covered here by locally signed fixtures). A gated live smoke test (one email to the verified inbox, one `bounce@simulator.amazonses.com` round trip) belongs to milestone M6.
