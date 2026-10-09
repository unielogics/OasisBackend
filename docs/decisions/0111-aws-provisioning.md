# 0111 AWS provisioning: one reviewed, idempotent command
Status: accepted (2026-10-08). Amended by 0132 (no sender yet, the environment secret) and 0133 (the instance role is the default identity).

The owner gives the integrator a temporary IAM user with a fixed policy (docs/aws-setup.md); everything the application needs in AWS is
created with `pnpm aws:provision` (scripts/aws/provision.ts), after which the app runs as its own least-privilege user and the temporary
user is deleted.

* **Plan first.** Without `--apply` the script only calls `sts:GetCallerIdentity` and Head/Get/List APIs, prints per resource whether
  it is as wanted (`=`), missing (`+`), different (`~`) or needs a request (`!`), every document apply would send, the full
  `oasis-app-runtime` policy and the settings to put in `common.env`. With `--apply` it sends exactly those documents, in order.
* **Credentials on purpose.** It refuses to run without `--profile <name>` or `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` (both at once
  is refused as ambiguous) and sets `AWS_EC2_METADATA_DISABLED=true` before any client exists, so it can never act as the instance role.
* **Idempotent, never deletes.** Each resource is described before it is created; configuration that exists is compared on the fields
  that matter and replaced only when different. CORS rules, lifecycle rules and policy statements are upserted by their ID or Sid, so
  rules someone else added stay. The only removal is IAM housekeeping when the managed policy already has five versions (the oldest
  non-default version goes before a new default is added; the plan says so).
* **Names** are fixed by the setup policy: buckets `oasis-photos-<acct>` and `oasis-backups-<acct>` (globally unique through the account
  id), topic `oasis-ses-events`, configuration set `oasis-mail`, user `oasis-app`, policy `oasis-app-runtime`.
* **Least privilege for the app.** Photos: Put/Get/DeleteObject under the key prefix, plus `s3:ListBucket` on the bucket, deliberately:
  without it S3 answers 403 instead of 404 for a key that was never uploaded and the app could not tell an abandoned upload from a
  permission problem (pnpm verify:aws checks exactly this). Backups: Put/GetObject and ListBucket (the backup script and the restore
  drill). SES: SendEmail/SendRawEmail on the sending identity and the configuration set (plus sandbox recipient identities when given),
  conditioned on `ses:FromAddress`. No KMS, no SNS, no IAM.
* **The key never leaves the file.** One access key is created when the user has none (a second only with `--new-access-key`, never a
  third), written with `O_EXCL` and mode 0600 to `--out` (an existing file stops the run); output shows `AKIA...WXYZ` at most.
* **Feedback ordering.** The topic ARN is deterministic and printed in the plan, so `SES_SNS_TOPIC_ARNS` is set and the API restarted
  before the subscription is created; a pending subscription shows as `!` and a re-run with `--apply` makes SNS resend the confirmation.
  The topic gets an HTTPS delivery policy (12 retries over about 25 minutes) so a deploy does not lose a bounce.
* **SES production access** is requested only with `--request-ses-production` (and the website URL and use-case text it needs), once:
  a pending review or an enabled account is reported as `=`.
* **Proof.** The tests run the CLI against an in-memory account behind the real SDK client classes (aws-sdk-client-mock): fresh account,
  apply, re-run with zero mutating calls, drift, foreign rules, five policy versions, pending subscription, key rotation, production
  request, refusals; they pin every document; and they evaluate every call the script made, mapped to its IAM action and resource,
  against the setup policy parsed from docs/aws-setup.md, so the documented policy and the script cannot drift apart.
