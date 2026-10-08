# 0112 Integration configuration is declared, switchable by configuration only, and visible
Status: accepted (2026-10-08)

* **Every key a module reads is declared in `src/config/env.ts`.** zod drops undeclared keys, so `S3_KEY_PREFIX`, `S3_SSE`,
  `S3_KMS_KEY_ID`, `S3_ENDPOINT`, `S3_FORCE_PATH_STYLE`, `STORAGE_SIGNING_SECRET` and `SES_SNS_TOPIC_ARNS` were silently ignored. The email
  and storage shapes now live in `src/integrations/{email,storage}/env.ts` (zod only, no SDK import) and are spread into `envSchema`;
  `SES_ENDPOINT` (simulator only), `PAYMENT_LINK_HOSTS` and the credential variables the AWS SDK reads (`AWS_ACCESS_KEY_ID`,
  `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_PROFILE`, `AWS_EC2_METADATA_DISABLED`) are declared too. A test scans `src/` for
  `process.env.X`, `env.X`-style reads and the zod keys of config modules and fails on any key env.ts does not declare.
* **Validation follows what the code reads.** `SQSP_PROVIDER=live` no longer requires `SQSP_API_KEY` (the sync prefers the key stored
  encrypted with `PUT /integrations/squarespace/connection`), and `SMS_PROVIDER=smsgate` no longer requires the four `SMSGATE_*` device
  values (the runtime reads the tablets from `sms_devices`). New checks: `S3_KMS_KEY_ID` only with `S3_SSE=aws:kms`; the two AWS key
  variables together or not at all.
* **Switching to SES and S3 is configuration only.** `EMAIL_PROVIDER=ses` and `STORAGE_PROVIDER=s3` with the settings above change the
  API and the worker without code: proven end to end by spawning the real `src/server.ts` and `src/worker.ts` against the AWS simulator
  (test/aws/sim-e2e.test.ts). Credentials come from the SDK's default chain; the app never reads them itself.
* **`GET /api/v1/system/integrations` (`set.billing`)** answers per integration (email, storage, sms, squarespace): provider, `live`,
  `configured` (live and nothing required missing), `missing` (exact variable names or steps such as registering a tablet),
  `warnings` (recommended settings, simulator overrides, an offline tablet), last success and last error with time, and non-secret
  details. Sources: `outbox_emails` (`sent_at`, new `error_at`), `webhook_log` (last SES feedback), `email_suppressions`,
  `appointment_photos` and `job_runs` (photos.thumbnail, photos.retention), `sms_outbox` and `sms_devices`, `sqsp_sync_state` and
  `sqsp_connections`. Nothing secret is returned: AWS credentials only as their source (`environment`, `profile`, `instance-role`,
  `none`), the topic ARNs only as a count, error text masked (addresses, phone numbers, access key ids) and cut at 300 characters.
