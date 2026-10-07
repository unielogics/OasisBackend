# Live verification

Three commands that prove the real thing works, one per integration. Each walks the checklist that is already written in
`docs/integrations/` (the numbered items you will see in the output), tells you PASS, FAIL or SKIP for every item with the reason, and
writes a report you can keep or send to someone.

| Check | Proves | Needs from you |
|---|---|---|
| `pnpm verify:smsgate` | the tablet sends and receives texts, receipts come back, STOP/START/HELP/C work | the tablet set up (below), its address and login, a phone to text |
| `pnpm verify:squarespace` | the API key works, what orders and payments look like, which products are memberships | a read-only API key |
| `pnpm verify:aws` | SES sends mail from your address, the photo bucket accepts uploads, nothing is missing from the permissions | an AWS login or an instance role, a verified sender, a bucket |
| `pnpm verify:all` | all three in a row, one summary | all of the above |

## How to run them

On the server, from the deployed release (the wrapper loads `/etc/oasis/common.env`, runs as the `oasis` user, and keeps the reports in
`/var/lib/oasis/live-verification`):

```bash
D=/opt/oasis/current/backend/deploy/scripts
sudo $D/verify.sh smsgate                  # read-only
sudo $D/verify.sh squarespace --days 90
sudo $D/verify.sh aws --instance-profile
```

Or by hand in a checkout: `pnpm verify:smsgate` with the variables in the environment. Reports go to `docs/live-verification/` (ignored by
git).

**They are safe by default.** Without `--send` they only read: they look at the device, the Squarespace account and your AWS settings
and change nothing. The only things that ever send or write, each behind its own flag, are: texts to the number you give with
`--send --to` (smsgate); one email to the address you give and one tiny test file in the bucket that is deleted a second later
(aws, `--send --to`); one signed test message to your own webhook URL (squarespace, `--post-webhook`); and temporary webhook
registrations on the tablet that are removed again (smsgate, `--register-webhooks`). The SMS check talks to the tablet directly, not through Oasis's queue, so it ignores quiet hours, opt-outs and `SMS_ALLOWLIST`: give it only
your own number. Passwords, keys and the phone number or email you
give never appear in the output or the reports (the number shows as `+13***0100`).

**What the output means.** Each line is `PASS`, `FAIL` or `SKIP`, then the item number, then what it checks and what was seen. A `FAIL` is
followed by a `fix:` line. A `SKIP` always says why (usually "pass --send" or "needs a person"): it is never a silent pass. The last line
is the count. The exit code is 0 when nothing failed, 1 when something did, and **2 when it could not start**: it then lists exactly which
environment variables or settings are missing and sends nothing.

**Rehearse without hardware.** `--sim` runs the whole check against built-in simulators (the tablet on port 4591, Squarespace on 4590,
AWS on 4592) and plays the part of the person too, so you can see what a good run looks like before you have the real thing. A simulator
run proves the script, not your tablet or account, and the report says so at the top.

---

## SMS Gate: the tablet

### What to prepare

1. A tablet or phone **with a SIM that can send and receive text messages** (not Wi-Fi only; some data-only plans cannot send SMS), Android
   8 or later, kept on a charger.
2. Install **SMS Gate** from the Play Store, F-Droid or the project's GitHub releases, and allow SMS, phone and notifications.
3. In the app turn **Local Server** on (port 8080) and press the button to start it. The screen shows a **username and password**: write them down.
4. Settings, Webhooks: set a **signing key** of your own (any long random text; `$D/gen-secrets.sh SMSGATE_WEBHOOK_SECRET` makes one). Write it down.
5. Settings, Messages: processing order **FIFO**. Settings, Ping: **60 seconds**.
6. Battery: set SMS Gate and Tailscale to **Unrestricted**, turn off adaptive battery and anything that "puts unused apps to sleep".
7. In the Messages app, switch **chat features / RCS off** for this SIM, or some phones' replies never arrive as texts.
8. Install **Tailscale** on the tablet, sign in to the same Tailscale account as the server, switch **Always-on VPN** on, and note the tablet's
   `100.x.y.z` address. In the Tailscale admin console: HTTPS certificates and MagicDNS on, key expiry off for the tablet and the server.
