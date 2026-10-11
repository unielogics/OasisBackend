# 0145 The public website lives on the same host, as static files behind the same nginx, with one public API route
Status: accepted (2026-10-09); amended 2026-10-10 (the build user and the copy-out, below)

The marketing website (`oasisautospanj.com`, `www` redirecting to it; repository `unielogics/OasisSite`) is hosted on the dashboard's
EC2 host by the same nginx, from its own root-owned release directory. Nothing of it runs as a process: nginx serves the files a
build produced. The dashboard (`app.`) and the API are untouched except for one new route.

* **Where.** `/var/www/site/releases/<id>` is one verified build (`dist/` of the site repository plus a `REVISION` record);
  `/var/www/site/current` is the symlink nginx's `root` points at; `previous` the one before. All of it belongs to root and is
  read-only for everyone else: the website build user `oasis-site` builds inside `<id>.partial/src` and root copies the output out
  and verifies the copy (amended 2026-10-10; it was the oasis user, and root renamed the build's own `dist/` into place). nginx is
  never reloaded for a deploy: it reads through the link.
* **Which nginx servers.** `deploy/nginx/oasis-site.conf.template`: port 80 for both names (ACME challenge, 301 to `https://` apex),
  port 443 for `www` (301 to the apex), port 443 for the apex (the files). The TLS settings moved into one shared include
  (`oasis/tls.conf`) so the dashboard and the website use the same protocols, ciphers and session cache; the certificates stay per
  server. The hardened default servers of `oasis.conf` (close the connection, refuse the handshake) keep covering every other name
  and the bare address, which is why the site's server blocks must exist **before** the DNS records point here.
* **Headers.** The site sends its own `Content-Security-Policy` (`default-src 'none'; script-src 'self'; style-src 'self'
  'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri
  'none'; form-action 'self'; object-src 'none'; upgrade-insecure-requests`; `install.sh --site-csp` replaces it), `Referrer-Policy:
  strict-origin-when-cross-origin`, `X-Frame-Options: DENY`, the same-origin opener and resource policies, and HSTS and nosniff on
  every answer exactly once (the kit's rule from ADR 0142: a location that adds a header repeats them through the headers include).
  **HSTS with `includeSubDomains` on the apex is safe** because every name under `oasisautospanj.com` that answers at all is
  HTTPS only: `app.` (the dashboard), `www` (a redirect), and nothing else is served.
* **No CORS, by construction.** The site needs one piece of live data, the opening hours. Instead of letting the browser call
  `app.oasisautospanj.com` (which would need CORS on the API and expose it to another origin), nginx proxies exactly
  `/api/v1/public/hours` from the site's own host to the API upstream, strips cookies in both directions (a visitor of the website is
  never a dashboard session, and no session cookie may be minted for that origin), rate-limits it with the API zone and caches the
  answer for 60 seconds (`proxy_cache oasis_public`, stale-while-revalidate and stale-on-error). Every other `/api`, `/hooks` or
  `/dev-storage` path on the website's host, in any letter case, is a 404 from nginx. The API therefore gains no CORS configuration
  and keeps `access.public` to a single route.
* **The route.** `GET /api/v1/public/hours` (`src/modules/settings/http/public-routes.ts`, pure view in
  `src/modules/settings/public-hours.ts`) is computed from the same rows and the same `dayInfo()` as the dashboard: weekly hours,
  planned closures of the next 14 days and the active emergency. It carries **no personal or operations data**: no names of people,
  counts, message text or row ids; closure names are the ones customers are told anyway. 60 requests a minute per address,
  `Cache-Control: public, max-age=60`. It is listed on purpose in the authz matrix's `PUBLIC_ROUTES`.
* **Rollout order: bootstrap, DNS, certbot, full.** `install.sh --site-domain` first renders a port-80-only bootstrap for the two
  names (ACME challenge only) and asks certbot for one certificate covering both; before the DNS records exist that fails, which is a
  warning, not an error, and the bootstrap stays. Once the records point here, the same command issues the certificate and renders
  the full servers. The dashboard is never affected by the site's certificate state.
* **A placeholder release.** `install.sh` creates `releases/bootstrap` (an index and 404 page saying "<marker> — coming soon") and
  points `current` at it when there is no `current` yet, so the apex answers 200 from the moment the full servers exist, before the
  first build. `site-deploy.sh` replaces it like any release.
* **Deploys and health.** `deploy/scripts/site-deploy.sh` (root, from the root-owned kit) builds from the root-only mirror
  `/opt/oasis/git/site.git` (fixed path from `/etc/oasis/site.env`; refused when anyone but root can change it), as `oasis-site`
  (amended 2026-10-10), with `SITE_URL` and a snapshot of the hours endpoint; copies the output out of the build tree and verifies the
  copy (index and 404 present, the marker text, no localhost or development-port URL, no inline script, only directories and regular
  files, size bounds) before it is served; switches `current` atomically; checks `https://<apex>/` (200 with the marker) and
  `https://www.<apex>/` (301) through nginx on this host, and switches back by itself when that fails, leaving `previous` where it
  was. `healthcheck.sh` probes the same two things every five minutes once `site.env` exists.
* **Logrotate.** The kit's logrotate file no longer names `/var/log/nginx/*` (the nginx package rotates those, the site's logs
  included): a path named twice makes every logrotate run end with "duplicate log entry ... found error in file oasis, skipping" and
  exit 1 (reproduced in the test with logrotate 3.20), so the kit's file now holds only `/var/log/oasis/*.log`.

