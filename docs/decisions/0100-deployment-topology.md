# 0100 Deployment topology: one host, release directories, systemd, nginx, env split
Status: accepted (2026-10-07)

* **Releases are directories, not a checkout that is pulled.** `deploy.sh` exports both repositories (`git archive`) into
  `/opt/oasis/releases/<id>/`, builds there, and switches the `current` symlink. A rollback is a symlink switch plus a restart: no
  rebuild, no network. The cost is disk (a `node_modules` per release, four kept) which a 2 vCPU host can afford.
* **Migrations run before the switch, with the new code, while the old release still serves.** They are forward-only (existing rule),
  so a rollback cannot undo them; the rule that follows is that every migration must stay compatible with the previous release. A
  `pre-deploy` backup is taken first and is the recovery for the case where that rule was broken.
* **The deployment script, not the process manager, decides health.** After the restart `deploy.sh` waits for `healthcheck.sh`
  (`/readyz` ready: database, migrations, job queue; the dashboard answers) and rolls back by itself. systemd `Restart=always` handles
  crashes, not bad releases.
* **Three units under one target.** `oasis-api`, `oasis-worker`, `oasis-web`, each as the unprivileged `oasis` user with the
  sandboxing options of `systemd-analyze security` (exposure 1.7). `MemoryDenyWriteExecute` stays off because V8 needs it. The web unit
  starts `next start` of the live variant directly, not through pnpm, so production needs no package manager at run time.
* **Environment: shared secrets live once.** `/etc/oasis/common.env` (API and worker), plus `api.env`, `worker.env`, `web.env`. Two copies
  of `SECRETS_KEY` or `SESSION_SECRET` in per-service files would drift, and the worker would then fail to read what the API stored.
  Files follow systemd's rules (own-line comments, no `export`), because systemd reads them; a test keeps the templates in step with
  `src/config/env.ts`.
* **Only nginx faces the internet.** The API and the dashboard bind loopback. nginx overwrites `X-Forwarded-For` with `$remote_addr`
  (never appends) because the API runs with `TRUST_PROXY=true`, which trusts the first address in the header. `/hooks/*` other than the
  signed Squarespace and SES endpoints answers 404 publicly. Headers: the API keeps its helmet set; nginx adds the matching set only for
  the pages Next produces, so no header is sent twice.
* **The CSP ships report-only.** It has not been exercised in a browser against the finished dashboard (inline styles and a theme script
  need `'unsafe-inline'`), and a wrong enforcing policy would blank the dashboard on first deploy. `install.sh --csp enforce` flips one file.
* **The tailnet mount uses port 8443.** `tailscale serve` on 443 next to nginx on 443 is unverified (the SMS Gate document says so); the
  tablet accepts any HTTPS port. `tailscale-serve.sh` refuses a node that serves anything else, never uses Funnel, and reads the
  configuration back after applying it.
* **Installation is a script that can be rehearsed.** `install.sh` is idempotent, has `--dry-run` and `--no-system`, never overwrites an
  env file, and can be pointed at a staging root (`OASIS_ROOT_PREFIX`), which is how the tests run the real script.
* **Alternatives rejected:** containers (one host, one operator, no registry); `git pull` in place with a rebuild on rollback (slow and
  unsafe exactly when needed); a process manager other than systemd (already on the host, gives sandboxing and timers for free).
