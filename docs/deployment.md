# Deployment

How Oasis Auto Spa runs in production on one Amazon Linux 2023 host, and the kit in `deploy/` that sets it up, updates it, backs it
up and brings it back. The day-to-day procedures (what to do when something breaks) are in [runbook.md](runbook.md); proving the
tablet, Squarespace and AWS work is in [live-verification.md](live-verification.md). Decisions: ADRs 0100 to 0103, 0130 to 0133
for the environment in AWS Secrets Manager and the app's AWS identity, and 0140 to 0144 for the launch-day hardening.

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
| `/usr/local/lib/oasis/deploy` | **the deploy kit root runs**: a copy of `deploy/`, `root:root`, writable by root only. `install.sh` puts it there; every deploy that goes live healthy refreshes it from its release. Units and operators run `deploy.sh`, `rollback.sh`, `backup.sh`, `healthcheck.sh`, `secrets-rotate.sh`, `install.sh` ... from here |
| `/opt/oasis`, `/opt/oasis/releases` | `root:root 0755` |
| `/opt/oasis/src/backend`, `/opt/oasis/src/dashboard` | git clones, the oasis user's (read-only deploy keys, or the root-owned local mirrors). `deploy.sh` fetches into them |
| `/opt/oasis/releases/<id>/{backend,dashboard}` | one built release each: source, `node_modules`, `dist/`, `.next-live/`, `REVISIONS`; `root:oasis`, read-only for the services. Built as oasis in `<id>.partial` |
| `/opt/oasis/current`, `/opt/oasis/previous` | symlinks to the running release and the one before it |
| `/var/cache/oasis-web` | Next.js's runtime cache (`.next-live/cache` in a release is a symlink to it); systemd creates it for `oasis-web` (`CacheDirectory=`) and the unit empties it at each start |
| `/etc/oasis/{common,api,worker,web}.env` | the NON-secret environment, `0640 root:oasis`; `common.env` names the secret (`OASIS_SECRET_ID`). `drill.env` (restore drill role) and `backup.env` (optional) beside them |
| AWS Secrets Manager secret `oasis/prod/app` | the secret settings: `DATABASE_URL`, `SESSION_SECRET`, `SECRETS_KEY`, `STORAGE_SIGNING_SECRET`, `BOOTSTRAP_ADMIN_*` (first boot only), API keys. Read by every program at start; written only with `pnpm secrets:push` |
| `/etc/oasis/aws-credentials` | runtime=user only: the `oasis-app` key, `0600 root:root`; systemd hands the services a private copy. Absent with the instance role (the recommendation) |
| `/etc/oasis/secret-seed.env` | a new install only: the generated secret settings (`0600 root:root`) until they are pushed into the secret; then shredded |
| `/etc/systemd/system/oasis*.{service,timer,target}` | the units |
| `/etc/nginx/conf.d/oasis.conf`, `00-oasis-zones.conf`, `/etc/nginx/oasis/{proxy,security-headers,tls}.conf` | the dashboard site; `tls.conf` holds the TLS settings every HTTPS server shares |
| `/etc/nginx/conf.d/oasis-site.conf`, `/etc/nginx/oasis/site-headers.conf` | the public website's servers and headers (`install.sh --site-domain`; a port-80 bootstrap until its certificate exists) |
| `/var/www/site/releases/<id>`, `/var/www/site/current`, `previous` | the public website: one verified static build per release (`dist/` plus `REVISION`), `root:root`, read-only; nginx serves `current` (ADR 0145). `releases/bootstrap` is the placeholder page install.sh puts there first |
| `/opt/oasis/git/site.git` | the root-only bare mirror the website is built from (`site-deploy.sh` refuses any other owner or a group/other-writable file) |
| `/etc/oasis/site.env` | the website's settings (`SITE_DOMAIN`, `SITE_URL`, `SITE_ROOT`, `SITE_MIRROR`, `SITE_BUILD_DIR`, `SITE_MARKER`, `SITE_KEEP`), `0644 root:root`, rendered from the `install.sh --site-*` options on every run; nothing secret |
| `/var/cache/nginx/oasis_public` | nginx's 60-second cache of the website's read-only API answers (`/api/v1/public/hours`, `/availability`, `/catalog`) |
| `/var/lib/oasis` | state: `files/` (filesystem storage), `mail/` (simulated mail), `drills/` (restore-drill results), the service user's home |
| `/var/backups/oasis/{daily,weekly,monthly}` | database backups |
| `/var/log/oasis/{deploy.log,deploys.list,failures.log}` | deploy history and failed timers (the services themselves log to journald) |

Users: `oasis` (system user, no shell) runs the services, the builds and the migrations, but owns neither the code it runs nor the
kit root runs; only `deploy.sh`, `rollback.sh` and `install.sh` need root, and they drop to `oasis` for the work. See "Privilege
separation" below.

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
* Order of work: host checks, packages, the `oasis` user and directories, the env files (naming the secret: `--secret-id`, default
  `oasis/prod/app`, and `--aws-region`, default `us-east-1`; the secret settings are generated into `/etc/oasis/secret-seed.env`, never
  into the env files), the database role and database (from the seed's `DATABASE_URL`), deploy keys and clones, systemd units (plus
  the runtime=user drop-ins, `--aws-runtime role|user`, default role), journald and logrotate settings, nginx and TLS. It does not
  start the application; `deploy.sh` does.
