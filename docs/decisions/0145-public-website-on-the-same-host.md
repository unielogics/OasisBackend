# 0145 The public website lives on the same host, as static files behind the same nginx, with one public API route
Status: accepted (2026-10-09)

The marketing website (`oasisautospanj.com`, `www` redirecting to it; repository `unielogics/OasisSite`) is hosted on the dashboard's
EC2 host by the same nginx, from its own root-owned release directory. Nothing of it runs as a process: nginx serves the files a
build produced. The dashboard (`app.`) and the API are untouched except for one new route.

* **Where.** `/var/www/site/releases/<id>` is one verified build (`dist/` of the site repository plus a `REVISION` record);
  `/var/www/site/current` is the symlink nginx's `root` points at; `previous` the one before. All of it belongs to root and is
  read-only for everyone else: the oasis user builds inside `<id>.partial` and root moves the verified output into place, as with the
  application's releases (ADR 0140). nginx is never reloaded for a deploy: it reads through the link.
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
  `/opt/oasis/git/site.git` (fixed path from `/etc/oasis/site.env`; refused when anyone but root can change it), as the oasis user,
  with `SITE_URL` and a snapshot of the hours endpoint; verifies the output (index and 404 present, the marker text, no localhost or
  development-port URL, no inline script, no symbolic link, size bounds) before it is served; switches `current` atomically; checks
  `https://<apex>/` (200 with the marker) and `https://www.<apex>/` (301) through nginx on this host, and switches back by itself when
  that fails. `healthcheck.sh` probes the same two things every five minutes once `site.env` exists.
* **Logrotate.** The kit's logrotate file no longer names `/var/log/nginx/*` (the nginx package rotates those, the site's logs
  included): a path named twice makes every logrotate run end with "duplicate log entry ... found error in file oasis, skipping" and
  exit 1 (reproduced in the test with logrotate 3.20), so the kit's file now holds only `/var/log/oasis/*.log`.

What was not decided here: the site's build pipeline, pages and copy (the site repository), the DNS change itself (the operator's
profile), and the rebranding of the dashboard (a separate task).
