# 0144 The runtime reads only the current secret version, writes backups only, and photos are versioned
Status: accepted (2026-10-09)

* **Secret versions.** Two Deny statements on `secretsmanager:GetSecretValue` for the app's secret: `OnlyCurrentVersion`
  (`StringNotEquals secretsmanager:VersionStage AWSCURRENT`, plus `Null ... false`) and `NoVersionIdReads` (`Null
  secretsmanager:VersionId false`). `AWSPREVIOUS` held the first-boot admin password (review H1 d). The reviewer's stage statement
  is kept but guarded with `Null false`: a negated operator matches a missing key, and whether IAM supplies `AWSCURRENT` for a read
  that names no stage is not clearly documented, so without the guard the Deny could refuse the app's own reads. Not verified
  against AWS here (no credentials); the test evaluator models IAM's semantics for both operators.
* **Backups write-only.** `BackupWrite` is `s3:PutObject` on the backups bucket; `s3:GetObject` and `BackupList` (`s3:ListBucket`)
  are gone. `aws s3 cp` of a file sends only PutObject, or the multipart calls (all `s3:PutObject`), never a list: observed against a
  local endpoint that recorded every request. Restoring is the operator's job with the operator's identity (review M4).
* **Photos versioned.** The photos bucket gets versioning and `expire-old-photo-versions` (NoncurrentVersionExpiration 30 days) beside
  `expire-photos`, so a photo the runtime deletes or overwrites stays recoverable for 30 days (the runtime has no
  `s3:DeleteObjectVersion`).
* Applied by re-running `pnpm aws:provision` (a new default version of `oasis-app-runtime`, two bucket changes).
