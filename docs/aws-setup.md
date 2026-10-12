# AWS setup

This is the exact sequence the integrator runs. Two reviewed, idempotent commands do the AWS side: `pnpm aws:provision` creates the
resources and the identity the app runs as, and `pnpm secrets:push` puts the application's environment into AWS Secrets Manager
(the services read it from there at start, not from files on disk). **Email (SES) and the domain come last, on purpose**: everything
below works without a sender and without a public URL, and SES is added later by re-running the same command with `--sender`.
Decisions: [ADR 0111](decisions/0111-aws-provisioning.md), [0130](decisions/0130-environment-from-secrets-manager.md),
[0131](decisions/0131-secrets-push.md), [0132](decisions/0132-provisioning-without-email-and-the-secret.md),
[0133](decisions/0133-runtime-identity-role-or-user.md). Background per service: [integrations/ses.md](integrations/ses.md) and
[integrations/s3.md](integrations/s3.md). The host side (units, env files): [deployment.md](deployment.md).

## The operator key is an administrator key: deactivate it after setup

The owner handed over an IAM user with **administrator** rights (an access key id `AKIA...` and its secret). Permissions are
therefore not the limit; what the scripts **create** is least privilege. Rules for that key:

* It lives only in the integrator's AWS profile (`~/.aws/credentials` of the user who runs the commands, mode 600), never in
  `/etc/oasis`, never in the secret, never in a repository, never on a command line. Both tools refuse to run without `--profile` (or
  explicit `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`) and set `AWS_EC2_METADATA_DISABLED=true`, so they never act as the instance role.
* Nothing the application runs with depends on it. **When setup is done the owner deactivates it** (IAM console: Users, the user,
  Security credentials, the key, Actions, Deactivate) and deletes it a few days later. A key that was ever pasted into a chat or an
  email counts as exposed: deactivate that one now and create a fresh one for the setup.
* For the later email/domain step the owner creates a fresh key (or uses the narrow policy at the end of this page) and deactivates
  it again afterwards.

## What it creates

Names with the default prefix `oasis`; `<acct>` is the 12-digit account id.

