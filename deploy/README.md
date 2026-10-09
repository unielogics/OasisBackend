# deploy/

The deployment and operations kit. On a host it runs from a root-owned copy in `/usr/local/lib/oasis/deploy` (`install.sh` puts it
there, every healthy deploy refreshes it; docs/deployment.md, "Privilege separation"), never from a clone or a release. Start with [docs/deployment.md](../docs/deployment.md) (how the host is laid out and why) and
[docs/runbook.md](../docs/runbook.md) (what to do, step by step). Checking the integrations: [docs/live-verification.md](../docs/live-verification.md).

| Path | What |
|---|---|
| `scripts/install.sh` | first-time setup of a host; idempotent; `--dry-run`, `--no-system`; `--site-domain` adds the public website (its nginx servers, `/etc/oasis/site.env`, a placeholder release, the certificate) |
| `scripts/deploy.sh`, `rollback.sh` | build a release, migrate, switch, health-check, roll back; switch back by hand |
| `scripts/healthcheck.sh` | API readiness, dashboard, the signed-out redirect through the public URL, the worker, the public website when one is configured (200 with the marker, www 301), and (with `--public`) that the SMS hook is not reachable from outside |
| `scripts/site-deploy.sh` | the public website: build a release from the root-only mirror as oasis, verify it, switch `/var/www/site/current`, health-check, roll back by itself; `--rollback`, `--list`, `--dry-run` (docs/runbook.md, "The public website") |
| `scripts/backup.sh`, `restore-drill.sh`, `ledger-check.sh` | snapshot-consistent dumps with retention; restore into a scratch copy and verify; the ledger invariants on their own |
| `scripts/tailscale-serve.sh` | exposes only `/hooks/smsgate` on the tailnet |
| `scripts/bootstrap-admin.sh`, `reset-password.sh` | the first Super Admin; break-glass password reset |
| `scripts/secrets-rotate.sh`, `gen-secrets.sh` | rotate `SECRETS_KEY` safely (and store it in the secret); generate secrets (`--secret`: the file for `pnpm secrets:push`) |
| `scripts/oasis-admin.sh` | the tablet and the Squarespace connection from the command line (no dashboard screen yet) |
| `scripts/verify.sh` | runs `pnpm verify:*` from the current release with the production environment |
| `systemd/` | units, timers, the target, and `oasis-imds-guard` (only root, oasis and ec2-instance-connect reach the instance metadata service) |
| `systemd-dropins/` | the runtime=user drop-in (`install.sh --aws-runtime user`): the root-only AWS key handed to the services with `LoadCredential=`; the `--local-db` drop-in (`Wants/After=postgresql.service`) |
| `nginx/` | templates for the dashboard site (`oasis.conf`), the public website (`oasis-site.conf`, `oasis-site-headers.conf`, its port-80 bootstrap), the rate-limit zones and the `oasis_public` cache, the shared TLS settings (`oasis-tls.conf`), proxy and security-header snippets |
| `env/` | documented environment templates (`common`, `api`, `worker`, `web`); they hold no secret: those live in AWS Secrets Manager (`OASIS_SECRET_ID`) |
| `logrotate/`, `journald/` | log rotation and journal limits |
| `lib/` | shared shell helpers, the ledger checks, backup encryption, the Tailscale serve checker, the password reset |

Tests: `pnpm test:ops-kit` (the files, the scripts end to end against real git, Postgres and the API process).
