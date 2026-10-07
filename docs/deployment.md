# Deployment

How Oasis Auto Spa runs in production on one Amazon Linux 2023 host, and the kit in `deploy/` that sets it up, updates it, backs it
up and brings it back. The day-to-day procedures (what to do when something breaks) are in [runbook.md](runbook.md); proving the
tablet, Squarespace and AWS work is in [live-verification.md](live-verification.md). Decisions: ADRs 0100 to 0103.

## What runs where

```
                      internet                                      tailnet (Tailscale, WireGuard)
                         |                                                    |
                  :80 / :443  nginx  (TLS, headers, rate limits)       tablet (SMS Gate app, local server :8080)
                  /      |      \                                         ^      | webhooks
                 /       |       \                       tailscale serve :8443 (/hooks/smsgate ONLY)
       dashboard      /api/*     /hooks/squarespace                         |      v
   127.0.0.1:3200  127.0.0.1:4000  (signed, public)              127.0.0.1:3002  hooks listener (same API process)
   oasis-web        oasis-api  ------------------------------------------------'
   (Next.js)        (Fastify)  <---- pg-boss jobs ----> oasis-worker (SMS dispatch, reminders, Squarespace sync, ...)
                         \                                     /
                          '------------  Postgres 15  ---------'        S3 (photos)   SES (email)   Squarespace API (read-only)
```

* One host, one location, three long-running processes under systemd (`oasis-api`, `oasis-worker`, `oasis-web`), grouped by
  `oasis.target`. Postgres is local (or any Postgres 15 you point `DATABASE_URL` at).
* Nothing but nginx listens on a public address. The API, the dashboard and the hooks listener are on loopback.
* The dashboard and the API share one origin (nginx sends `/api/*` to the API), so there is no CORS and the session cookie is
  host-only.
* The SMS Gate webhook is reachable only from the tailnet. The public site answers 404 for it.

## Files on the host

| Path | What |
|---|---|
| `/opt/oasis/src/backend`, `/opt/oasis/src/dashboard` | git clones (read-only deploy keys). `deploy.sh` fetches into them |
| `/opt/oasis/releases/<id>/{backend,dashboard}` | one built release each: source, `node_modules`, `dist/`, `.next-live/`, `REVISIONS` |
| `/opt/oasis/current`, `/opt/oasis/previous` | symlinks to the running release and the one before it |
| `/etc/oasis/{common,api,worker,web}.env` | environment, `0640 root:oasis`. `drill.env` (restore drill role) and `backup.env` (optional) beside them |
| `/etc/systemd/system/oasis*.{service,timer,target}` | the units |
| `/etc/nginx/conf.d/oasis.conf`, `00-oasis-zones.conf`, `/etc/nginx/oasis/{proxy,security-headers}.conf` | the site |
| `/var/lib/oasis` | state: `files/` (filesystem storage), `mail/` (simulated mail), `drills/` (restore-drill results), the service user's home |
| `/var/backups/oasis/{daily,weekly,monthly}` | database backups |
| `/var/log/oasis/{deploy.log,deploys.list,failures.log}` | deploy history and failed timers (the services themselves log to journald) |

Users: `oasis` (system user, no shell) owns everything it runs. Builds and migrations run as `oasis` too; only `deploy.sh`,
`rollback.sh` and `install.sh` need root, and they drop to `oasis` for the work.

## Setting up a host: `install.sh`

Prerequisites you provide: an Amazon Linux 2023 host with about 8 GB of memory (the dashboard build needs roughly 2 GB, so add
swap on a smaller one), a DNS name pointing at it, ports 80 and 443 open, and read-only deploy keys for the two repositories.

```bash
sudo deploy/scripts/install.sh --domain oasis.example.com --email you@example.com \
     --install-packages --install-postgres --local-db --drill-role --gen-deploy-keys
# add the printed public keys as read-only deploy keys on GitHub, then:
sudo deploy/scripts/install.sh --domain oasis.example.com --email you@example.com \
     --backend-repo git@github-oasis-backend:OWNER/OasisBackend.git \
     --dashboard-repo git@github-oasis-dashboard:OWNER/OasisDashboard.git
```

* `--dry-run` prints every step and changes nothing. `--no-system` writes the files only (for a staging directory).
* It is safe to run again: it changes only what differs, never overwrites an existing env file, and reports variables a newer
  template has that your file lacks.
* Order of work: host checks, packages, the `oasis` user and directories, the env files (with `SESSION_SECRET` and `SECRETS_KEY`
  generated), the database role and database, deploy keys and clones, systemd units, journald and logrotate settings, nginx and TLS.
  It does not start the application; `deploy.sh` does.