* **Before the first start, push the seed into the secret** and shred it (the commands are printed; [aws-setup.md](aws-setup.md),
  step 6): `sudo install -m 600 -o $USER /etc/oasis/secret-seed.env ~/oasis-secret.env`,
  `pnpm secrets:push --profile <operator profile> --secret-id oasis/prod/app --from ~/oasis-secret.env --apply`,
  `shred -u ~/oasis-secret.env && sudo shred -u /etc/oasis/secret-seed.env`. `deploy.sh` warns while the seed exists.
* `--secrets-in-files` keeps the old layout (secrets generated into `common.env`) for a host without AWS; everything below works with
  it too, and `--move-secrets` moves such a host later.
* `--site-domain <apex>` adds the public website (ADR 0145; [runbook.md](runbook.md), "The public website"): `/etc/oasis/site.env`,
  root-owned `/var/www/site` with a placeholder release, the site's nginx servers (a port-80 bootstrap until the certificate exists),
  and in certbot mode one certificate for the apex and `www` (a warning, not an error, while their DNS records do not point here yet:
  re-run with the same options once they do). `--site-root`, `--site-tls-cert/--site-tls-key` (with `--tls files`), `--site-csp`
  and `--site-marker` refine it; they belong to "the same options" every later run repeats.
* TLS: `--tls certbot` (default) installs a port-80-only site, obtains a Let's Encrypt certificate with the webroot challenge, then
  installs the full site and a renewal hook that reloads nginx. `--tls files --tls-cert F --tls-key F` uses certificates you supply.
* **Copy `SECRETS_KEY` (from the seed, before you shred it) into a password manager now.** It decrypts the tablet and Squarespace
  credentials stored in the database; the database backups are useless for those without it. The secret keeps it too, but a
  password-manager copy survives a deleted secret or a lost AWS account.

### Environment files

`deploy/env/*.env.example` document every variable of `src/config/env.ts` (a test fails if one is missing or undocumented).
`common.env` is read by the API and the worker (non-secret settings, the name of the secret, integrations), then `api.env` or `worker.env` on top;
`web.env` belongs to the dashboard alone. **The files hold no secret.** Every program (the services, `pnpm migrate`, the seed runner,
`secrets:rotate`, `verify:*`, the password reset; `src/config/secrets-source.ts`) reads the secret named by `OASIS_SECRET_ID` at start,
in `AWS_REGION`, and fills what the process environment does not set; the API and the worker read the same secret, so they can never
disagree about `SECRETS_KEY`. The shell scripts that need a secret value (`backup.sh`, `ledger-check.sh`, the restore drill,
`bootstrap-admin.sh status`, `secrets-rotate.sh`) get it the same way through `scripts/secret-env.ts`, into a variable, never printed.

Which keys go into the secret (the templates keep them commented out, a test holds the list): `DATABASE_URL`, `SESSION_SECRET`,
`SECRETS_KEY`, `STORAGE_SIGNING_SECRET`, `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD` (first boot only), `SQSP_API_KEY` and
`SQSP_WEBHOOK_SECRET` (if used), `SMSGATE_PASSWORD` and `SMSGATE_WEBHOOK_SECRET` (only for `verify:smsgate`). Never in the secret:
`OASIS_SECRET_ID`, `AWS_REGION` and AWS credentials (both the app and `secrets:push` refuse them). Any other declared setting may
live there, but non-secret settings belong in the files, where they can be read.

**Precedence:** a non-empty `NAME=value` line in an env file (or the process environment) wins over the secret, so one host can
override one setting; an empty line counts as unset. The start-up line in the journal says what came from where, names only:
`environment: 4 setting(s) from Secrets Manager secret oasis/prod/app (us-east-1); set in the process environment and kept: ...`.
A problem stops the service with one line (`secret ... does not exist`, `access denied reading secret ...`, `holds keys the
environment contract does not declare: ...`); no value of the secret is ever logged. A changed secret takes effect at the next start.

**The app's AWS identity** (`install.sh --aws-runtime`, [aws-setup.md](aws-setup.md), ADR 0133):
* `role` (default, recommended): nothing on the host; the SDK gets the instance role's credentials (`oasis-app-role` through the
  instance profile `oasis-app-profile`). `AWS_EC2_METADATA_DISABLED` must stay unset.
* `user`: `/etc/oasis/aws-credentials` (the `oasis-app` key in the AWS credentials file format, `0600 root:root`). install.sh adds
  `oasis-{api,worker,backup,restore-drill}.service.d/10-oasis-aws-credentials.conf`: `LoadCredential=aws-credentials:/etc/oasis/aws-credentials`
  (systemd reads the root-only file and gives the service a private copy that only the service user can read),
  `AWS_SHARED_CREDENTIALS_FILE=%d/aws-credentials` and `AWS_EC2_METADATA_DISABLED=true`. The deploy scripts that run a command as
  `oasis` from root (migrate, verify, the pre-deploy backup) hand it a private temporary copy for that command. `--aws-runtime role`
  removes the drop-ins again.

