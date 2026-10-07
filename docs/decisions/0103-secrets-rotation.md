# 0103 Secrets rotation: SECRETS_KEY re-encryption in one transaction, with a stop-the-world wrapper
Status: accepted (2026-10-07)

* **Two ciphertext formats exist and both are handled.** The messaging module writes `v1.<iv>.<tag>.<ct>` (no key id) to
  `sms_devices.password_enc` and `.webhook_secret_enc`; the Squarespace module writes `<keyId>:<iv>:<tag>:<ct>` to
  `sqsp_connections.{api_key,client_secret,access_token,refresh_token}_enc` and `sqsp_webhook_subscriptions.secret_enc`. `pnpm
  secrets:rotate` uses the two modules' own `SecretBox` implementations, so a change to either format cannot silently drift from it,
  and it writes each value back in the format it found.
* **One transaction, read back before commit.** Every value is decrypted with the old key (or recognised as already under the new one),
  re-encrypted, written, and then read back and decrypted with the new key; any failure rolls everything back. A value that fits
  neither key, or is not in a known format, aborts before any write and names the table, column and row (never the value).
* **Idempotent and resumable.** A re-run finds values already on the new key and leaves them alone, so a half-finished earlier attempt
  (or a restore of a partly rotated database) completes instead of failing.
* **Dry run is the default.** `--apply` is explicit; keys come from environment variables or files, never arguments, and are never printed.
  `--generate-new-key --new-key-out FILE` writes a 0600 key file.
* **Processes holding the old key cannot read new ciphertext, so the wrapper stops them.** `deploy/scripts/secrets-rotate.sh` runs the dry
  run, a `pre-rotate` backup, stops API and worker, applies, replaces `SECRETS_KEY` in `common.env` (previous file kept), starts, and
  health-checks. A failure before the env file changes restarts the services on the old key with the database untouched. The
  application accepting two keys at once (the Squarespace box already can) would remove the outage; messaging's cannot yet.
* **Not covered:** the plaintext copies of the tablet values in `SMSGATE_*` environment variables, `SESSION_SECRET` (a different kind of
  rotation: it only signs people out), and secrets held by third parties, which the runbook lists with their own steps.