| Resource | Name | Settings |
|---|---|---|
| Photos bucket | `oasis-photos-<acct>` | Block Public Access (all four), Object Ownership BucketOwnerEnforced (no ACLs), default encryption SSE-S3, CORS for the dashboard origins (POST, GET, HEAD only), versioning (a deleted or overwritten photo stays recoverable for 30 days), lifecycle: objects under the key prefix expire after 760 days (the 24-month retention job decides first), old versions after 30 days (`expire-old-photo-versions`), unfinished uploads after 1 day, bucket policy denying non-TLS requests |
| Backups bucket | `oasis-backups-<acct>` | Block Public Access, BucketOwnerEnforced, SSE-S3, versioning, lifecycle: objects expire after 400 days (12 monthly dumps plus margin), old versions after 30 days, unfinished uploads after 1 day, TLS-only policy |
| Environment secret | `--secret-id`, default `oasis/prod/app` | created holding `{}` with the AWS-managed key `aws/secretsmanager`, tag `app=oasis`; an existing secret is never read or changed (`pnpm secrets:push` fills it) |
| IAM policy | `oasis-app-runtime` | least privilege (below); a change adds a new default version |
| runtime=role (default) | role `oasis-app-role`, instance profile `oasis-app-profile` | the role may be assumed by EC2 only and has `oasis-app-runtime` attached; the profile holds it and is associated with the instance given by `--instance-id` or `--private-ip` |
| runtime=user | IAM user `oasis-app` | no console password; `oasis-app-runtime` attached; one access key written to `--out` (AWS credentials file, mode 0600), never printed |
| later, with `--sender` | SES identity, configuration set `oasis-mail`, SNS topic `oasis-ses-events`, HTTPS subscription to `--hooks-url` | domain: Easy DKIM (RSA 2048), the CNAME records are printed; event destination BOUNCE, COMPLAINT, DELIVERY, REJECT to the topic; topic policy lets SES publish for `oasis-mail` only; HTTPS delivery policy 12 retries over about 25 minutes |
| later, with `--bedrock` | two statements in `oasis-app-runtime` (a new policy version) | `bedrock:InvokeModel` on the `us.` inference profiles of Claude Sonnet 4.6, Opus 4.6, Sonnet 5.5 and Opus 5.5 and, only through them, on those models in us-east-1, us-east-2 and us-west-2 ([below](#the-ai-assistant-claude-on-amazon-bedrock-adr-0160)) |

It **describes before it creates** (Describe/Get/Head/List calls only until `--apply`), **never deletes** (CORS entries, lifecycle
rules and policy statements it does not own are kept; an instance profile already associated with the instance is left alone unless
`--replace-instance-profile`), prints every document it would send, and a re-run after `--apply` says `Nothing to change.` The one
removal is IAM housekeeping: when `oasis-app-runtime` already has five versions, the oldest non-default one goes before a new one is
added; the plan says so.

## Which identity the app runs as: the instance role (recommended) or a key file

`--runtime role|user` chooses; the owner decides, and **the instance role is the recommendation** (it is what AWS recommends for code
on EC2):

| | runtime=role (default) | runtime=user |
|---|---|---|
| What exists | role `oasis-app-role` + instance profile `oasis-app-profile`, associated with this instance | IAM user `oasis-app` + one access key |
| On the host | nothing: the SDK gets short-lived credentials from the instance (rotated by AWS every few hours) | `/etc/oasis/aws-credentials`, owner root, mode 0600; systemd hands it to the services (`LoadCredential`), and the units set `AWS_EC2_METADATA_DISABLED=true` |
| Can leak | only while a process on the host asks the instance for it; nothing in files or backups | the key, from that file or a copy of it, until someone deactivates it |
| Rotation | none needed | `--new-access-key --out <new file> --apply`, install, restart, owner deactivates the old key |

On this host the development agents also run (as `ec2-user`, who has sudo), so neither choice isolates the app from local processes:
anything that can become root can read the key file, and any local process can ask the instance for the role's credentials. The
difference is what survives outside the host: a role leaves no long-lived key anywhere. Recommended with the role: require IMDSv2 with a
hop limit of 1 (`aws ec2 modify-instance-metadata-options --instance-id <id> --http-tokens required --http-put-response-hop-limit 1
--profile oasis-admin`), so containers and forwarded requests cannot reach it.

## The application's own policy (`oasis-app-runtime`)

`pnpm aws:provision` prints it in full. For the defaults (`--key-prefix prod/`, secret `oasis/prod/app`) and no sender yet:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "ReadEnvironment", "Effect": "Allow", "Action": "secretsmanager:GetSecretValue",
      "Resource": "arn:aws:secretsmanager:us-east-1:<acct>:secret:oasis/prod/app-AbCdEf" },
    { "Sid": "OnlyCurrentVersion", "Effect": "Deny", "Action": "secretsmanager:GetSecretValue",
      "Resource": "arn:aws:secretsmanager:us-east-1:<acct>:secret:oasis/prod/app-AbCdEf",
      "Condition": { "StringNotEquals": { "secretsmanager:VersionStage": "AWSCURRENT" }, "Null": { "secretsmanager:VersionStage": "false" } } },
    { "Sid": "NoVersionIdReads", "Effect": "Deny", "Action": "secretsmanager:GetSecretValue",
      "Resource": "arn:aws:secretsmanager:us-east-1:<acct>:secret:oasis/prod/app-AbCdEf",
      "Condition": { "Null": { "secretsmanager:VersionId": "false" } } },
    { "Sid": "PhotoObjects", "Effect": "Allow", "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"], "Resource": "arn:aws:s3:::oasis-photos-<acct>/prod/*" },
    { "Sid": "PhotoHeadMissingKey", "Effect": "Allow", "Action": "s3:ListBucket", "Resource": "arn:aws:s3:::oasis-photos-<acct>" },
    { "Sid": "BackupWrite", "Effect": "Allow", "Action": "s3:PutObject", "Resource": "arn:aws:s3:::oasis-backups-<acct>/*" }
  ]
}
```

* `ReadEnvironment` names exactly the one secret, by its real ARN (AWS appends a random `-AbCdEf` at creation; before the secret
  exists the plan shows `-??????`, which matches only that suffix, and apply uses the real ARN). Only `GetSecretValue`: the app can
  read its environment, not change or list secrets. No `kms:Decrypt` statement: a secret under the AWS-managed key
  `aws/secretsmanager` is decrypted through Secrets Manager for any principal of the account that may read the secret. (If the owner
  ever moves the secret to a customer-managed key, the plan notes that the runtime then also needs `kms:Decrypt` on that key.)
* **Only the current version of the secret.** Secrets Manager keeps the previous version (`AWSPREVIOUS`), which can still hold values
  that were removed since (the first-boot `BOOTSTRAP_ADMIN_PASSWORD`, an old key). `OnlyCurrentVersion` refuses a read that names any
  other stage, `NoVersionIdReads` one that names a version by id. The app reads with the secret id alone, which is `AWSCURRENT`, so it
  is unaffected. `OnlyCurrentVersion` also requires the stage key to be present (`Null` false): whether IAM fills in `AWSCURRENT` for
  a read that names no stage is not documented clearly, and a negated operator matches a missing key, so without that guard the Deny
  could refuse the app's own reads. Operators (`pnpm secrets:push`, the console) use their own identity and are not limited by this.
* **Backups are write-only.** `BackupWrite` is `s3:PutObject` only: no read, no list, no delete (the bucket is versioned, so an
  overwrite keeps the old version). `backup.sh` uploads with `aws s3 cp`, which for a single file sends `PutObject`, or
  `CreateMultipartUpload`/`UploadPart`/`CompleteMultipartUpload` above 8 MB, all authorised by `s3:PutObject`; it never lists the
  bucket (checked by pointing the CLI at a local endpoint and recording every request), so `s3:ListBucket` was removed too. A failed
  multipart upload cannot be aborted by the role; the bucket's `abort-incomplete-uploads` rule removes it after a day. Restoring
  (download) is an operator task with the operator's identity.
* `s3:ListBucket` on the photos bucket is there on purpose: without it S3 answers a HEAD for a key that was never uploaded with 403
  instead of 404, and the app could not tell an abandoned upload from a permission problem (`pnpm verify:aws` checks this).
* With `--sender` a seventh statement appears (a new policy version):
  `{ "Sid": "SendEmail", "Action": ["ses:SendEmail", "ses:SendRawEmail"], "Resource": [<identity ARN>, <configuration-set/oasis-mail ARN>], "Condition": { "StringLike": { "ses:FromAddress": "*@<domain>" } } }`
  (`StringEquals` on the address for an address sender; each `--sandbox-recipient` adds its identity ARN).
* With `--bedrock` two more statements appear, `InvokeClaude` and `InvokeClaudeRouted` (the AI assistant, below).
* The role's trust policy lets only `ec2.amazonaws.com` assume it.

## The sequence now (no email, no domain)

Run from a backend checkout on the server (`cd ~/oasis/backend`, or `/opt/oasis/current/backend`) as the user who holds the profile.

1. **Store the operator key as a profile** (never in `/etc/oasis`, never in the repository):
   ```
   install -d -m 700 ~/.aws
   cat >> ~/.aws/credentials <<'EOF'
   [oasis-admin]
   aws_access_key_id = AKIA...
   aws_secret_access_key = ...
   EOF
   chmod 600 ~/.aws/credentials
   ```

2. **Verify the identity.** `aws sts get-caller-identity --profile oasis-admin` (or the first line of step 4's plan:
   `identity: arn:aws:iam::<acct>:user/<name>`). Check that the account is the owner's and the user is the one handed over.

3. **Find the instance without instance metadata.** Its private address is on the host itself: `hostname -I` (the first address,
   e.g. `172.31.5.10`). The script looks the instance up with `ec2:DescribeInstances` by that address (or pass `--instance-id i-...`
   from the EC2 console). Nothing reads the instance metadata service.

4. **Read the plan** (Describe/Get/Head/List calls only):
   ```
   pnpm aws:provision --profile oasis-admin --region us-east-1 \
     --dashboard-origin http://<the address the dashboard is reached at today, e.g. the tailnet IP:port> \
     --runtime role --private-ip 172.31.5.10
   ```
   (`--runtime user` instead, without `--private-ip`, if the owner chooses the key file.) Before the domain exists the dashboard origin
   may be `http://` on localhost, a private or tailnet (`100.64.0.0/10`, `*.ts.net`) address; once the domain exists, re-run with the
   `https://` origin (the CORS rule is replaced with exactly the origins given). Every line after `Plan` is `=` (as wanted), `+`
   (create), `~` (update), `!` (request) or `-` (skipped), followed by every document apply would send, the full runtime policy, notes
   (what is associated with the instance now) and the non-secret settings for `common.env`. `- SES and SNS: no --sender ...` is
   expected. Review it.