Rules, because systemd reads these files and a shell does not: `NAME=value` per line, comments on their own line (a `#` after a value
becomes part of the value), single quotes around anything with spaces or braces, no `export`. An empty value is not "unset": the app
rejects `BOOTSTRAP_ADMIN_EMAIL=` and similar, which is why optional settings are commented out in the templates.

Production switches that matter: `NODE_ENV=production`, `TRUST_PROXY=true` and `COOKIE_SECURE=true` (api.env), `HOST=127.0.0.1`,
`SMS_DISPATCH_MODE=jobs` (the worker sends texts), and none of `DEV_AUTH_BYPASS`, `CLOCK_FREEZE_AT`, `ALLOW_DEV_ENDPOINTS`.

AWS: `pnpm aws:provision` ([aws-setup.md](aws-setup.md)) creates the buckets, the secret, the app's identity and (later, with a sender)
the SES identity, configuration set and feedback topic; it prints the non-secret lines for `common.env` (`OASIS_SECRET_ID`,
`AWS_REGION`, `STORAGE_PROVIDER`, `S3_BUCKET`, `S3_KEY_PREFIX`, `BACKUP_S3_URI`, and with a sender `EMAIL_PROVIDER`, `SES_FROM_ADDRESS`,
`SES_CONFIGURATION_SET`, `SES_SNS_TOPIC_ARNS`). `SQSP_PROVIDER=live` needs no `SQSP_API_KEY` when the key is stored with `sqsp-connect`,
and `SMS_PROVIDER=smsgate` needs no `SMSGATE_*` device values (the app reads the tablets from the database).

### Move an existing host to the secret

A host installed before the secret (or with `--secrets-in-files`) keeps `DATABASE_URL`, `SESSION_SECRET` and `SECRETS_KEY` in
`common.env` (and perhaps `BOOTSTRAP_ADMIN_*` in `api.env`). After `pnpm aws:provision` created the secret and the identity:

```bash
sudo install -m 600 -o $USER /etc/oasis/common.env ~/common.env.copy
pnpm secrets:push --profile oasis-admin --secret-id oasis/prod/app --from ~/common.env.copy      --keys DATABASE_URL,SESSION_SECRET,SECRETS_KEY            # the plan: + for each, values never shown
pnpm secrets:push ...same... --apply && shred -u ~/common.env.copy
sudo /opt/oasis/current/backend/deploy/scripts/install.sh --domain <host> --move-secrets [--aws-runtime role|user]
sudo systemctl restart oasis-api oasis-worker            # the journal shows "environment: 3 setting(s) from Secrets Manager secret ..."
sudo shred -u /etc/oasis/*.env.bak-*                      # once it runs: the backups install.sh kept still hold the values
```

`--move-secrets` first reads the secret with the app's identity and compares, in memory, every secret key the env files still set
with the secret's value; a key that is missing or different stops it and nothing changes. Then it writes `OASIS_SECRET_ID` and
`AWS_REGION` into `common.env` and removes those lines (keeping `*.env.bak-<time>`). Run it from the current release (it needs the
release's `node_modules`).

### First Super Admin

`sudo deploy/scripts/bootstrap-admin.sh set you@example.com --profile <operator profile>` generates a password, puts
`BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD` into the secret with `pnpm secrets:push` (as root: the profile is root's, or keep
`AWS_SHARED_CREDENTIALS_FILE`/`AWS_CONFIG_FILE` through `sudo --preserve-env`) and prints the password once. On the next API start, if
the database has no user at all, the Super Admin and the five built-in roles are created. Sign in, change the password, then
`bootstrap-admin.sh clear --profile <operator profile>` and restart the API. On any later start the variables do nothing. (A host
without the secret gets the two lines in `api.env` instead, without `--profile`.)

## The services

| Unit | Runs | Notes |
|---|---|---|
| `oasis-api` | `node dist/server.js` as `oasis` | loopback `:4000` (API) and `:3002` (hooks). 30 s to stop gracefully. `MemoryMax=1500M` |
| `oasis-worker` | `node dist/worker.js` | pg-boss jobs. 45 s to stop. `MemoryMax=1000M` |
| `oasis-web` | `next start` on `:3200`, live variant | `NEXT_PUBLIC_VARIANT=live`, `DIST_DIR=.next-live`, the same as `pnpm start:live` |
| `oasis-backup.timer` / `.service` | `backup.sh --label nightly` at 03:15 shop time | retention below |
| `oasis-restore-drill.timer` / `.service` | `restore-drill.sh --latest` on the 2nd of each month | enabled when `/etc/oasis/drill.env` exists |
| `oasis-healthcheck.timer` / `.service` | `healthcheck.sh --quiet` every 5 minutes: API ready, dashboard up, the public sign-in redirect, the worker active | a failing run shows in `systemctl --failed` |
| `oasis-imds-guard.service` | an iptables chain: only root, `oasis` and `ec2-instance-connect` reach the metadata service | below, "Instance metadata guard" |
| `oasis-notify-failure@.service` | records a failed backup or drill in `/var/log/oasis/failures.log` and runs `/etc/oasis/notify-failure.sh UNIT` if you create it | wire your email or SMS there |

All three services restart on failure (3 s delay, at most 8 starts in 5 minutes), start after the network, and run sandboxed. They do
not depend on a local PostgreSQL (production uses Aurora, and nothing should start the development server at boot); on a host whose
database IS the local server, `install.sh --local-db` adds `Wants=`/`After=postgresql.service` as a drop-in
(`oasis-{api,worker,backup,restore-drill}.service.d/20-oasis-local-db.conf`), which a later run without the flag keeps. Sandboxing:
`NoNewPrivileges`, `ProtectSystem=strict` (only `/var/lib/oasis` is writable, and for the dashboard its cache directory `/var/cache/oasis-web`),
`ProtectHome`, `PrivateTmp`, `PrivateDevices`, kernel and control-group protections, `RestrictAddressFamilies` (IP and Unix sockets),
an empty capability set, `SystemCallFilter=@system-service`, `UMask=0077`. `systemd-analyze security` rates the API at 1.7 ("OK").
`MemoryDenyWriteExecute` is deliberately off: V8 needs writable and executable memory.

Handy: `systemctl status oasis-api oasis-worker oasis-web`, `journalctl -u oasis-api -f`, `systemctl list-timers 'oasis*'`.

### Instance metadata guard

With the instance role (runtime=role) every local process could ask the instance metadata service (`169.254.169.254`) for the
role's credentials, and through them read the environment secret. `oasis-imds-guard.service` (a oneshot, enabled and started by
`install.sh`, ordered before `network-pre.target` and the Oasis units) adds an iptables chain `OASIS-IMDS`, jumped to from `OUTPUT` for
that address, which lets through only:

