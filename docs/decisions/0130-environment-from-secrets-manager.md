# 0130 The production environment is read from one AWS Secrets Manager secret
Status: accepted (2026-10-09)

The owner wants the production environment in AWS Secrets Manager, not in files on disk.

* **One secret, a JSON object of strings.** `OASIS_SECRET_ID` (name or ARN, default name `oasis/prod/app`) and `AWS_REGION` stay in
  `/etc/oasis/common.env`; everything secret lives in the secret: `DATABASE_URL`, `SESSION_SECRET`, `SECRETS_KEY`,
  `STORAGE_SIGNING_SECRET`, `BOOTSTRAP_ADMIN_*` for the first boot, and the API keys (`SECRET_KEYS` in
  `src/config/secrets-source.ts`). Any declared setting may live there; non-secret settings stay in the env files where an operator
  can read them.
* **One loader for every program.** `loadRuntimeEnv()` (or `applySecretEnvironment()` for programs that read `process.env` themselves)
  fetches the secret once with `GetSecretValue`, then `loadEnv()` validates exactly as before. The API, the worker, `pnpm migrate`,
  the seed runner, `pnpm secrets:rotate`, `pnpm user:create`, the break-glass password reset and the `verify:*` scripts all use it;
  `scripts/secret-env.ts` gives the shell scripts of the deploy kit the same view. Job handlers that call `loadEnv()` later see the
  same values because the loader fills `process.env` itself. `test/aws/secret-entry-points.test.ts` discovers every program
  (package.json, the units, the deploy scripts, every file with a run-as-a-program guard) and fails when one reads the environment
  without the loader; operator tools and simulators are listed exemptions with their reason.
* **The process environment wins.** A key already set to a non-empty value (an env file, the shell, `.env` in development) is kept
  and the secret's value ignored, so one host can override one setting; the start-up line names the kept keys. An empty value counts
  as unset, so an old template line `SESSION_SECRET=` cannot hide the secret.
* **Fail fast, never leak.** A missing secret, access denied, missing credentials, KMS refusal, a binary or non-JSON value, a non-object,
  non-string values, keys the contract does not declare and keys that may not live there (`OASIS_SECRET_ID`, `AWS_REGION`, AWS
  credentials and credential selectors) each stop the program with one line that names keys at most. `JSON.parse`'s own message is
  not used because it quotes the text. Tests capture stdout, stderr and every console method and assert no value appears.
* **Credentials from the SDK's default chain**: the instance role (recommended), or `AWS_SHARED_CREDENTIALS_FILE` (runtime=user, ADR
  0133), or `AWS_PROFILE`. No credentials are configured in code.
* **Nothing changes without `OASIS_SECRET_ID`**: development and tests fetch nothing.
* **Not covered:** hot reload. A changed secret takes effect at the next start (`systemctl restart oasis-api oasis-worker`); the
  runbook says so.