5. **Apply**, the same command with `--apply`:
   ```
   pnpm aws:provision ...same flags... --apply                                    # runtime=role
   pnpm aws:provision ...same flags... --runtime user --out ~/oasis-app.credentials --apply   # runtime=user
   ```
   Then the same command without `--apply` must say `Nothing to change.` If another instance profile is already associated with the
   instance, the plan shows `-` and a note naming it: nothing was replaced. Decide with the owner; `--replace-instance-profile` replaces
   it (whatever used that role on this host loses it). For runtime=user, install the key file root-only and remove the copy:
   `sudo install -o root -g root -m 0600 ~/oasis-app.credentials /etc/oasis/aws-credentials && shred -u ~/oasis-app.credentials`.

6. **Push the environment into the secret.** For a new install, generate the secret settings straight into a private file:
   ```
   umask 077; deploy/scripts/gen-secrets.sh --secret > ~/oasis-secret.env      # DATABASE_URL, SESSION_SECRET, SECRETS_KEY, STORAGE_SIGNING_SECRET
   pnpm secrets:push --profile oasis-admin --secret-id oasis/prod/app --from ~/oasis-secret.env           # plan: key names only
   pnpm secrets:push --profile oasis-admin --secret-id oasis/prod/app --from ~/oasis-secret.env --apply
   ```
   Keep `SECRETS_KEY` in the owner's password manager as well (without it the stored tablet and Squarespace credentials cannot be
   read), then `shred -u ~/oasis-secret.env`. A host that already runs from `/etc/oasis/common.env` moves its existing values instead
   (`--keys`): [deployment.md](deployment.md), "Move an existing host to the secret". Any other secret setting later (an API key,
   `BOOTSTRAP_ADMIN_*` for the first boot) goes the same way: a one-line file and `secrets:push`.

