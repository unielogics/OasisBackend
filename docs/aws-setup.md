# AWS setup with the temporary setup user

This is the exact sequence the integrator runs when the owner hands over a **temporary IAM user**. One reviewed, idempotent command
(`pnpm aws:provision`) creates everything Oasis needs in AWS; afterwards the application runs with its own least-privilege user
(`oasis-app`) and the temporary user is deleted. Decisions: [ADR 0111](decisions/0111-aws-provisioning.md). Background per service:
[integrations/ses.md](integrations/ses.md) and [integrations/s3.md](integrations/s3.md).

What it creates (names with the default prefix `oasis`; `<acct>` is the 12-digit account id):

| Resource | Name | Settings |
|---|---|---|
| Photos bucket | `oasis-photos-<acct>` | Block Public Access (all four), Object Ownership BucketOwnerEnforced (no ACLs), default encryption SSE-S3, CORS for the dashboard origins (POST, GET, HEAD only), lifecycle: objects under the key prefix expire after 760 days (the 24-month retention job decides first), unfinished uploads after 1 day, bucket policy denying non-TLS requests |
| Backups bucket | `oasis-backups-<acct>` | Block Public Access, BucketOwnerEnforced, SSE-S3, versioning, lifecycle: objects expire after 400 days (12 monthly dumps plus margin), old versions after 30 days, unfinished uploads after 1 day, TLS-only policy |
| SES identity | the `--sender` address or domain | domain: Easy DKIM (RSA 2048), the three CNAME records are printed for whoever runs DNS |
| SES configuration set | `oasis-mail` | reputation metrics on; event destination `oasis-sns-events`: BOUNCE, COMPLAINT, DELIVERY, REJECT to the topic below |
| SNS topic | `oasis-ses-events` | Standard topic; access policy lets SES publish for `oasis-mail` only; HTTPS delivery policy: 12 retries over about 25 minutes |
| SNS subscription | `--hooks-url` (`https://<host>/hooks/ses`) | HTTPS; the app confirms it itself when `SES_SNS_TOPIC_ARNS` names the topic |
| IAM user | `oasis-app` | no console password; one access key, written to `--out` (mode 0600), never printed |
| IAM policy | `oasis-app-runtime` | least privilege (below), attached to `oasis-app` |

It **describes before it creates** (Head/Get/List calls only until `--apply`), **never deletes** (CORS entries, lifecycle rules and policy
statements it does not own are kept), prints every document it would send, and a re-run after `--apply` says `Nothing to change.`
The one exception to "never deletes" is IAM housekeeping: when `oasis-app-runtime` already has five versions (the IAM maximum), the
oldest non-default version is removed before a new one is added; the plan says so.

## The temporary setup user (the owner creates it)

The owner creates an IAM user (any name, for example `oasis-setup-temp`), attaches exactly this inline policy, creates one access
key for it, and sends the key to the integrator over a private channel. Set the date in every `DateLessThan` to a few days ahead:
the user stops working by itself after that. Every call `pnpm aws:provision` makes is allowed by this policy, and nothing more is
needed (a test evaluates each call the script makes against the JSON block below, so the two cannot drift apart).

