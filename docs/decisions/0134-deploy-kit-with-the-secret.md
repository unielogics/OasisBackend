# 0134 The deploy kit with the environment in Secrets Manager
Status: accepted (2026-10-09)

* **Env files hold no secret.** The templates name the secret (`OASIS_SECRET_ID=oasis/prod/app`) and keep `AWS_REGION`; every secret
  key (`SECRET_KEYS` in `src/config/secrets-source.ts`, mirrored as `OASIS_SECRET_KEYS` in `deploy/lib/common.sh`; a test holds them
  equal) is commented out with "in the secret". The units are unchanged: they read `common.env` and the app reads the secret itself.
* **A new install** (`install.sh`, `--secret-id`, `--aws-region`) generates the secret settings with `gen-secrets.sh --secret` into
  `/etc/oasis/secret-seed.env` (root, 0600), creates the database role from it with `--local-db`, and prints how to push it with
  `pnpm secrets:push` and shred it; `deploy.sh` warns while it exists. Seeding through a root-only file keeps the generated database
  password and the role in step, which a separately generated file could not.
* **An existing host** moves with `install.sh --move-secrets`: it reads the secret with the app's identity, compares every secret key
  the env files still set with the secret's value (in memory, never printed), refuses on a missing or different key, and only then
  names the secret in `common.env` and removes the lines (the `.bak-*` copies are reported for shredding). `--secrets-in-files` keeps
  the old layout for a host without AWS; every script works with both.
* **Shell scripts read secret values the app's way.** `config_value NAME` (process environment, then a non-empty `common.env` line,
  then the secret through `scripts/secret-env.ts --get`, i.e. the app's own loader) feeds `backup.sh`, `ledger-check.sh`, the restore
  drill and `bootstrap-admin.sh status`; the value goes into a variable and is never echoed. Programs of the release (migrate, verify,
  reset-password, secrets:rotate) read the secret themselves.
* **Writing the secret from the kit** (`bootstrap-admin.sh set|clear`, `secrets-rotate.sh --apply`) goes through `pnpm secrets:push`
  with `--profile` (the operator), never the runtime identity, which can only read. `secrets-rotate.sh` proves the operator may write
  the secret (a plan) before it stops anything, pushes the new key after the re-encryption, and on a failed push restarts the services
  and prints the exact command to finish; it refuses while `common.env` still sets `SECRETS_KEY` (that line would win).
* **runtime=user** (`install.sh --aws-runtime user`): `/etc/oasis/aws-credentials` stays `0600 root:root`; a drop-in per unit that uses
  AWS (`oasis-api`, `oasis-worker`, `oasis-backup`, `oasis-restore-drill`) uses `LoadCredential=` so systemd hands the service a private
  copy, with `AWS_SHARED_CREDENTIALS_FILE=%d/aws-credentials` and `AWS_EC2_METADATA_DISABLED=true`. This deviates from pointing the
  variable at `/etc/oasis/aws-credentials` itself: a root-only file is not readable by the service user, and making it group-readable
  would widen it. Root-run scripts give the service user a temporary private copy for one command (`as_oasis_aws`) and point the aws
  CLI at the file for the backup upload. `--aws-runtime role` writes no drop-in, removes ours, and warns about a leftover key file.
* **Not in the secret:** `drill.env` (the `oasis_drill` URL is not an app setting) and the backup encryption key file stay on disk.