7. **Switch the services** to the secret: `sudo deploy/scripts/install.sh --domain <host> --secret-id oasis/prod/app --aws-runtime role`
   (or `user`) writes `OASIS_SECRET_ID` and `AWS_REGION` into `common.env` and the systemd drop-ins for the runtime; then put the
   non-secret lines aws:provision printed (`STORAGE_PROVIDER=s3`, `S3_BUCKET`, `S3_KEY_PREFIX`, `BACKUP_S3_URI`) into
   `/etc/oasis/common.env` and `sudo systemctl restart oasis-api oasis-worker`. The journal shows
   `environment: N setting(s) from Secrets Manager secret oasis/prod/app (us-east-1)`; a problem stops the service with one line
   naming it (access denied, secret missing, ...). Details: [deployment.md](deployment.md).

8. **Verify** with the app's own identity (not the operator key):
   ```
   sudo $D/verify.sh aws --only s3 --instance-profile            # runtime=role
   sudo $D/verify.sh aws --only s3                               # runtime=user (the key file is used)
   ```
   (`$D=/opt/oasis/current/backend/deploy/scripts`.) `GET /api/v1/system/integrations` shows `storage` with `configured: true` and
   `credentials: "instance-role"` (role) or `"shared-credentials-file"` (user).

9. **Deactivate the operator key** (the owner, IAM console) and remove the `[oasis-admin]` section from `~/.aws/credentials`. Nothing
   the app uses depends on it.

## Later: email (SES), then the domain

With a fresh operator key (deactivated again afterwards):

1. **The sender.** Re-run the same command with `--sender oasisautospa.com` (or an address). The plan adds the SES identity,
   configuration set `oasis-mail`, topic `oasis-ses-events`, and `~ IAM policy oasis-app-runtime: add a new default version` with the
   `SendEmail` statement; apply it. For a domain the output ends with three DKIM CNAME records and a recommended DMARC record for
   whoever runs the DNS; until DKIM shows `SUCCESS` SES refuses to send from the domain (re-run the plan to see the status). An
   address sender gets a verification link by email instead.
2. **The feedback subscription** needs the public URL, so it waits for the domain (nginx + TLS, [deployment.md](deployment.md)). First
   put `SES_SNS_TOPIC_ARNS=arn:aws:sns:<region>:<acct>:oasis-ses-events` (not secret) into `common.env` and restart `oasis-api`, so the
   app confirms the subscription; then re-run with `--hooks-url https://<domain>/hooks/ses --apply`. A `!` on the subscription means
   it is still pending: fix the setting and apply again (SNS resends the confirmation).
3. **Sandbox and production access.** A new account is in the SES sandbox: `--sandbox-recipient you@example.com` (repeatable) lets you
   test with real inboxes; `success@simulator.amazonses.com` works without verification. Production access, when the owner agrees:
   ```
   pnpm aws:provision ...same flags... --apply --request-ses-production \
     --website-url https://<domain> --contact-email owner@oasisautospa.com \
     --use-case "Transactional email only for Oasis Auto Spa, a single-location car wash: payment receipts to customers who paid, staff invitations and password resets, and operational alerts to staff. No marketing or bulk mail. Recipients are our own customers and staff who gave their address at the counter or in our booking flow. Bounces and complaints are received through an SNS topic and the address is suppressed automatically; the application never mails a suppressed address again."
   ```
4. **Switch email on** in `common.env` (none of it is secret): `EMAIL_PROVIDER=ses`, `SES_FROM_ADDRESS`, `SES_CONFIGURATION_SET=oasis-mail`,
   `SES_SNS_TOPIC_ARNS` (the script prints them); restart; `sudo $D/verify.sh aws --send --to <a verified address>` (add
   `--instance-profile` on runtime=role). Then send one password reset to `bounce@simulator.amazonses.com`: within a minute
   `GET /api/v1/system/email-suppressions` lists it.
5. **The dashboard origin** becomes the `https://` domain: re-run with `--dashboard-origin https://<domain>` (only the CORS rule changes).

## Other later changes

* **Switch from user to role** (or back): re-run with the other `--runtime`; nothing of the old one is deleted (the plan notes the
  leftover user). Then remove `/etc/oasis/aws-credentials`, re-run `install.sh --aws-runtime role`, restart, and have the owner
  deactivate the `oasis-app` key.
* **Rotate the app key** (runtime=user): `--new-access-key --out <new file> --apply` creates a second key (the old one keeps working);
  install it as `/etc/oasis/aws-credentials`, restart, then the owner deactivates and deletes the old key.