* **root** (uid 0). It must stay allowed: `amazon-ec2-net-utils` (`policy-routes@ens5`, `refresh-policy-routes`) runs as root and
  rebuilds the secondary private IP `172.31.20.222`, which carries the website's Elastic IP, from the metadata at boot and on every
  refresh. Blocking root would take the site down at the next refresh. cloud-init, the SSM agent and tailscaled are root too.
* **oasis**: the API, the worker and the backup read the secret and S3 with the role.
* **ec2-instance-connect**: the EC2 console's Connect button (its `AuthorizedKeysCommand` runs as that user); added only when the user
  exists.

Everyone else is rejected: by design `ec2-user` tools (`ec2-metadata`, the AWS CLI or SDK falling back to the instance) get "connection
refused"; use an explicit profile with `AWS_EC2_METADATA_DISABLED=true`, or `sudo`. A process that can `sudo` is root, so this stops
only what does not. `oasis-web` additionally has `IPAddressDeny=169.254.169.254/32` (it needs no AWS). chronyd's
`169.254.169.123` and the DNS resolver's `169.254.169.253` are other addresses and unaffected; IPv6 metadata is off on this instance
(if it is ever turned on, add the same rule with `ip6tables` for `fd00:ec2::254`). Starting it twice rebuilds the chain and never adds
a second jump; stopping removes the jump and the chain.

Check: `sudo iptables -S OASIS-IMDS` (`--uid-owner 0`, the oasis uid, the ec2-instance-connect uid, then `REJECT`) and
`sudo iptables -S OUTPUT | head -2`. **Emergency removal:** `sudo systemctl disable --now oasis-imds-guard`, or by hand
`sudo iptables -D OUTPUT -d 169.254.169.254/32 -j OASIS-IMDS; sudo iptables -F OASIS-IMDS; sudo iptables -X OASIS-IMDS`.

## nginx

| URL | Goes to | Notes |
|---|---|---|
| another name, or a bare IP address | nothing | port 80: the connection is closed without an answer (444); port 443: the TLS handshake is refused (`ssl_reject_handshake`), so not even the certificate shows |
| `http://` the domain | 301 to `https://` | except `/.well-known/acme-challenge/` |
| `/` | dashboard `:3200` | security headers below |
| `/api/*` | API `:4000` | rate zone `oasis_api` (30 requests/s per address, burst 60); `^~`, so no regular expression below applies |
| any other letter case of `/api`, `/dev-storage`, `/hooks` (`/API/...`, `/Dev-Storage/...`) | nothing: 404 | the dashboard's rewrites are case-insensitive and would hand them to the API around the rules here |
| `/api/v1/auth/{login,password/forgot,password/reset,invite/accept}` | API | zone `oasis_login` (30 a minute, burst 10) |
| `/api/v1/events` | API | server-sent events: `proxy_buffering off`, no compression, one-hour reads |
| `/hooks/squarespace`, `/hooks/ses` | API | POST only, 1 MB body limit, zone `oasis_hooks`; signatures are checked by the app |
| `/hooks/*` (including `/hooks/smsgate/*`), `/dev-storage/*` | nothing: 404 | the SMS webhook is tailnet-only |
| `/healthz` | API | public liveness |
| `/readyz`, `/api/v1/openapi.json` | API | this host only (readiness shows database and migration detail) |

