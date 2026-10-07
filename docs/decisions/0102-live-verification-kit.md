# 0102 Live verification: one command per integration, safe by default, proven against simulators
Status: accepted (2026-10-07)

* **The checklists in `docs/integrations/` are the specification.** Each check is a list of numbered items (SG-01..20 and B1..B6 for the
  tablet, SQ-01..10 for Squarespace, AWS-01..06 and AWS-S1..S5 for SES and S3, plus a few that the documents imply), every one reported
  as PASS, FAIL (with a `fix:`) or SKIP (with the reason) so nothing is silently dropped, in a markdown report and a JSON summary.
* **Safe by default.** Without `--send` a check only reads. Writes are separate, named opt-ins: texts and the duplicate-id probe
  (`--send --to`), one email and a one-second S3 object (`aws --send --to`), a signed ignored-topic notification to your own URL
  (`--post-webhook`), temporary `oasis-verify-*` webhooks (`--register-webhooks`, removed in a `finally`; the production `oasis-*`
  registrations are never replaced), the signing key (`--sync-signing-key`). Reports and console output hide credentials, the recipient
  and anything under a key name that looks secret.
* **Exit codes:** 0 no FAIL, 1 a FAIL, 2 cannot start (the missing variables are listed) or a bad command line. The AWS check never
  contacts instance metadata unless `--instance-profile` is given: without credentials it exits 2 instead of probing.
* **It exercises the product's own code,** not a re-implementation: `SmsGateProvider`, the webhook verifier, `routeInbound`,
  `SquarespaceClient` and its mappers, `SesProvider`, `S3Storage` with the real AWS SDK clients. A check that passes means the code that
  will run in production works against that device or account.
* **Watching webhooks.** The tablet's deliveries are observed either by listening on the hooks port (the check is the listener) or, when
  the API owns that port, by following `webhook_log`, which proves the whole path including the tailnet mount and the API's signature check.
* **`--sim` runs the same script against real simulators on loopback** (SMS Gate 4591, Squarespace 4590, AWS 4592, watch listener 4593).
  The AWS simulator speaks the SESv2 REST and S3 path-style protocols well enough for the unmodified SDK clients, evaluates presigned POST
  policies and reproduces S3's 403-versus-404 rule for a missing key, and can deny any IAM action, which is how "permission gaps listed
  precisely" is tested. Simulator reports say so in their header; they prove the script, not the hardware.
* **IAM gaps are found by acting, not by guessing.** The app's own actions (`ses:SendEmail`, `s3:PutObject/GetObject/DeleteObject/ListBucket`)
  are exercised and each AccessDenied is reported under its action name (S3 does not say which action it refused). Read-only diagnostics
  the identity may not call become SKIP naming the permission, not FAIL, because the application does not need them.
* **Found while building it:** the environment schema drops `S3_KEY_PREFIX` and the other storage and SES settings that the integration
  documents tell the integrator to add, so the app would ignore them; the AWS check reports that (AWS-S5) and tests the round trip with the
  settings the app will really have. Squarespace product-map proposals are emitted in the API's row format and never written.