* TLS: `--tls certbot` (default) installs a port-80-only site, obtains a Let's Encrypt certificate with the webroot challenge, then
  installs the full site and a renewal hook that reloads nginx. `--tls files --tls-cert F --tls-key F` uses certificates you supply.
* **Copy `SECRETS_KEY` out of `/etc/oasis/common.env` into a password manager now.** It decrypts the tablet and Squarespace
  credentials stored in the database; the database backups are useless for those without it.

### Environment files

`deploy/env/*.env.example` document every variable of `src/config/env.ts` (a test fails if one is missing or undocumented).
`common.env` is read by the API and the worker (database, secrets, integrations), then `api.env` or `worker.env` on top; `web.env`
belongs to the dashboard alone. Shared secrets live once, in `common.env`, so the API and the worker can never disagree about
`SECRETS_KEY`.

Rules, because systemd reads these files and a shell does not: `NAME=value` per line, comments on their own line (a `#` after a value
becomes part of the value), single quotes around anything with spaces or braces, no `export`. An empty value is not "unset": the app
rejects `BOOTSTRAP_ADMIN_EMAIL=` and similar, which is why optional settings are commented out in the templates.

Production switches that matter: `NODE_ENV=production`, `TRUST_PROXY=true` and `COOKIE_SECURE=true` (api.env), `HOST=127.0.0.1`,
`SMS_DISPATCH_MODE=jobs` (the worker sends texts), and none of `DEV_AUTH_BYPASS`, `CLOCK_FREEZE_AT`, `ALLOW_DEV_ENDPOINTS`.

Two quirks of the current environment schema that the templates work around (see "Known gaps"): `SQSP_PROVIDER=live` insists on an
`SQSP_API_KEY` in the environment, and `SMS_PROVIDER=smsgate` insists on `SMSGATE_DEVICE_URL`, `_USERNAME`, `_PASSWORD` and
`_WEBHOOK_SECRET` in the environment, although the running app reads the tablet from the database.

### First Super Admin

`deploy/scripts/bootstrap-admin.sh set you@example.com` generates a password, writes `BOOTSTRAP_ADMIN_EMAIL` and
`BOOTSTRAP_ADMIN_PASSWORD` to `api.env` and prints the password once. On the next API start, if the database has no user at all, the
Super Admin and the five built-in roles are created. Sign in, change the password, then `bootstrap-admin.sh clear` and restart the
API. On any later start the variables do nothing.

## The services

| Unit | Runs | Notes |
|---|---|---|
| `oasis-api` | `node dist/server.js` as `oasis` | loopback `:4000` (API) and `:3002` (hooks). 30 s to stop gracefully. `MemoryMax=1500M` |
| `oasis-worker` | `node dist/worker.js` | pg-boss jobs. 45 s to stop. `MemoryMax=1000M` |
| `oasis-web` | `next start` on `:3200`, live variant | `NEXT_PUBLIC_VARIANT=live`, `DIST_DIR=.next-live`, the same as `pnpm start:live` |
| `oasis-backup.timer` / `.service` | `backup.sh --label nightly` at 03:15 shop time | retention below |
| `oasis-restore-drill.timer` / `.service` | `restore-drill.sh --latest` on the 2nd of each month | enabled when `/etc/oasis/drill.env` exists |
| `oasis-healthcheck.timer` / `.service` | `healthcheck.sh --quiet` every 5 minutes | a failing run shows in `systemctl --failed` |
| `oasis-notify-failure@.service` | records a failed backup or drill in `/var/log/oasis/failures.log` and runs `/etc/oasis/notify-failure.sh UNIT` if you create it | wire your email or SMS there |

All three services restart on failure (3 s delay, at most 8 starts in 5 minutes), start after Postgres, and run sandboxed:
`NoNewPrivileges`, `ProtectSystem=strict` (only `/var/lib/oasis` is writable, plus the release directory for the dashboard cache),
`ProtectHome`, `PrivateTmp`, `PrivateDevices`, kernel and control-group protections, `RestrictAddressFamilies` (IP and Unix sockets),
an empty capability set, `SystemCallFilter=@system-service`, `UMask=0077`. `systemd-analyze security` rates the API at 1.7 ("OK").
`MemoryDenyWriteExecute` is deliberately off: V8 needs writable and executable memory.

Handy: `systemctl status oasis-api oasis-worker oasis-web`, `journalctl -u oasis-api -f`, `systemctl list-timers 'oasis*'`.

## nginx

