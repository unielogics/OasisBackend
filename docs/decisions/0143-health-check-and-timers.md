# 0143 The health check proves the public sign-in redirect and the worker; timers are started; no local database at boot
Status: accepted (2026-10-09)

* `healthcheck.sh` also checks, through `PUBLIC_DASHBOARD_URL` (the environment, else `common.env`), that a signed-out `GET /`
  answers 307 to that URL's `/login` (a relative `/login` is accepted; `localhost`, another host or a protocol-relative URL fail), and
  that `oasis-worker` is active. `deploy.sh`'s health gate uses it, so the launch-day bug (a redirect to `https://localhost:3200/login`)
  rolls a release back. `--skip-public` and `--skip-worker` exist for hosts without them.
* `install.sh` enables **and starts** the backup and health-check timers (enabled alone they waited for a reboot: nothing ran on launch
  night, review H4) and, after nginx, runs `oasis-healthcheck.service` once when a release is live.
* The units no longer pull in `postgresql.service` (production uses Aurora; review L5); `install.sh --local-db` writes
  `20-oasis-local-db.conf` drop-ins for the API, worker, backup and drill, and a later run without the flag keeps them.