9. On the server: `SMSGATE_DEVICE_URL=http://100.x.y.z:8080`, `SMSGATE_USERNAME`, `SMSGATE_PASSWORD`, `SMSGATE_WEBHOOK_SECRET` (the signing key)
   in `/etc/oasis/common.env`, and `sudo deploy/scripts/tailscale-serve.sh` for the webhook address ([runbook.md](runbook.md), section 6).

### Commands

```bash
D=/opt/oasis/current/backend/deploy/scripts
sudo $D/verify.sh smsgate                                       # reads only: health, login, the seven webhooks, the mount from this host
sudo $D/verify.sh smsgate --send --to +13055550100 --watch      # also: two texts, and the receipts arriving live
sudo $D/verify.sh smsgate --send --to +13055550100 --watch --replies --multipart
```

`--watch` listens for the tablet's webhooks as they arrive and shows each one. The API normally owns the port they arrive on, so the
check follows the API's own log of them instead (it needs `DATABASE_URL`, which `verify.sh` provides): that proves the whole route
(tablet, Tailscale, the mount, the signature check, the database). To make the check listen itself, stop `oasis-api` first or pass
`--listen 127.0.0.1:3012`.

`--replies` asks you to text **C**, then **STOP**, **START** and **HELP** from the phone you passed in `--to`, one at a time, each within three
minutes, and shows how Oasis's inbound rules classify them. Do it with an iPhone and an Android phone: some iPhones send over
iMessage/RCS instead of SMS (item SG-16).

Other options: `--event-timeout SECONDS` (wait per webhook, default 90), `--reply-timeout SECONDS`, `--sim-number 1|2` (send once through that SIM),
`--measure-limit 31 --yes` (send 31 texts in a burst to find the point where Android shows its "send many messages" prompt; watch the
tablet screen and tap it away), `--reject 3` (make the check refuse the first three attempts of each delivery to measure how the app
retries; needs the check to be the listener), `--register-webhooks --webhook-url URL` (temporary webhooks pointing at a listener of
your own), `--sync-signing-key` (writes the signing key to the tablet).

### The items

| # | What it checks | Needs |
|---|---|---|
| SG-01 | the tablet serves `/messages` (and `/message`) | read |
| SG-02 | sending the same message id twice is refused (409), so a retry cannot double-send | `--send` |
| SG-03 | asking for an unknown message id is a 404 | read |
| SG-04 | the current message format is accepted | `--send` |
| SG-05 | 36-character ids and the retry ids are accepted | `--send` |
| SG-06 | a real webhook's signature verifies with your signing key | `--watch` and a text |
| SG-07 | the tablet reaches the HTTPS tailnet address | `--watch` and a text |
| SG-08 | the tailnet mount reaches the right path on the server | read, needs `SMSGATE_WEBHOOK_PUBLIC_URL` |
| SG-09 | how the app retries after a server error | `--reject` |
| SG-10 | the 60-second `system:ping` arrives | `--watch` |
| SG-11 | when Android shows its sending prompt | `--measure-limit` |
| SG-12 | priority does not reorder or bypass limits | by hand (pause the device, send a low then a high priority text) |
| SG-13 | the carrier returns delivery reports | `--send` |
| SG-14 | `delivered` arrives once per part of a long text | `--send --multipart --watch` |
| SG-15 | the sender's number format on a reply | `--replies` |
| SG-16 | replies from iPhone/RCS phones arrive | `--replies` |
| SG-17 | the app survives a reboot (`app:started`) | reboot the tablet while `--watch` runs |
| SG-18 | the SIM slot mapping | `--sim-number` |
| SG-19 | the tablet accepts the signing key by API | `--sync-signing-key` |
| SG-20 | the server reaches the tablet over the tailnet | read |
| SG-B1 to B6 | the first-run steps in `docs/integrations/smsgate.md` section 3 (health, login, the seven webhooks, one text out with receipts, the four replies, two minutes offline) | as above; B6 is by hand |
| SG-H1 | battery level, charging and health status | read |

### When a line fails

| Item | Likely cause and fix |
|---|---|
| SG-B1 / SG-20 | the tablet is off, asleep, or Tailscale is disconnected on it; the Tailscale access rules do not let the server reach `:8080` |
| SG-B2 | wrong username or password: read them again in the app |
| SG-01 | an older app build: set `SMSGATE_API_PATH=/message` |
| SG-B3 | the webhooks are not registered: `oasis-admin.sh ... sms-register-webhooks <id>` or restart `oasis-api` |
| SG-08 | `tailscale-serve.sh` was not run, or something else is mounted: `tailscale serve status` |
| SG-06 FAIL | the signing key in the app differs from `SMSGATE_WEBHOOK_SECRET` |
| SG-B4 no webhook | the text left the tablet but its receipts do not reach the server: SG-07/08 |
| SG-13 | many carriers send no delivery reports; texts then stay "sent" and Oasis treats that as final |
| SG-16 | turn chat features off on the tablet's SIM |