What was not decided here: the site's build pipeline, pages and copy (the site repository), the DNS change itself (the operator's
profile), and the rebranding of the dashboard (a separate task).

## Amendment 2026-10-10: the build user, the copy-out, and `previous`

The adversarial review of the public surface (2026-10-10) upheld three findings against `site-deploy.sh`; all three are fixed.

* **Root no longer operates on paths the build user controls.** `<id>.partial` and `<id>.partial/src` were both handed to the build
  user, and after verifying `dist/` root renamed it into place, wrote `REVISION` into it and ran `chmod -R` on it, and earlier wrote
  the hours snapshot into `<id>.partial`. A process the build left behind could swap `dist/` for a link after verification (`mv`
  moves the link, `chmod -R` follows a link named on its command line: a `0600` key under the target became `0644`, and nginx served
  the target), plant `dist/REVISION` or `hours.json` as a link to any root file, or hard-link a file of its own into `dist/` so the
  `chmod -R` changed it. Now `<id>.partial` is root's and only `src/` is the build user's; root writes the hours snapshot into the
  root-owned part; after the build every process of the build user is killed and `<id>.partial` becomes `0700`, so the tree is
  quiescent and unreachable; root copies `dist/` with `cp -R -P` (links copied as links, never followed) into a fresh directory of
  its own, after refusing a hard link, a file the build user does not own or a special file; it verifies **the copy** (which now also
  refuses anything but directories and regular files), writes `REVISION`, sets the modes with `find` (directories `0755`, files
  `0644`) and renames the copy to `releases/<id>`. The build tree is only deleted (`rm -rf`, which does not follow links).
  `test/ops-kit/deploy-site.test.ts` plants a `hours.json` link before the snapshot, a `REVISION` link and a `dist/` swap after
  verification, a hard link and a directory link during the build, and checks that nothing outside the release changed.
* **The site is built by its own unprivileged user, `oasis-site`.** The build used to run as `oasis` with `HOME=/var/lib/oasis`:
  every dependency of the website could read `/etc/oasis` (the environment files, `backup.key`, the secret's name) and, because the
  metadata guard (ADR 0141) lets `oasis` through, take the instance role's credentials and read the Secrets Manager secret. The
  reviewers rated the added risk low because the backend and dashboard builds already run as `oasis`; it is still removed here, since
  the website's dependency set differs and nothing of the site needs any of that. `install.sh --site-domain` creates `oasis-site`
  (system user and group of its own, `/sbin/nologin`, home `/var/lib/oasis-site` `0700` for the pnpm store; takes it out of the group
  `oasis` if someone put it there); it is not in the guard's allow-list, so the metadata service refuses it. The build gets only the
  contract's environment (`env -i`), never root's. Before each build `site-deploy.sh` checks that the user exists, is neither root nor
  oasis nor in the group oasis, and cannot read `/etc/oasis/*.env`, `*.key`, `aws-credentials`, or enter `/var/lib/oasis` and
  `/var/backups/oasis`; any of those stops the deploy before anything is built.
* **A switched-back deploy keeps `previous`.** `previous` was pointed at the old release before the health check, so a release that
  failed it left `current` and `previous` on the same release and `--rollback` refused ("already the current release"); `--list`
  then showed no current release. `previous` now moves only after the new release is healthy, and `--list` shows
  `<- current, previous` when the two links meet.

**Note 2026-10-10 (independent verification of the amendment: PARTIAL, two gaps closed).** (1) Killing the build user's processes
does not stop work queued for later: the host runs `atd` (at 3.1.23) with an empty `/etc/at.deny`, so a dependency could queue an
`at` or `batch` job that outlives the kill loop and races the copy. `install.sh` now puts `oasis` and `oasis-site` into
`/etc/at.deny` (and `/etc/cron.deny` where cron is installed or the file exists; other entries kept, `0600 root:root`, idempotent,
an `at.allow`/`cron.allow` naming either user is reported), and `site-deploy.sh` refuses to build, and after the build refuses to
copy, while `atq` (as root) lists a job of `oasis-site`, `crontab -l -u oasis-site` shows anything, or `oasis-site` lingers (a
systemd user manager). The kill loop now ends only after two consecutive empty `pgrep` passes, and runs once more after the
scheduled-work check. (2) `cp -R -P` refuses a link only at the last component of each path it opens: a directory of `dist/`
swapped for a link while `cp` walks it is followed (reproduced with strace: a root `0600` `privkey.pem` landed in the copy as a
regular file, and the `chmod 0644` and the copy's verification did not notice). The copy now keeps owners and modes
(`cp -R -P --preserve=mode,ownership,timestamps`), and the whole copy is rejected (kept as `<id>.failed`) when any entry in it is not
a directory or regular file owned by `oasis-site`, before root writes `REVISION`, chowns it to root or changes a mode. Only then is
it chowned to root and its modes set. Tests: a scheduled job (at, batch, running, crontab, linger; and one the build queues) refuses
the deploy; a link or a FIFO appearing in the copy, and (in a user namespace, where a file of the real root shows as a foreign uid) a
foreign-owned file bind-mounted into the copy, are rejected before `REVISION` or any mode change; the `at.deny` rendering keeps
foreign entries and is idempotent.

Not changed: the backend and dashboard builds (`deploy.sh`) still run as `oasis` (ADR 0140): their packages run as `oasis` at runtime
anyway. Possible later hardening, not done: running the site build in a transient systemd unit with `PrivateNetwork=` after an
offline `pnpm fetch`.