* **Retention**: `--photo-retention-days` and `--backup-retention-days` change only the lifecycle rules.

## The AI assistant: Claude on Amazon Bedrock (ADR 0160)

The text assistant calls Claude through Bedrock's Converse API with the app's own identity (the instance role), as a cross-region
inference profile: Bedrock may serve a call in us-east-1, us-east-2 or us-west-2 (the data stays in the US). **Model (owner,
2026-10-11): Claude Sonnet 4.6, `us.anthropic.claude-sonnet-4-6`, the default of `AI_BEDROCK_MODEL_ID`**, because the account's Claude
5.x quotas are 0 (step 2); evaluations are judged by Opus 4.6 (`us.anthropic.claude-opus-4-6-v1`). Once the quota is raised, Sonnet
5.5 is one line in `common.env`, `AI_BEDROCK_MODEL_ID=us.anthropic.claude-sonnet-5-5` (and a restart): the IAM grant already covers it
and the request sent is the same for every listed model (no thinking or other version-specific field; the effort only when step 5
says so). The list lives in `src/integrations/ai/models.ts` (profiles, foundation models, list prices). Nothing here switches the
assistant on: `AI_PROVIDER=bedrock` and `AI_ENABLED=true` are set in the staged rollout (ADR 0160, W5), after these steps pass. Code:
`src/integrations/ai/bedrock.ts`; the check: `pnpm verify:ai` ([live-verification.md](live-verification.md)).

1. **Model access** (owner approval, once per account). Anthropic models need the Anthropic use-case form and the model agreement
   (a pay-as-you-go AWS Marketplace offer). Done on 2026-10-10 for `anthropic.claude-sonnet-5-5` and `anthropic.claude-opus-5-5`, and
   accepted on 2026-10-11 for `anthropic.claude-sonnet-4-6` and `anthropic.claude-opus-4-6-v1` (the judge models are called by the
   operator profile for evaluations). Check per model:
   `aws bedrock get-foundation-model-availability --model-id anthropic.claude-sonnet-4-6 --region us-east-1 --profile <operator>`
   shows the agreement and authorization as available. Until then the ping fails with **MODEL ACCESS** (it names the configured model).
2. **The account quota: Claude 5.x needs an AWS support case on this account.** On 2026-10-11 the account's Bedrock quotas
   "On-demand model inference tokens per minute" (and requests per minute) for every Claude 4.7+ and 5.x model (Sonnet 5.5 and Opus
   5.5 included) were **0** (the AWS defaults are in the millions), while Sonnet 4.6 had its default (6M tokens per minute; a Converse
   call answered in 770 ms). A call to a model with quota 0 fails with "... is not available for this account" (`pnpm verify:ai`
   reports **QUOTA** for the configured model). The Service Quotas API refuses a request at or below the default value and the Support
   API needs a paid plan, so the owner opens a free case in the console: Support, Create case, **Account and billing**, "Service limit
   / quota", text such as:
   > Please apply the default Amazon Bedrock on-demand quotas (tokens per minute and requests per minute) for Anthropic Claude
   > Sonnet 5.5 (cross-region inference, us.anthropic.claude-sonnet-5-5) in us-east-1 for account <acct>. They currently show 0, so
   > every call answers "not available for this account". Expected use: a small business text assistant, under 100k tokens per
   > minute at peak.

   Check afterwards: `aws service-quotas list-service-quotas --service-code bedrock --region us-east-1 --profile <operator> --query
   "Quotas[?contains(QuotaName, 'Sonnet 5.5')].[QuotaName,Value]"`, then `sudo $D/verify.sh ai --instance-profile
   --model us.anthropic.claude-sonnet-5-5` (and `--probe-effort`) before changing `common.env`.