| URL | Goes to | Notes |
|---|---|---|
| `http://` anything | 301 to `https://` | except `/.well-known/acme-challenge/` |
| `/` | dashboard `:3200` | security headers below |
| `/api/*` | API `:4000` | rate zone `oasis_api` (30 requests/s per address, burst 60) |
| `/api/v1/auth/{login,password/forgot,password/reset,invite/accept}` | API | zone `oasis_login` (30 a minute, burst 10) |
| `/api/v1/events` | API | server-sent events: `proxy_buffering off`, no compression, one-hour reads |
| `/hooks/squarespace`, `/hooks/ses` | API | POST only, 1 MB body limit, zone `oasis_hooks`; signatures are checked by the app |
| `/hooks/*` (including `/hooks/smsgate/*`), `/dev-storage/*` | nothing: 404 | the SMS webhook is tailnet-only |
| `/healthz` | API | public liveness |
| `/readyz`, `/api/v1/openapi.json` | API | this host only (readiness shows database and migration detail) |

**Real client address.** The API runs with `TRUST_PROXY=true`, which makes Fastify believe the first address in `X-Forwarded-For`.
nginx therefore overwrites the header with `$remote_addr` (`proxy_set_header X-Forwarded-For $remote_addr`) and never appends to what a
client sent, and the API is reachable only through nginx (it binds `127.0.0.1`). If you ever put a load balancer or CDN in front of
nginx, add `set_real_ip_from <its range>; real_ip_header X-Forwarded-For;` to the `http` block so `$remote_addr` is the visitor.

**Security headers.** The API sends its own (helmet: `default-src 'none'`, `frame-ancestors 'none'`, nosniff, no-referrer, same-origin
resource and opener policies, HSTS when `COOKIE_SECURE=true`). For the dashboard pages that Next.js produces, nginx adds the matching
set plus a Content-Security-Policy that allows the dashboard's inline styles and theme script, its embedded fonts, same-origin
requests, and `https://*.amazonaws.com` for photo uploads and downloads. The API locations get no nginx headers, so none is sent
twice. **The CSP ships as `Content-Security-Policy-Report-Only`** because it has not been exercised in a browser against the finished
dashboard. A static look at a built `.next-live` found nothing that conflicts with it (scripts are same-origin files plus Next's inline
data and theme scripts, no `eval` or `new Function` in the bundles, fonts are served from `/fonts/`, no third-party URLs), so enforcing
it is expected to work; open every screen with the console visible, and when no violation is reported run
`install.sh ... --csp enforce` (it rewrites one file and reloads nginx).

