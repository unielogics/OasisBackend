# 0131 Writing the secret: pnpm secrets:push, plan first, merge, never a value on screen
Status: accepted (2026-10-09)

* **Plan, then `--apply`.** `pnpm secrets:push --secret-id ID --from FILE` prints the caller identity, the secret's ARN and KMS key,
  and one line per key: `+` new, `~` changes, `=` unchanged, `-` removed, and the keys it keeps. Values are compared, never printed.
* **Merge, not replace.** Keys in the file are added or replaced, keys not in it are kept; `--remove KEY` (repeatable) deletes one.
  `--keys A,B` takes only those keys of a file, which is how the secrets move out of an existing `/etc/oasis/common.env`.
* **Validated before any AWS call.** Every key must be declared by `src/config/env.ts`; `OASIS_SECRET_ID`, `AWS_REGION` and AWS
  credentials are refused; each value passes its field check (a URL for `DATABASE_URL`, 32 characters for `SESSION_SECRET`, 32 bytes
  for `SECRETS_KEY`; an enum mismatch names the allowed values, not the value received); an empty value is refused (use `--remove`).
  A current secret that is not a JSON object of strings is not overwritten.
* **Creates what is missing** with the AWS-managed key `aws/secretsmanager` and the tag `app=oasis` (`pnpm aws:provision` normally
  created it already, empty).
* **Operator credentials only.** `--profile NAME` or explicit `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`, never both, and
  `AWS_EC2_METADATA_DISABLED=true` before any client exists: it can never act as the instance role (which may only read the secret).
* `deploy/scripts/gen-secrets.sh --secret` prints a ready file for it; a file readable by other users gets a warning to `chmod 600`
  and shred it after the push.