3. **The app's permission.** Re-run provisioning with `--bedrock` (plan first, then `--apply`):
   `pnpm aws:provision --profile <operator> ...the same flags as before... --bedrock`. It adds a policy version with (`<p>` =
   `arn:aws:bedrock:us-east-1:<acct>:inference-profile/`, `<m>` = `arn:aws:bedrock:<region>::foundation-model/`):
   ```json
   { "Sid": "InvokeClaude", "Effect": "Allow", "Action": "bedrock:InvokeModel",
     "Resource": ["<p>us.anthropic.claude-sonnet-5-5", "<p>us.anthropic.claude-opus-5-5",
                  "<p>us.anthropic.claude-sonnet-4-6", "<p>us.anthropic.claude-opus-4-6-v1"] },
   { "Sid": "InvokeClaudeRouted", "Effect": "Allow", "Action": "bedrock:InvokeModel",
     "Resource": ["<m>anthropic.claude-sonnet-5-5", "<m>anthropic.claude-opus-5-5",
                  "<m>anthropic.claude-sonnet-4-6", "<m>anthropic.claude-opus-4-6-v1*"],
     "Condition": { "ArnLike": { "bedrock:InferenceProfileArn": ["<p>us.anthropic.claude-sonnet-5-5", "<p>us.anthropic.claude-opus-5-5",
                                                                 "<p>us.anthropic.claude-sonnet-4-6", "<p>us.anthropic.claude-opus-4-6-v1"] } } }
   ```
   (each `<m>` resource once per region: us-east-1, us-east-2, us-west-2, so twelve in all.) Converse needs `bedrock:InvokeModel` on
   the profile and on the model in whichever region the profile routes to; the condition allows the models only through these
   profiles, so the app cannot call a model directly, through another profile (global., eu.) or any model not listed. The only
   wildcard is Opus 4.6's version suffix (`-v1*`, its foundation model id carries one). No streaming action, no other Bedrock call
   (logging, jobs, agents) is allowed. **Pass `--bedrock` on every later run**: the policy is rebuilt from the flags, and a run without
   it removes the grant (the plan prints a note saying so). The list is fixed in code (`src/integrations/ai/models.ts`): another
   model means a code change, a review and a new `--bedrock --apply`. The output also prints `AI_BEDROCK_REGION` and
   `AI_BEDROCK_MODEL_ID` (Sonnet 4.6) for `common.env` (the defaults already match).
4. **Ping it** on the host, as the app's role: `sudo $D/verify.sh ai --instance-profile`. One Converse call of one output token
   through the app's own provider (well below a cent) to the configured model. FAIL names the cause: **IAM** (step 3), **MODEL
   ACCESS** (step 1), **QUOTA** (step 2), a model outside the granted list (AI-01), throttling or an outage.
5. **Effort.** `AI_BEDROCK_EFFORT_MODE=off` (default) sends no effort field, so the model runs at its own default effort (`high` for
   Sonnet 4.6 and Sonnet 5.5: more thinking tokens, slower and dearer answers). `sudo $D/verify.sh ai --instance-profile
   --probe-effort` says whether Converse's `outputConfig.effort` (`output_config`) or the Anthropic field passed through
   `additionalModelRequestFields` (`additional_fields`) is accepted by the configured model; set the accepted one in `common.env` so
   `AI_EFFORT=low` takes effect, then run the ping again. **Probe again after switching models**: what Sonnet 4.6 accepts says
   nothing about Sonnet 5.5.