**TLS.** TLS 1.2 and 1.3, modern ECDHE ciphers, no session tickets, HTTP/2, no OCSP stapling (Let's Encrypt stopped running OCSP responders; the template says how to turn it on for a certificate that has one). HSTS is sent for 180 days.

Check a change with `nginx -t` before reloading (`install.sh` does). nginx itself could not be run while this kit was written (see
"What was and was not verified").

## The tailnet side: the SMS Gate webhook

The tablet posts delivery receipts and customer replies to the backend over Tailscale. `deploy/scripts/tailscale-serve.sh` exposes
exactly one mount:

```
https://<host>.<tailnet>.ts.net:8443/hooks/smsgate/<deviceKey>  ->  http://127.0.0.1:3002/hooks/smsgate/<deviceKey>
```

* `tailscale serve` strips the mount path before proxying, so the target carries the full path again
  (`docs/integrations/smsgate.md`, item 8).
* It refuses a node that already serves something else (use `--reset` to replace it), never uses Funnel (the public internet), and
  reads the configuration back afterwards: anything other than exactly this mount is an error.
* Port **8443**, not 443: nginx owns 443 and sharing it with tailscaled is unverified. The tablet accepts any HTTPS port. Tailscale ACL
  to match: `tag:oasis-tablet` may reach `tag:oasis-server:8443`, and `tag:oasis-server` may reach `tag:oasis-tablet:8080`. Disable key
  expiry on both nodes (the default 180 days silently disconnects the tablet).
* Put the URL it prints into `SMSGATE_WEBHOOK_PUBLIC_URL` in `common.env`, restart `oasis-api`; the API registers it with the tablet
  at boot and hourly.

Tablet setup, replacing a tablet and failure handling are in [runbook.md](runbook.md) and `docs/integrations/smsgate.md`.

## Deploying and rolling back

```bash
sudo /opt/oasis/current/backend/deploy/scripts/deploy.sh            # latest origin/main of both repositories
sudo .../deploy.sh --backend-ref origin/some-branch --dashboard-ref <sha> --dry-run
sudo .../rollback.sh --list ; sudo .../rollback.sh [--to <release id>]
```

`deploy.sh`: fetch; stop here if the current release already has these two commits; export both trees (`git archive`) into
`releases/<id>`; `pnpm install --frozen-lockfile`; `pnpm build` (API) and `pnpm build:live` (dashboard); a `pre-deploy` backup;
`pnpm migrate up` with the new code while the old release still serves; point `current` at the new release; restart worker, API and
dashboard; wait up to 90 seconds for `healthcheck.sh`. Unhealthy, or a service that will not restart: it points `current` back,
restarts, health-checks again and exits 1, keeping the failed build as `<id>.failed`.

* A build or migration failure changes nothing that runs. The migration is one transaction per file, so a failed one leaves the schema
  as it was.
* **Migrations are forward-only and a rollback does not undo them.** The old code then runs against the migrated schema, so every
  migration must stay compatible with the release before it (add columns and tables first, remove things in a later release). If a
  migration breaks that rule, roll back the code and restore the pre-deploy backup ([runbook.md](runbook.md), "Roll back").
* The script that runs is the one in the release that is live (the first deployment uses the clone in `src/`); a release that changes
  `deploy/` takes effect from the deploy after it, and `deploy.sh` says when the units, nginx or env templates changed so you can re-run `install.sh`.
* One deploy at a time (a lock); it keeps the newest 4 releases plus `current` and `previous`, and at most 2 failed builds.
* `HEALTH_CMD`, `BACKUP_CMD`, `SYSTEMCTL` and `OASIS_RUN_AS` override the commands it calls (the tests use them).

## Backups and the restore drill

`backup.sh` writes one consistent `pg_dump -Fc` per run. It exports a snapshot, dumps with `--snapshot`, and counts every table's rows
in the same snapshot, so the manifest's numbers are exactly what the dump contains even while the app is writing.

| Directory | Contents | Kept |
|---|---|---|
| `daily/` | every nightly run, plus `pre-deploy`, `pre-rotate` and `manual` ones | 7 nightly, 5 of each other label |
| `weekly/` | hard link of the Sunday nightly | 4 |
| `monthly/` | hard link of the nightly taken on the 1st | 12 |

Each backup has `<name>.sha256` and `<name>.manifest.json` (row counts per table, migrations applied, release, sizes). Off-host copy:
set `BACKUP_S3_URI=s3://bucket/prefix` (and `BACKUP_ENCRYPTION_KEY_FILE`, made with `node deploy/lib/backup-crypt.mjs keygen FILE`) in
`/etc/oasis/backup.env`; the upload is encrypted on the host with AES-256-GCM before it leaves, plus S3 server-side encryption, and a
plain dump is never uploaded. The IAM policy for that bucket needs only `s3:PutObject` on the prefix; add a lifecycle rule for
expiry. Keep the key file somewhere else too.

`restore-drill.sh` proves a backup is usable, monthly and on demand: checks the checksum, restores into a scratch database (the
`oasis_drill` role, which may create databases and nothing else), and verifies that the row counts equal the manifest, the migration
count matches, and the **ledger invariants** hold (recomputed from `ledger_events`: paid and refunded of every invoice equal the sum of
its events, balances are never negative and equal `max(0, total - paid)`, sequence numbers are unique, every event has an invoice, the
append-only guard trigger exists). `ledger-check.sh` runs exactly those ledger checks, read-only, against the live database. The drill drops
the scratch copy afterwards. A failure goes to `systemctl --failed` and `failures.log`.
`--mode schema --schema NAME` does the same inside a scratch schema, for a host where no database can be created.

## Secrets

* `SECRETS_KEY` rotates with `deploy/scripts/secrets-rotate.sh` (`pnpm secrets:rotate` underneath): dry run, backup, stop API and
  worker, re-encrypt every credential in one read-back-verified transaction, replace the key in `common.env`, start, health-check.
* Everything else (session secret, database password, tablet and Squarespace credentials, AWS access) is in
  [runbook.md](runbook.md), "Rotate secrets".
* `deploy/scripts/gen-secrets.sh` prints freshly generated values from the system CSPRNG.

## Logs and monitoring

* Services log to journald (JSON lines from pino; `journalctl -u oasis-api -o cat | jq`). `journald.conf.d/oasis.conf` makes the journal
  persistent and bounded (1 GB, one month).
* nginx: `/var/log/nginx/oasis.access.log` carries `rid=<request id>` that equals `X-Request-Id` in the API log and in every error body.
  logrotate keeps 14 days of nginx logs and 12 weeks of `/var/log/oasis/*.log`.
* `oasis-healthcheck.timer` runs every 5 minutes. For an outside view, point an uptime monitor at `https://<domain>/healthz`, and run
  `healthcheck.sh --public https://<domain>` from somewhere else to confirm that `/hooks/smsgate` answers 404 from outside.
* Inside the app, "Needs attention" shows an offline tablet, orders waiting for a match, card money not confirmed after two hours, and
  sync failures.

## What was and was not verified

Written and tested on this machine without installing anything or touching the running system.

Verified by tests (`pnpm test:ops-kit`):
* the env templates against `src/config/env.ts`; the generated production environment boots `src/server.ts` as a real process with
  `NODE_ENV=production`, passes the health check, sends the security headers, and honours `X-Forwarded-For`;
* every unit with `systemd-analyze verify` and `systemd-analyze security` (offline);
* the nginx configuration structurally (a parser, nginx's location-selection rules applied to representative URLs, duplicate
  directives, zones, includes, header values);
* `install.sh` (staging directory, dry run, idempotence), `deploy.sh` and `rollback.sh` (real git repositories; stand-ins for pnpm,
  systemctl, the health check and the backup), `healthcheck.sh`, `tailscale-serve.sh` (a stand-in `tailscale`), `bootstrap-admin.sh`,
  `gen-secrets.sh`, `secrets-rotate.sh`, `reset-password.sh` (against the real database), `oasis-admin.sh` (against the real API
  process, with the SMS Gate and Squarespace simulators);
* `backup.sh` and `restore-drill.sh` with real `pg_dump` and `pg_restore` on the seeded ledger: exact snapshot counts, retention, hard
  links, encryption round trip, and detection of a corrupted file, a wrong manifest, a drifted calculation and a missing guard trigger.

Not verified (needs the real thing):
* **nginx** (`nginx -t` and a real request; nginx is not installed here), certbot, and the dnf package names (`nodejs22`, `certbot`,
  `postgresql15-server`) and the `pg_hba.conf` edit that `--install-packages --install-postgres` perform;
* **shellcheck** is not installed on the build host. It was run once from a temporary Python virtualenv (`pip install shellcheck-py`, version
  0.11.0, nothing installed system-wide) and the scripts are clean at warning level; the test suite runs it only when `shellcheck` is
  on the PATH or named in `SHELLCHECK`, and otherwise relies on `bash -n`, structural tests and execution;
* `tailscale serve`: the JSON shape that `serve-check.mjs` reads follows Tailscale's `ServeConfig` type and the stand-in follows the
  same; confirm with `tailscale-serve.sh --status` on the host. Whether tailscaled and nginx can both use port 443 is untested (hence 8443);
* the restore drill in **database mode** (the test role may not create databases here; schema mode was run);
* the dashboard's CSP in a browser (hence report-only), the systemd hardening under a real `systemctl start`, S3 upload of backups
  with the real `aws` CLI, and the first-boot `BOOTSTRAP_ADMIN` flow on a real empty database through `install.sh`.

## Known gaps in the application that affect deployment

Found while building the kit; none is changed here because the files belong to other work.

1. `S3_KEY_PREFIX`, `S3_SSE`, `S3_KMS_KEY_ID`, `S3_ENDPOINT`, `S3_FORCE_PATH_STYLE`, `STORAGE_SIGNING_SECRET` and `SES_SNS_TOPIC_ARNS` are
   documented in `docs/integrations/{s3,ses}.md` as variables for the integrator to add to the environment schema, but
   `src/config/env.ts` does not declare them, and zod drops undeclared keys, so the app ignores them. Until they are declared the
   app writes photos at the bucket root with no encryption header: give its IAM role the whole bucket, not a `prod/*` prefix.
   `pnpm verify:aws` reports this (item AWS-S5).
2. `SQSP_PROVIDER=live` requires `SQSP_API_KEY` in the environment, so a key stored encrypted in the database (the route that exists for
   it) cannot be the only copy. Put the key in `common.env` too (the stored key wins when both exist).
3. `SMS_PROVIDER=smsgate` requires the four `SMSGATE_*` device values in the environment although the running app reads the tablet from
   `sms_devices`. Keep them equal to the device's (and note `secrets-rotate` does not touch these plaintext copies).
4. No `/hooks/ses` route is mounted yet; nginx already forwards that path for when it is.
5. The SMS devices and the Squarespace connection have no dashboard screen; `deploy/scripts/oasis-admin.sh` drives the API for them.