The public website (`install.sh --site-domain <apex>`; `oasis-site.conf`, ADR 0145), on its own two names:

| URL | Goes to | Notes |
|---|---|---|
| `http://<apex>`, `http://www.<apex>` | 301 to `https://<apex>` | except `/.well-known/acme-challenge/` (certbot's webroot) |
| `https://www.<apex>` | 301 to `https://<apex>` | one canonical name; HSTS and nosniff on the redirect too |
| `https://<apex>/`, `/about`, `/about/` | files of `/var/www/site/current` | clean URLs (`about.html` or `about/index.html`), `Cache-Control: no-cache`, the site's headers (CSP, `X-Frame-Options: DENY`, referrer policy, COOP/CORP); `error_page 404 /404.html` |
| `/assets/*` | files | content-hashed: `public, max-age=31536000, immutable` |
| other static types (`.css .js .png .svg .woff2 .txt .xml .json ...`) | files | `public, max-age=86400` |
| `/api/v1/public/hours`, `/api/v1/public/availability`, `/api/v1/public/catalog` | API `:4000`, exactly these paths, GET only (403 otherwise) | the opening hours, the open-times board and the catalog; `Cookie` stripped on the way in, `Set-Cookie` on the way out; zone `oasis_api` (burst 20); `proxy_cache oasis_public` 60 s per URL (query string included) with `proxy_cache_lock` and stale answers while refreshing or when the API is down; `X-Cache-Status` says HIT or MISS |
| any other `/api/v1/public/...` path (the writes: `otp`, `otp/verify`, `bookings`, `memberships`) | API `:4000`, path unchanged | never cached, cookies stripped both ways, zone `oasis_public_post` (20 a minute per address, burst 10); the API's own per-phone and per-address limits, `Idempotency-Key` and honeypot apply behind it (ADR 0150). The API must list the website's origin: `PUBLIC_SITE_URL=https://<apex>` in `common.env` (its POSTs carry `Origin`) |
| any other `/api`, `/hooks`, `/dev-storage` path, any letter case | nothing: 404 JSON | the API is the dashboard's; the website never needs CORS |
| dotfiles (except `/.well-known`), `/REVISION` | nothing: 404 | |

**The site build contract** (what `site-deploy.sh` expects of the site repository): `pnpm install --frozen-lockfile && pnpm build`
runs as the oasis user with `HOME=/var/lib/oasis`, `CI=1`, `NODE_OPTIONS=--max-old-space-size=2048`, `SITE_URL=https://<apex>` and,
when the API answered, `SITE_HOURS_JSON=<path of a snapshot of /api/v1/public/hours>` (unset otherwise: the build must have a fallback
and the browser asks the live endpoint). It must write `dist/` (`SITE_BUILD_DIR` in `site.env`) with `index.html` (over 1 KB,
containing the marker text `SITE_MARKER`, "Oasis Auto Spa" by default) and `404.html`, content-hashed files under `assets/`, no
symbolic link, no file over 25 MB, 50 KB to 200 MB in all, no `localhost`/`127.0.0.1`/`0.0.0.0`/`:3000`/`:4000`/`:4321` URL in any
html/js/css, and no inline `<script>` (the policy allows none; `<script type="application/ld+json">` data blocks are fine). A build
that breaks the contract is kept as `releases/<id>.failed` and nothing is served.

**Real client address.** The API runs with `TRUST_PROXY=true`, which makes Fastify believe the first address in `X-Forwarded-For`.
nginx therefore overwrites the header with `$remote_addr` (`proxy_set_header X-Forwarded-For $remote_addr`) and never appends to what a
client sent, and the API is reachable only through nginx (it binds `127.0.0.1`). If you ever put a load balancer or CDN in front of
nginx, add `set_real_ip_from <its range>; real_ip_header X-Forwarded-For;` to the `http` block so `$remote_addr` is the visitor.

**Every answer carries HSTS and nosniff**, nginx's own included (the 403 of `/readyz`, the 404 of `/hooks/*`, a 413 for a large
body, a 429 from a rate zone, a 502 while a service restarts): the HTTPS server adds `Strict-Transport-Security` and
`X-Content-Type-Options` with `always`, and `proxy.conf` hides the API's and the dashboard's copies of those two, so a proxied
answer still has exactly one of each. (Connections closed with 444 carry nothing, by design.)

**Security headers.** The API sends its own (helmet: `default-src 'none'`, `frame-ancestors 'none'`, nosniff, no-referrer, same-origin
resource and opener policies, HSTS when `COOKIE_SECURE=true`); the API locations get no nginx headers, so none is sent twice. The
dashboard (next.config.mjs, production build of the live variant) sends its own set and an **enforced Content-Security-Policy** that pins
its one inline script by hash (no `unsafe-inline` for scripts, no `eval`), allows `https://*.amazonaws.com` for photo uploads and
downloads and forbids framing. On the dashboard location nginx adds the matching general headers at the strictest value
(`X-Frame-Options: DENY`, HSTS with `includeSubDomains`, `Permissions-Policy` with `usb=()`) and hides the dashboard's copies of the same
headers, so each arrives exactly once (two different `X-Frame-Options` values make browsers ignore it). The CSP is the dashboard's:
`install.sh --csp app` (the default) adds none from nginx; `--csp report-only` or `--csp enforce` add nginx's broader policy as well (two
enforced policies both apply, so the stricter one wins), `--csp off` adds none.

