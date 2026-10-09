# 0132 Provisioning without email or a domain, and the environment secret
Status: accepted (2026-10-09). Amends 0111.

The owner wants email (SES) and the domain done last; everything else has to work now.

* **`--sender` is optional.** Without it `pnpm aws:provision` makes no SES or SNS call at all (no identity, configuration set, topic,
  subscription, account read) and the runtime policy has no `SendEmail` statement; the plan shows one `- SES and SNS` line and the
  settings it prints leave `EMAIL_PROVIDER` at `sim`. Re-running later with `--sender` adds those resources idempotently and the policy
  change becomes a new default version (IAM keeps the old one). `--hooks-url`, `--sandbox-recipient` and `--request-ses-production`
  need `--sender` and are refused without it.
* **`--dashboard-origin` stays required** (the bucket's CORS rule), but may be `http://` for localhost, private and tailnet addresses
  (`100.64.0.0/10`, `*.ts.net`) until the domain exists; a later run with other origins replaces exactly the CORS rule.
* **The environment secret** (`--secret-id`, default `oasis/prod/app`) is ensured: created holding `{}` with the AWS-managed key and the
  tag `app=oasis` when missing, otherwise only described (its values are never read or written by provisioning; `pnpm secrets:push`
  owns them). A secret scheduled for deletion stops the run; a customer-managed KMS key is reported, because the runtime would then also
  need `kms:Decrypt` on it.
* **The grant is exactly that secret**: `secretsmanager:GetSecretValue` on its real ARN. Before it exists the plan prints the
  `<name>-??????` pattern (only that name matches six characters of suffix); apply creates the secret first and sends the policy with
  the real ARN, so the re-run compares equal. No KMS statement is needed under `aws/secretsmanager`.
* **The setup policy in docs/aws-setup.md** gains the statements for the secret, the role, the instance profile, `iam:PassRole` on the
  app role and the association calls, and stays tested against every call the script makes. The operator in this installation holds
  an administrator key instead; the document says to keep it in a profile only and to deactivate it after setup.