<!-- setup-policy:start -->
```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "WhoAmI", "Effect": "Allow", "Action": "sts:GetCallerIdentity", "Resource": "*",
      "Condition": { "DateLessThan": { "aws:CurrentTime": "2026-12-31T23:59:59Z" } } },
    { "Sid": "Email", "Effect": "Allow", "Action": "ses:*", "Resource": "*",
      "Condition": { "DateLessThan": { "aws:CurrentTime": "2026-12-31T23:59:59Z" } } },
    { "Sid": "Buckets", "Effect": "Allow", "Action": "s3:*", "Resource": ["arn:aws:s3:::oasis-*", "arn:aws:s3:::oasis-*/*"],
      "Condition": { "DateLessThan": { "aws:CurrentTime": "2026-12-31T23:59:59Z" } } },
    { "Sid": "ListBuckets", "Effect": "Allow", "Action": "s3:ListAllMyBuckets", "Resource": "*",
      "Condition": { "DateLessThan": { "aws:CurrentTime": "2026-12-31T23:59:59Z" } } },
    { "Sid": "EmailEvents", "Effect": "Allow", "Action": "sns:*", "Resource": "arn:aws:sns:*:*:oasis-*",
      "Condition": { "DateLessThan": { "aws:CurrentTime": "2026-12-31T23:59:59Z" } } },
    { "Sid": "AppUser", "Effect": "Allow",
      "Action": ["iam:CreateUser", "iam:GetUser", "iam:TagUser", "iam:CreateAccessKey", "iam:ListAccessKeys", "iam:UpdateAccessKey", "iam:DeleteAccessKey", "iam:ListAttachedUserPolicies"],
      "Resource": "arn:aws:iam::*:user/oasis-app",
      "Condition": { "DateLessThan": { "aws:CurrentTime": "2026-12-31T23:59:59Z" } } },
    { "Sid": "AppPolicy", "Effect": "Allow",
      "Action": ["iam:CreatePolicy", "iam:GetPolicy", "iam:GetPolicyVersion", "iam:ListPolicyVersions", "iam:CreatePolicyVersion", "iam:DeletePolicyVersion"],
      "Resource": "arn:aws:iam::*:policy/oasis-app-*",
      "Condition": { "DateLessThan": { "aws:CurrentTime": "2026-12-31T23:59:59Z" } } },
    { "Sid": "AttachAppPolicy", "Effect": "Allow", "Action": "iam:AttachUserPolicy", "Resource": "arn:aws:iam::*:user/oasis-app",
      "Condition": { "ArnLike": { "iam:PolicyARN": "arn:aws:iam::*:policy/oasis-app-*" }, "DateLessThan": { "aws:CurrentTime": "2026-12-31T23:59:59Z" } } },
    { "Sid": "Firewall", "Effect": "Allow",
      "Action": ["ec2:DescribeInstances", "ec2:DescribeSecurityGroups", "ec2:DescribeSecurityGroupRules", "ec2:AuthorizeSecurityGroupIngress", "ec2:RevokeSecurityGroupIngress", "ec2:DescribeAddresses", "ec2:AllocateAddress", "ec2:AssociateAddress"],
      "Resource": "*",
      "Condition": { "DateLessThan": { "aws:CurrentTime": "2026-12-31T23:59:59Z" } } },
    { "Sid": "Dns", "Effect": "Allow",
      "Action": ["route53:ListHostedZones", "route53:ListHostedZonesByName", "route53:GetHostedZone", "route53:ListResourceRecordSets", "route53:ChangeResourceRecordSets", "route53:GetChange"],
      "Resource": "*",
      "Condition": { "DateLessThan": { "aws:CurrentTime": "2026-12-31T23:59:59Z" } } }
  ]
}
```
<!-- setup-policy:end -->

`pnpm aws:provision` uses the STS, SES, S3, SNS and IAM statements. `ListBuckets`, `UpdateAccessKey`, `DeleteAccessKey`, `Firewall`
(open 443 on the security group, an Elastic IP) and `Dns` (Route 53 records, when the domain is hosted there) are for the
integrator's own steps around it; the script never calls them. Because the names in the policy are fixed, keep `--name-prefix oasis`
(the default): the app user must be `oasis-app` and its policy `oasis-app-*`, and every bucket and the topic start with `oasis-`.

## The application's own policy (`oasis-app-runtime`)