6. **Prices.** Each `AI_PRICE_*` that is unset is Anthropic's list price for the configured model (`models.ts`; per million tokens:
   Sonnet 4.6 $3 input, $15 output, $0.30 cache read, $3.75 cache write; Opus 4.6 $5 / $25 / $0.50 / $6.25; Sonnet 5.5 $2 / $10 /
   $0.20 / $2.50; Opus 5.5 $4 / $20 / $0.20 / $5), and a model outside the list is priced at the highest listed rates. Bedrock bills
   the account's own rates (a geographic `us.` profile can cost more than the list): set all four `AI_PRICE_*` from the Bedrock
   pricing page (cross-region on-demand) and change them together with `AI_BEDROCK_MODEL_ID`, so `cost_micros`, the daily budget
   `AI_DAILY_BUDGET_USD` and the spend in `GET /api/v1/system/integrations` (row `ai`, `priceSource` says which applies) are right.
   The output guard's policy judge (ADR 0160, design 3c) is one more call on every reply. It runs on `AI_GUARD_MODEL_ID` (unset:
   the same model), and its cost is in the same budget. A judge model other than `AI_BEDROCK_MODEL_ID` is priced at its list prices.
   It cannot be turned off in production: `AI_GUARD_JUDGE=false` with `AI_ENABLED=true` fails env validation at boot.
   **Before any rollout, and after every change to the judge's rubric, request or model**, measure the guard against Bedrock from
   the operator's machine (never from the instance role; a test-server run has no AWS):
   `AWS_PROFILE=<operator> AWS_EC2_METADATA_DISABLED=true AWS_REGION=us-east-1 AI_PROVIDER=bedrock AI_BEDROCK_MODEL_ID=us.anthropic.claude-sonnet-4-6 pnpm eval:guard --json guard-eval-results.json`.
   It makes 286 judge calls (one per row the deterministic layer passes) and prints recall per category, the judge's own recall on
   what the deterministic layer let through, the false-block rate of the ordinary replies, the judge's errors (a turn fails closed
   on them), its tokens (the rubric's cache reads must not be 0), cost and p50/p95 latency. W4a measured about $0.31 and ten
   minutes per run on Sonnet 4.6 list prices. Run it again with `--fixture test/assistant/fixtures/guard-eval-w4-probes.json`
   (Spanish, quoting the client, injections) and `--fixture test/assistant/fixtures/guard-eval-w4-heldout.json` (a held-out set
   never used for tuning: when the rubric changes, write a new one AFTER the change). The run paces itself at `--rpm 30` and stops
   at `--budget-usd 2` (exit 3). **Quota**: the account's Bedrock quota for Sonnet 4.6 is 50 requests a minute (cross-region; see
   `aws service-quotas list-service-quotas --service-code bedrock`), shared by the assistant's model calls, its judge calls (one per
   reply, two after a rewrite) and any eval. An unpaced first W4a run had 208 of 286 calls throttled; a throttled judge call is a judge error and
   the reply fails closed (fallback + handoff), so ask AWS for more requests a minute before the rollout's volume grows. The eval
   retries throttled calls (`--throttle-retries 3`) and counts them, so its numbers are the judge's own.
   **Then the whole conversation** (ADR 0160 W4b): `pnpm eval:conversations` runs the ~70 personas of
   `test/assistant/fixtures/personas.json` in-process through the real runtime (webhook, gate, welcome flow, turn, tools, guard and
   judge, reply numbers) against a fresh schema of the LOCAL TEST database (`DATABASE_URL_TEST` of the checkout's `.env`; never the
   production database), with the simulated SMS device and a frozen clock, and Bedrock for the assistant, the judge, a client
   simulator (Sonnet 4.6) and a quality rating (Opus 4.6, `us.anthropic.claude-opus-4-6-v1`):
   `AWS_PROFILE=<operator> AWS_EC2_METADATA_DISABLED=true AWS_REGION=us-east-1 AI_PROVIDER=bedrock AI_BEDROCK_MODEL_ID=us.anthropic.claude-sonnet-4-6 pnpm eval:conversations --json conv.json --transcripts conv.md`
   (`--catalog unseeded` for the catalog before the website-catalog seed, `--only id,id` to rerun personas). It prints, per
   persona, the hard assertions (no amount outside the server's placeholders, no promise, never asks for a code/PIN/card, the safety
   line on verify/PIN/membership/payment links, bookings only by reply number, nothing after STOP or to +44/opted-out numbers, the
   disclosure on the first text, at most 320 characters and one question per text), the quality score, turns, fallbacks,
   handoffs, latency and cost, then the totals against the plan's targets. It shares the 50-a-minute Sonnet quota with every other
   eval: it paces its turns at `--rpm 40` (the wait is between turns, never inside a measured turn), so run ONE eval at a time. A
   full run costs about $3 (half of it the Opus rating) and takes about 20 minutes; it stops starting conversations at
   `--budget-usd` (default 25).