**TLS.** TLS 1.2 and 1.3, modern ECDHE ciphers, no session tickets, HTTP/2, no OCSP stapling (Let's Encrypt stopped running OCSP responders; the template says how to turn it on for a certificate that has one). HSTS is sent for 180 days with `includeSubDomains`: safe because every name under the domain that answers is HTTPS only (the dashboard, the website, `www`). The settings are one shared file, `/etc/nginx/oasis/tls.conf` (`oasis-tls.conf.template`), included by every HTTPS server; the certificates stay in the server blocks.

Check a change with `nginx -t` before reloading (`install.sh` does). The tests run the rendered site in a real nginx when one is
installed (an unprivileged instance on loopback ports with stub upstreams): `nginx -t`, the default servers, the letter-case rule,
and the headers on proxied answers and on nginx's own 403, 404, 413 and 429; and the website next to it (`test/ops-kit/deploy-site.test.ts`):
pages, the 404 page, cached assets, the www and http redirects, the ACME path, the hours proxied once without cookies and then from
the cache, and the rest of the API refused.

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

## Privilege separation

Root must never execute a file the oasis user can write (review M2): the oasis user runs `pnpm install` with every dependency's
install scripts, and the internet-facing services. So:

* **The kit root runs is a root-owned copy**, `/usr/local/lib/oasis/deploy` (`root:root`, nothing writable by group or others,
  swapped in whole). `install.sh` installs it from the `deploy/` it was started from (or leaves it alone when started from the copy
  itself); `deploy.sh` refreshes it from each release after that release went live healthy. The units (`oasis-backup`,
  `oasis-healthcheck`, `oasis-restore-drill`) and the runbook run the scripts from there. When it runs from anywhere else, `deploy.sh`
  says so.
* **Releases are root-owned and read-only.** `deploy.sh` builds as oasis in `releases/<id>.partial` (oasis-owned staging), then makes it
  `root:oasis` with `chown -R -h` (links are never followed) and `chmod -R g+rX,go-w`, and only then renames it into place.
  `/opt/oasis` and `/opt/oasis/releases` are `root:root`, so the oasis user can neither rename a release nor touch `current`. The services
  read and execute the release (group oasis) and cannot change the code that runs next.
* **The kit is checked against the mirror.** When `/opt/oasis/git/backend.git` exists and only root can change it (the production
  host's mirror; the path is fixed, not taken from the clone's `origin`, which the oasis user could repoint), `deploy.sh` compares the
  built release's `deploy/` with the commit's `deploy/` read by root from that mirror, before the backup and the migration; a
  difference (a build step changed the kit) or a commit the mirror does not have stops the deploy, nothing changes, the build is kept
  as `<id>.failed`. A mirror that group or others can write is reported and not trusted. Without a mirror (a host that pulls from
  GitHub) the release's kit is copied as built, and the log says it was not cross-checked.
* **The dashboard writes nowhere in the release.** `oasis-web` lost `ReadWritePaths=/opt/oasis/releases`; it gets
  `CacheDirectory=oasis-web` (`/var/cache/oasis-web`, emptied at each start), and `deploy.sh` replaces the build's
  `.next-live/cache` with a symlink to it. `next start` was run from a release copy with every file read-only: pages, static assets
  and the image optimizer (which writes `cache/images` through the link) all work.

What it does not cover: a process left running by a build could still write through a file it opened before the `chown`; a
release built before this change is still oasis-owned until it is pruned (a rollback to one works, but its cache directory is not
writable); and anything that can `sudo` is root.

## Deploying and rolling back

```bash
cd / && sudo /usr/local/lib/oasis/deploy/scripts/deploy.sh          # latest origin/main of both repositories
sudo .../deploy.sh --backend-ref origin/some-branch --dashboard-ref <sha> --dry-run
sudo .../rollback.sh --list ; sudo .../rollback.sh [--to <release id>]
```

`deploy.sh`: fetch; stop here if the current release already has these two commits; export both trees (`git archive`) into
`releases/<id>`; `pnpm install --frozen-lockfile`; `pnpm build` (API) and `pnpm build:live` (dashboard; with `STORAGE_PROVIDER=s3`
it gets `OASIS_PHOTOS_ORIGINS=https://<S3_BUCKET>.s3.<AWS_REGION>.amazonaws.com,https://<S3_BUCKET>.s3.amazonaws.com` from
`common.env`, which `next.config.mjs` puts into its Content-Security-Policy at build time instead of any `*.amazonaws.com`; the
value is recorded in `REVISIONS`, so a changed bucket or region rebuilds even with the same commits); a `pre-deploy` backup;
`pnpm migrate up` with the new code while the old release still serves; point `current` at the new release; restart worker, API and
dashboard; wait up to 90 seconds for `healthcheck.sh` (API ready, dashboard answering, and through the public URL
`PUBLIC_DASHBOARD_URL` from `common.env`: a signed-out `GET /` answers 307 to that URL's `/login`, never `localhost` or another host;
the worker unit active). Unhealthy, or a service that will not restart: it points `current` back,
restarts, health-checks again and exits 1, keeping the failed build as `<id>.failed`.

* A build or migration failure changes nothing that runs. The migration is one transaction per file, so a failed one leaves the schema
  as it was.
* **Migrations are forward-only and a rollback does not undo them.** The old code then runs against the migrated schema, so every
  migration must stay compatible with the release before it (add columns and tables first, remove things in a later release). If a
  migration breaks that rule, roll back the code and restore the pre-deploy backup ([runbook.md](runbook.md), "Roll back").
* The script that runs is the root-owned kit, which the previous healthy deploy refreshed (the first one: `install.sh`); a release that
  changes `deploy/` takes effect from the deploy after it, and `deploy.sh` says when the units, nginx or env templates changed so you
  can re-run `/usr/local/lib/oasis/deploy/scripts/install.sh`.
* One deploy at a time (a lock); it keeps the newest 4 releases plus `current` and `previous`, and at most 2 failed builds.
* `HEALTH_CMD`, `BACKUP_CMD`, `SYSTEMCTL`, `OASIS_RUN_AS`, `OASIS_CHOWN` and `OASIS_KIT_TRUST_UID` override the commands it calls and
  the owner a trusted mirror has (the tests use them).

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

### PostgreSQL client for Aurora

The production database is Aurora PostgreSQL 17 (cluster `oasis-database`, database `oasis`, role `oasis_app`, TLS with
`sslmode=verify-full` against the RDS bundle at `/etc/oasis/rds-global-bundle.pem`). Version 15 tools refuse to dump a 17 server,
and on Amazon Linux 2023 the `postgresql17` packages conflict with the `postgresql15` ones the host already has, so the version 17
client is unpacked beside them instead of installed:

```bash
sudo mkdir -p /opt/oasis/pgclient/17 && cd "$(mktemp -d)"
dnf download postgresql17 postgresql17-private-libs && rpm -K ./*.rpm          # both must say "digests signatures OK"
for r in ./*.rpm; do rpm2cpio "$r" | sudo cpio -idm --quiet -D /opt/oasis/pgclient/17; done
echo 'PG_BINDIR=/opt/oasis/pgclient/17/usr/bin' | sudo tee -a /etc/oasis/common.env
sudo curl -fsSL -o /etc/oasis/rds-global-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
```

`deploy/lib/common.sh` puts `$PG_BINDIR` (and its `../lib64`) first, so backup, restore drill and ledger check use it; the
connection's `sslmode` and `sslrootcert` travel from `DATABASE_URL` into `PGSSLMODE` and `PGSSLROOTCERT`. Aurora also keeps its
own automated backups (7 days, point in time); the nightly dumps in S3 are the longer, off-cluster copy.

## Secrets

* They live in the AWS Secrets Manager secret (above). Change one with a one-line file and `pnpm secrets:push --profile <operator
  profile> --secret-id oasis/prod/app --from FILE --apply` (plan first without `--apply`; `--remove KEY` deletes one), then restart
  `oasis-api` and `oasis-worker`. Secrets Manager keeps the previous version (`AWSPREVIOUS`).
* `SECRETS_KEY` rotates with `deploy/scripts/secrets-rotate.sh --profile <operator profile>` (`pnpm secrets:rotate` underneath): dry run,
  a `secrets:push` plan proving the operator may write the secret, backup, stop API and worker, re-encrypt every credential in one
  read-back-verified transaction, push the new key into the secret, start, health-check.
* Everything else (session secret, database password, tablet and Squarespace credentials, AWS access) is in
  [runbook.md](runbook.md), "Rotate secrets".
* `deploy/scripts/gen-secrets.sh` prints freshly generated values from the system CSPRNG; `gen-secrets.sh --secret` prints the file
  for a new secret (`DATABASE_URL` with a fresh password, `SESSION_SECRET`, `SECRETS_KEY`, `STORAGE_SIGNING_SECRET`).
* Still on disk: `/etc/oasis/drill.env` (the `oasis_drill` role's URL; not an app setting, so it cannot live in the secret),
  `BACKUP_ENCRYPTION_KEY_FILE` (a key file) and, with runtime=user, `/etc/oasis/aws-credentials`.

## Logs and monitoring

* Services log to journald (JSON lines from pino; `journalctl -u oasis-api -o cat | jq`). `journald.conf.d/oasis.conf` makes the journal
  persistent and bounded (1 GB, one month).
* nginx: `/var/log/nginx/oasis.access.log` carries `rid=<request id>` that equals `X-Request-Id` in the API log and in every error body.
  logrotate keeps 14 days of nginx logs and 12 weeks of `/var/log/oasis/*.log`.
* `install.sh` enables **and starts** the backup and health-check timers (enabled alone they would wait for the next boot) and runs
  the health check once when a release is live. `oasis-healthcheck.timer` runs every 5 minutes; `healthcheck.sh` checks the API's
  readiness, the dashboard, the sign-in redirect through the public URL (a `Location` on `localhost` or another host fails it;
  `--skip-public`), and that `oasis-worker` is active (`--skip-worker`). For an outside view, point an uptime monitor at `https://<domain>/healthz`, and run
  `healthcheck.sh --public https://<domain>` from somewhere else to confirm that `/hooks/smsgate` answers 404 from outside.
* Inside the app, "Needs attention" shows an offline tablet, orders waiting for a match, card money not confirmed after two hours, and
  sync failures.

## What was and was not verified

Written and tested on this machine without installing anything or touching the running system.

Verified by tests (`pnpm test:ops-kit`):
* the env templates against `src/config/env.ts` (no secret key active in them; the deploy kit's list of secret keys equals the app's);
  the generated production environment boots `src/server.ts` as a real process with `NODE_ENV=production`, reading `SESSION_SECRET`
  and `SECRETS_KEY` from the secret through the real SDK against a local Secrets Manager endpoint, passes the health check, sends the
  security headers, and honours `X-Forwarded-For`;
* `backup.sh` reading `DATABASE_URL` from the secret through `scripts/secret-env.ts` and the SDK (local endpoint); the precedence
  environment, common.env, secret; the runtime=user drop-ins and key file; `install.sh --move-secrets` (refuses a missing or different
  value, then moves); `bootstrap-admin.sh` and `secrets-rotate.sh` writing the secret (a stand-in for `secrets:push`);
* every unit with `systemd-analyze verify` and `systemd-analyze security` (offline);
* the nginx configuration structurally (a parser, nginx's location-selection rules applied to representative URLs, duplicate
  directives, zones, includes, header values), and in a real nginx 1.30 when it is installed (`nginx -t` and real requests);
* `install.sh` (staging directory, dry run, idempotence), `deploy.sh` and `rollback.sh` (real git repositories; stand-ins for pnpm,
  systemctl, the health check and the backup), `healthcheck.sh`, `tailscale-serve.sh` (a stand-in `tailscale`), `bootstrap-admin.sh`,
  `gen-secrets.sh`, `secrets-rotate.sh`, `reset-password.sh` (against the real database), `oasis-admin.sh` (against the real API
  process, with the SMS Gate and Squarespace simulators);
* `backup.sh` and `restore-drill.sh` with real `pg_dump` and `pg_restore` on the seeded ledger: exact snapshot counts, retention, hard
  links, encryption round trip, and detection of a corrupted file, a wrong manifest, a drifted calculation and a missing guard trigger.

Not verified (needs the real thing):
* certbot, and the dnf package names (`nodejs22`, `certbot`,
  `postgresql15-server`) and the `pg_hba.conf` edit that `--install-packages --install-postgres` perform;
* **shellcheck** is not installed on the build host. It was run once from a temporary Python virtualenv (`pip install shellcheck-py`, version
  0.11.0, nothing installed system-wide) and the scripts are clean at warning level; the test suite runs it only when `shellcheck` is
  on the PATH or named in `SHELLCHECK`, and otherwise relies on `bash -n`, structural tests and execution;
* `tailscale serve`: the JSON shape that `serve-check.mjs` reads follows Tailscale's `ServeConfig` type and the stand-in follows the
  same; confirm with `tailscale-serve.sh --status` on the host. Whether tailscaled and nginx can both use port 443 is untested (hence 8443);
* the restore drill in **database mode** (the test role may not create databases here; schema mode was run);
* the dashboard's CSP in a browser was first exercised on the production host, the systemd hardening under a real `systemctl start`, S3 upload of backups
  with the real `aws` CLI, and the first-boot `BOOTSTRAP_ADMIN` flow on a real empty database through `install.sh`;
* real AWS: reading the secret with the instance role or the key file, `LoadCredential=` under a real `systemctl start` (systemd 252
  on Amazon Linux 2023 supports it; `systemd-analyze verify` checks the units, not the drop-ins), and `secrets:push` against the real
  service (tests use the real SDK client with a mocked transport, and a local endpoint for the loader).

## Known gaps in the application that affect deployment

Found while building the kit; none is changed here because the files belong to other work.

1. (Closed, ADR 0112.) The storage and SES variables are declared in `src/config/env.ts`; the IAM policy is scoped to the `prod/` prefix.
2. (Closed, ADR 0112.) `SQSP_PROVIDER=live` works with only the stored, encrypted key.
3. (Closed, ADR 0112.) `SMS_PROVIDER=smsgate` needs no device values in the environment.
4. (Closed, ADR 0110.) `/hooks/ses` is mounted: SNS-signed bounce and complaint feedback feeds the suppression list.
5. The SMS devices and the Squarespace connection have no dashboard screen; `deploy/scripts/oasis-admin.sh` drives the API for them.