`pnpm aws:provision` prints it in full; for the default inputs (`--key-prefix prod/`, a domain sender `oasisautospa.com`):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "PhotoObjects", "Effect": "Allow", "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"], "Resource": "arn:aws:s3:::oasis-photos-<acct>/prod/*" },
    { "Sid": "PhotoHeadMissingKey", "Effect": "Allow", "Action": "s3:ListBucket", "Resource": "arn:aws:s3:::oasis-photos-<acct>" },
    { "Sid": "BackupObjects", "Effect": "Allow", "Action": ["s3:PutObject", "s3:GetObject"], "Resource": "arn:aws:s3:::oasis-backups-<acct>/*" },
    { "Sid": "BackupList", "Effect": "Allow", "Action": "s3:ListBucket", "Resource": "arn:aws:s3:::oasis-backups-<acct>" },
    { "Sid": "SendEmail", "Effect": "Allow", "Action": ["ses:SendEmail", "ses:SendRawEmail"],
      "Resource": ["arn:aws:ses:us-east-1:<acct>:identity/oasisautospa.com", "arn:aws:ses:us-east-1:<acct>:configuration-set/oasis-mail"],
      "Condition": { "StringLike": { "ses:FromAddress": "*@oasisautospa.com" } } }
  ]
}
```

`s3:ListBucket` on the photos bucket is there on purpose: without it S3 answers a HEAD for a key that was never uploaded with 403
instead of 404, and the app could not tell an abandoned upload from a permission problem (`pnpm verify:aws` checks this). With an
address sender the condition is `StringEquals` on that address. Each `--sandbox-recipient` adds its identity ARN to `Resource`
(in the sandbox SES also authorizes the recipient identity).

## The sequence

Run everything from the backend checkout on the server (`cd /opt/oasis/current/backend` or a clone) as a user that can read the
profile. Nothing here touches the EC2 instance role or the instance metadata service: the script sets
`AWS_EC2_METADATA_DISABLED=true` itself and refuses to run without `--profile` or explicit key variables.

1. **Store the temporary key as a profile** (never in `common.env`, never in the repository):
   ```
   install -d -m 700 ~/.aws
   cat >> ~/.aws/credentials <<'EOF'
   [oasis-setup]
   aws_access_key_id = AKIA...
   aws_secret_access_key = ...
   EOF
   chmod 600 ~/.aws/credentials
   ```

2. **Verify the identity and read the plan.** No `--apply`, so only Get/Head/List calls are made:
   ```
   pnpm aws:provision --profile oasis-setup --region us-east-1 \
     --sender oasisautospa.com \
     --dashboard-origin https://oasis.example.com \
     --hooks-url https://oasis.example.com/hooks/ses
   ```
   The first line shows the caller (`identity: arn:aws:iam::<acct>:user/oasis-setup-temp`): check it is the owner's account.
   Every line after `Plan` is `=` (as wanted), `+` (create), `~` (update), `!` (request) or `-` (skipped), followed by every
   document apply would send, the full `oasis-app-runtime` policy, and the application settings to use. Review them.

3. **Let the app accept the feedback topic first.** The topic ARN is in the plan (`arn:aws:sns:<region>:<acct>:oasis-ses-events`).
   Add `SES_SNS_TOPIC_ARNS=<that ARN>` to `/etc/oasis/common.env` and `sudo systemctl restart oasis-api`, so that the
   SubscriptionConfirmation SNS sends during apply is confirmed by the app. (`/hooks/ses` must be reachable from the internet through
   nginx; it already forwards that path.) If you skip this, the subscription stays pending: fix the setting and re-run the command
   with `--apply`, which re-sends the confirmation.

4. **Apply**, writing the app's key to a new file:
   ```
   sudo install -d -m 700 /root/oasis-aws
   pnpm aws:provision ...same flags... --out /root/oasis-aws/oasis-app.key --apply
   ```
   The key file holds the two `AWS_ACCESS_KEY_ID=` / `AWS_SECRET_ACCESS_KEY=` lines (mode 0600); the key is never printed (the
   output shows `AKIA...WXYZ` at most). If the file already exists the script stops: choose a new name. Then run the same command
   without `--apply` and expect `Nothing to change.` (an `!` on the subscription means it is still pending: see step 3).

5. **Hand the DNS records to the owner.** For a domain sender the output ends with three CNAME records
   (`<token>._domainkey.<domain> -> <token>.dkim.amazonses.com`) and a recommended DMARC TXT record. Until DKIM shows `SUCCESS`
   (minutes to a few hours after the records exist) SES refuses to send from the domain; re-run the plan to see the status. For an
   address sender SES emails a verification link to that address instead.

6. **Sandbox recipients.** A new account is in the SES sandbox in each region: it can mail only verified addresses, 200 per day. To
   test with real inboxes, add `--sandbox-recipient you@example.com` (repeatable) and apply again: SES emails each one a link to
   click, and the runtime policy gains their identity ARNs. The mailbox simulator (`success@simulator.amazonses.com`,
   `bounce@simulator.amazonses.com`) works without verification.

7. **Request production access** (only when the owner agrees; AWS reviews it within about a day):
   ```
   pnpm aws:provision ...same flags... --apply --request-ses-production \
     --website-url https://oasis.example.com --contact-email owner@oasisautospa.com \
     --use-case "Transactional email only for Oasis Auto Spa, a single-location car wash: payment receipts to customers who paid, staff invitations and password resets, and operational alerts to staff. No marketing or bulk mail. Recipients are our own customers and staff who gave their address at the counter or in our booking flow. Bounces and complaints are received through an SNS topic and the address is suppressed automatically; the application never mails a suppressed address again."
   ```
   Re-running shows `= SES production access: a request is already pending review` (or `already enabled`).

8. **Switch the application by configuration only.** In `/etc/oasis/common.env` set the lines the script printed and paste the two
   lines of the key file; then delete the key file (`shred -u /root/oasis-aws/oasis-app.key`):
   ```
   AWS_REGION=us-east-1
   AWS_EC2_METADATA_DISABLED=true
   AWS_ACCESS_KEY_ID=...            (from the key file)
   AWS_SECRET_ACCESS_KEY=...        (from the key file)
   EMAIL_PROVIDER=ses
   SES_FROM_ADDRESS=no-reply@oasisautospa.com
   SES_CONFIGURATION_SET=oasis-mail
   SES_SNS_TOPIC_ARNS=arn:aws:sns:us-east-1:<acct>:oasis-ses-events
   STORAGE_PROVIDER=s3
   S3_BUCKET=oasis-photos-<acct>
   S3_KEY_PREFIX=prod/
   BACKUP_S3_URI=s3://oasis-backups-<acct>/db/
   ```
   Optional: `SES_REPLY_TO`. Leave `SES_ENDPOINT`, `S3_ENDPOINT` and `S3_FORCE_PATH_STYLE` unset (simulator only). Then
   `sudo systemctl restart oasis-api oasis-worker` and check `GET /api/v1/system/integrations` (a Super Admin, or anyone with
   `set.billing`): `email` and `storage` must say `configured: true` with `missing: []` and `credentials: "environment"`.
   Existing photos in the filesystem store are not copied; they stay on the host under `STORAGE_FS_ROOT`.

9. **Verify with the app's own key** (not the setup user):
   ```
   sudo $D/verify.sh aws                               # reads configuration only
   sudo $D/verify.sh aws --send --to <a verified address or success@simulator.amazonses.com>
   ```
   (`$D=/opt/oasis/current/backend/deploy/scripts`; without the deploy kit: `set -a; . /etc/oasis/common.env; set +a; pnpm verify:aws --send --to ...`.)
   Expected: every item PASS except AWS-02 while the account is in the sandbox, and AWS-04, which you check by hand:
   `GET /api/v1/system/integrations` shows `lastFeedbackAt` after the first delivery event, or with the setup profile
   `aws sns list-subscriptions-by-topic --topic-arn <ARN> --profile oasis-setup` shows a confirmed subscription. Finally send one
   receipt or a password reset to `bounce@simulator.amazonses.com`: within a minute `GET /api/v1/system/email-suppressions` lists it;
   lift it again with `DELETE /api/v1/system/email-suppressions/bounce%40simulator.amazonses.com`.

10. **Delete the temporary user.** The owner deletes `oasis-setup-temp` in the IAM console (or lets the `DateLessThan` date expire and
    then deletes it). Remove the `[oasis-setup]` section from `~/.aws/credentials`. Nothing the app uses depends on it.

## Later

* **Rotate the app key**: with a setup user again, `--new-access-key --out <new file> --apply` creates a second key (the old one keeps
  working); switch `common.env`, restart, then the owner deactivates and deletes the old key in the console.
* **Another dashboard origin**: re-run with all `--dashboard-origin` values and `--apply`; only the CORS rule changes.
* **Retention**: `--photo-retention-days` and `--backup-retention-days` change only the lifecycle rules.

## What was verified, and what was not

Verified here: every call the script makes, its IAM action and resource, evaluated against the setup policy above; the plan, apply
and re-run decisions against an in-memory account behind the real SDK clients (aws-sdk-client-mock), including drift, existing
foreign rules, five policy versions, pending subscriptions and an existing key; the exact documents (test/aws/provision.test.ts).
Not verified against a real account (no credentials here): AWS's exact echo of lifecycle and CORS documents (compared on the fields
that matter, so a cosmetic difference would show as `~` and be re-applied harmlessly), the SES review of the production request, and
whether SES requires the topic policy before it accepts the event destination (the script sets the policy first either way).