7. **An AWS Budgets alarm** as the account-level backstop (the app's own daily budget is the hard stop). Claude on Bedrock is billed
   partly through AWS Marketplace, so a whole-account cost budget catches it where a Bedrock-only filter might not. The first two
   budgets are free:
   ```
   aws budgets create-budget --account-id <acct> --profile <operator> \
     --budget '{"BudgetName":"oasis-monthly","BudgetLimit":{"Amount":"150","Unit":"USD"},"TimeUnit":"MONTHLY","BudgetType":"COST"}' \
     --notifications-with-subscribers '[
       {"Notification":{"NotificationType":"ACTUAL","ComparisonOperator":"GREATER_THAN","Threshold":80,"ThresholdType":"PERCENTAGE"},
        "Subscribers":[{"SubscriptionType":"EMAIL","Address":"<owner address>"}]},
       {"Notification":{"NotificationType":"FORECASTED","ComparisonOperator":"GREATER_THAN","Threshold":100,"ThresholdType":"PERCENTAGE"},
        "Subscribers":[{"SubscriptionType":"EMAIL","Address":"<owner address>"}]}]'
   ```
   Pick the amount from the current monthly bill plus the expected AI spend (about $80 a month at 30 conversations a day).
8. **Model invocation logging stays off.** Prompts and answers contain clients' texts; the app keeps its own redacted transcript
   (`assistant_turns`, owner-only, 90 days). `aws bedrock get-model-invocation-logging-configuration --region us-east-1 --profile
   <operator>` must answer `{}` (nothing configured); if it ever shows a configuration, remove it with
   `aws bedrock delete-model-invocation-logging-configuration --region us-east-1`. The app's role cannot change it.
9. **Kill switches** (no AWS change needed): `AI_ENABLED=false`, `AI_ACTIONS_ENABLED=false`, Settings, Assistant (on/off, stage),
   then a restart for the environment ones. Removing the grant (a provisioning run without `--bedrock`) stops every call at AWS.

## A narrow operator policy (if the owner prefers it to an administrator key)

Everything `pnpm aws:provision` and `pnpm secrets:push` call is allowed by this inline policy, and nothing more is needed (a test
evaluates every call the provisioning script makes against the JSON block below, so the two cannot drift apart). Set the date in every
`DateLessThan` to a few days ahead: the user stops working by itself after that.

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
    { "Sid": "AppRole", "Effect": "Allow",
      "Action": ["iam:GetRole", "iam:CreateRole", "iam:TagRole", "iam:UpdateAssumeRolePolicy", "iam:ListAttachedRolePolicies"],
      "Resource": "arn:aws:iam::*:role/oasis-app-role",
      "Condition": { "DateLessThan": { "aws:CurrentTime": "2026-12-31T23:59:59Z" } } },
    { "Sid": "AttachAppRolePolicy", "Effect": "Allow", "Action": "iam:AttachRolePolicy", "Resource": "arn:aws:iam::*:role/oasis-app-role",
      "Condition": { "ArnLike": { "iam:PolicyARN": "arn:aws:iam::*:policy/oasis-app-*" }, "DateLessThan": { "aws:CurrentTime": "2026-12-31T23:59:59Z" } } },
    { "Sid": "PassAppRole", "Effect": "Allow", "Action": "iam:PassRole", "Resource": "arn:aws:iam::*:role/oasis-app-role",
      "Condition": { "DateLessThan": { "aws:CurrentTime": "2026-12-31T23:59:59Z" } } },
    { "Sid": "AppInstanceProfile", "Effect": "Allow",
      "Action": ["iam:GetInstanceProfile", "iam:CreateInstanceProfile", "iam:TagInstanceProfile", "iam:AddRoleToInstanceProfile"],
      "Resource": "arn:aws:iam::*:instance-profile/oasis-app-profile",
      "Condition": { "DateLessThan": { "aws:CurrentTime": "2026-12-31T23:59:59Z" } } },
    { "Sid": "AssociateInstanceProfile", "Effect": "Allow",
      "Action": ["ec2:DescribeIamInstanceProfileAssociations", "ec2:AssociateIamInstanceProfile", "ec2:ReplaceIamInstanceProfileAssociation"],
      "Resource": "*",
      "Condition": { "DateLessThan": { "aws:CurrentTime": "2026-12-31T23:59:59Z" } } },
    { "Sid": "AppSecret", "Effect": "Allow",
      "Action": ["secretsmanager:DescribeSecret", "secretsmanager:CreateSecret", "secretsmanager:TagResource", "secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue"],
      "Resource": "arn:aws:secretsmanager:*:*:secret:oasis/*",
      "Condition": { "DateLessThan": { "aws:CurrentTime": "2026-12-31T23:59:59Z" } } },
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

`ListBuckets`, `UpdateAccessKey`, `DeleteAccessKey`, `Firewall` (open 443 on the security group, an Elastic IP; `ec2:DescribeInstances`
also finds the instance for the association) and `Dns` (Route 53 records, when the domain is hosted there) are for the integrator's own
steps around the scripts. `AppSecret` also covers `secrets:push` (`GetSecretValue`, `PutSecretValue`). Because the names in the policy
are fixed, keep `--name-prefix oasis` (the default) and a secret name under `oasis/`.

## What was verified, and what was not

Verified here, against an in-memory account behind the real SDK clients (aws-sdk-client-mock): every call the script makes, its IAM
action and resource, evaluated against the narrow policy above; plan, apply and re-run for both runtimes, without and then with a
sender (the policy gains the SES statement as a new version), the secret created empty and never overwritten, the grant on the exact
secret ARN, finding the instance by private IP or id (none, several), an association that exists (left alone, or replaced with the
flag), IAM propagation retries, drift and foreign rules, five policy versions, pending subscriptions, key rotation, the production
request and the refusals (test/aws/provision.test.ts, secrets-push.test.ts, secrets-source.test.ts). The `--bedrock` statements are
pinned exactly and evaluated (the four profiles, the routed models only through them, nothing else), and the Bedrock provider and
`pnpm verify:ai` run the real SDK over HTTP/2 against a local Converse stand-in (test/integrations/ai). Not verified against the real
account: a Converse call through the app's code (the owner's own Sonnet 4.6 call on 2026-10-11 answered; the Claude 5.x quota was 0),
whether `bedrock:InferenceProfileArn` is the key AWS evaluates for the routed call (AWS documents it; `pnpm verify:ai
--instance-profile` proves it on the host), whether Opus 4.6's routed resource carries a version suffix (the `-v1*` pattern covers
both), and which effort field each model accepts through Converse (`--probe-effort`). The loader was also run in real
processes against a local Secrets Manager endpoint (test/aws/secret-entry-points.test.ts).
Not verified against a real account (no credentials were used): AWS's exact echo of lifecycle and CORS documents (compared on the
fields that matter, so a cosmetic difference would show as `~` and be re-applied harmlessly), how long IAM takes to propagate a new
instance profile to EC2 (the script retries for about 30 seconds), the SES review of the production request, and whether SES requires
the topic policy before it accepts the event destination (the script sets the policy first either way).