---

## Squarespace

### What to prepare

1. In Squarespace: **Settings, Advanced, Developer API Keys, Generate Key**. Give it **Orders, Transactions and Contacts: Read Only** and
   nothing else (the site's plan must include Commerce Advanced; ask the account owner which plan it is). Squarespace shows the key
   once: copy it.
2. A few real or test orders on the site, at least one membership renewal (the same person buying the same membership product twice),
   one partial refund, and one payment taken the way staff will take it (checkout link, invoice, point of sale).

### Commands

```bash
sudo SQSP_API_KEY='the key' $D/verify.sh squarespace --days 90          # reads only (or keep SQSP_API_KEY in common.env)
sudo SQSP_API_KEY='the key' $D/verify.sh squarespace --days 90 --capture /var/lib/oasis/live-verification/captures
sudo $D/verify.sh squarespace --post-webhook https://your-domain/hooks/squarespace   # with SQSP_WEBHOOK_SECRET set
```

Everything is a read. `--days N` is how far back to look (30 by default; widen it to catch a renewal or a rare payment state).
`--capture DIR` saves copies of the payloads with emails, phone numbers, names and addresses replaced, to turn into test fixtures.

### What you get

* **SQ-01 to SQ-04**: the key works; the API's rules about dates and cursors; whether paging keeps showing part-paid and pending orders;
  what a transaction looks like (card brand, no last four digits, where refunds sit).
* **SQ-05: a proposed product map.** It groups the products on your orders, notices which ones the same customers buy again every month
  (or quarter, or year), reads the tier from the name (Essential, Premium, Executive, Exotic) and writes
  `<date>-squarespace-product-map.proposed.json` in the format the product-map screen/endpoint takes. **It writes nothing to Oasis.** Review it,
  then `oasis-admin.sh ... sqsp-product-map --file <file>`. A product with a tier word in its name but no sign of being a membership (a "Premium
  Wash") is proposed as a service.
* **SQ-06 / SQ-M1**: how orders arrive (web or point of sale), their payment states, and whether orders carry an email or phone number. The
  matcher needs one of them; below 90% of orders the check fails, because those payments could only be matched by hand.
* **SQ-07**: a sync cycle needs fewer than ten requests (Squarespace allows 300 a minute). Rate limits are not provoked on purpose.
* **SQ-08, SQ-09, SQ-10**: the poll-and-match run happens inside the app (the item says what to press); captures; the webhook signature path.

---

## AWS: email, photos and permissions

### What to prepare (AWS console)

**Email (SES)**
1. SES, Identities, **Create identity**, a domain, leave Easy DKIM on. Add the three CNAME records it shows to your DNS. Wait until the
   identity says **Verified** and DKIM **Successful** (minutes to hours). Optional but good: a custom MAIL FROM domain and a DMARC record.
2. Choose the sender address on that domain (for example `no-reply@your-domain`) and set it as `SES_FROM_ADDRESS`.
3. **Production access.** A new account is in the sandbox: it can only mail verified addresses, 200 a day. Request production access (SES,
   Account dashboard) and describe it as transactional mail: receipts, staff invitations, password resets, alerts. Test in the meantime
   by sending to `success@simulator.amazonses.com`, or verify your own address.
4. Optional, for bounces and complaints: a configuration set (`SES_CONFIGURATION_SET`) with an SNS destination (`docs/integrations/ses.md`).

**Photos (S3)**
5. Create a **private bucket** (Block Public Access on all four settings, encryption on by default) and add the TLS-only bucket policy and the CORS
   rule from `docs/integrations/s3.md`, with your dashboard's address as the only allowed origin. Set `S3_BUCKET` and `AWS_REGION`.

**Permissions** (IAM). The server's role (its EC2 instance profile) needs exactly this:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "SendMail", "Effect": "Allow", "Action": "ses:SendEmail",
      "Resource": ["arn:aws:ses:REGION:ACCOUNT:identity/your-domain", "arn:aws:ses:REGION:ACCOUNT:configuration-set/oasis-prod"],
      "Condition": { "StringEquals": { "ses:FromAddress": "no-reply@your-domain" } } },
    { "Sid": "PhotoObjects", "Effect": "Allow", "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::YOUR-BUCKET/*" },
    { "Sid": "PhotoList", "Effect": "Allow", "Action": "s3:ListBucket", "Resource": "arn:aws:s3:::YOUR-BUCKET" }
  ]
}
```

`s3:ListBucket` matters: without it a photo that does not exist reads as "forbidden" instead of "not found" and uploads cannot be
confirmed. Scope this to the whole bucket for now, not a prefix: the application does not yet read `S3_KEY_PREFIX`
([deployment.md](deployment.md), "Known gaps"). Drop the configuration-set line if you do not use one.

The check can only report on settings it may read. To see every item, run it once with a person's login that can read the settings, or add
this read-only policy to a temporary user (it grants nothing the app uses):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": ["ses:GetAccount", "ses:GetEmailIdentity", "ses:GetConfigurationSet", "ses:GetConfigurationSetEventDestinations"], "Resource": "*" },
    { "Effect": "Allow", "Action": ["s3:GetBucketCORS", "s3:GetBucketPublicAccessBlock", "s3:GetBucketPolicy", "s3:GetLifecycleConfiguration", "s3:GetEncryptionConfiguration"],
      "Resource": "arn:aws:s3:::YOUR-BUCKET" }
  ]
}
```

Anything it may not read is shown as `SKIP` with the exact permission name, never as a failure.

### Commands

On the server (the instance profile is the identity, so nothing is stored; `--instance-profile` is the only thing that makes the check
ask the host for its role):

```bash
sudo $D/verify.sh aws --instance-profile                                   # reads configuration only
sudo $D/verify.sh aws --instance-profile --send --to you@your-domain       # + one test email and one test photo round trip
```

From a laptop with an IAM user key: `AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... SES_FROM_ADDRESS=... S3_BUCKET=... pnpm verify:aws --send --to you@...`.
Without any credentials, or with `--only ses` / `--only s3` to look at one service.

### The items

| # | What it checks |
|---|---|
| AWS-01 | the sender's domain (or address) is verified and DKIM is successful |
| AWS-02 | the account is out of the sandbox and sending is enabled; the daily quota |
| AWS-03 | the configuration set exists and publishes bounces and complaints |
| AWS-04 | the feedback topic subscription (by hand: the check says which command) |
| AWS-05, AWS-06 | the app's own mail sender sent one message and SES accepted it (`--send`) |
| AWS-S1 | the bucket exists, Block Public Access is fully on, the policy requires TLS |
| AWS-S2 | CORS allows the dashboard's address to POST |
| AWS-S3 | a real browser-style upload (presigned POST), a head, a presigned download that returns identical bytes, a delete, and a head that correctly says "not found" afterwards, under `verify/` (`--send`) |
| AWS-S4 | lifecycle rules |
| AWS-S5 | the application's settings agree with the bucket, and that it will actually read the ones you set |
| AWS-G1 | **the permission gaps**: if any action the app needs was refused, each one is listed with the resource it needs |

The check tells permission problems from credential problems: a refused action is a missing permission and is named; a rejected key or an
expired token is reported as such, with the variables to check.

---

## Reading and keeping the reports

`<date>-smsgate.md`, `-squarespace.md`, `-aws.md` (and `-all.md` for `verify:all`) are the human report: a table of every item with its
result, the fixes, evidence, notes (battery and health, device settings with secrets hidden, the proposed product map) and the source
document of each item. The `.json` next to each has the same content for tools. They contain no secrets, but they describe your account
and devices, so they stay out of git; the wrapper keeps them in `/var/lib/oasis/live-verification`.

When you have run it on the real tablet, update `docs/integrations/smsgate.md` section 2 (tick the items) and replace the constructed fixtures
in `test/fixtures/` with captures, as that document says.

## What these checks cannot prove

* Carrier behaviour over time: filtering of a consumer SIM sending business volume, delivery reports that depend on the recipient's carrier.
* That staff will actually follow the payment flow. SQ-06 shows how a payment you made arrives; the habit is yours.
* SES reputation: bounce and complaint rates only show up with real volume. Watch the SES dashboard in the first weeks.
* Anything that happens only after weeks: the tablet surviving updates and reboots, certificate renewals, key expiry.
