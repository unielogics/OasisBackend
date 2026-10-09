# deploy/

The deployment and operations kit. Start with [docs/deployment.md](../docs/deployment.md) (how the host is laid out and why) and
[docs/runbook.md](../docs/runbook.md) (what to do, step by step). Checking the integrations: [docs/live-verification.md](../docs/live-verification.md).

| Path | What |
|---|---|
| `scripts/install.sh` | first-time setup of a host; idempotent; `--dry-run`, `--no-system` |
| `scripts/deploy.sh`, `rollback.sh` | build a release, migrate, switch, health-check, roll back; switch back by hand |
| `scripts/healthcheck.sh` | API readiness, dashboard, and (with `--public`) that the SMS hook is not reachable from outside |
| `scripts/backup.sh`, `restore-drill.sh`, `ledger-check.sh` | snapshot-consistent dumps with retention; restore into a scratch copy and verify; the ledger invariants on their own |
| `scripts/tailscale-serve.sh` | exposes only `/hooks/smsgate` on the tailnet |
| `scripts/bootstrap-admin.sh`, `reset-password.sh` | the first Super Admin; break-glass password reset |
| `scripts/secrets-rotate.sh`, `gen-secrets.sh` | rotate `SECRETS_KEY` safely (and store it in the secret); generate secrets (`--secret`: the file for `pnpm secrets:push`) |
| `scripts/oasis-admin.sh` | the tablet and the Squarespace connection from the command line (no dashboard screen yet) |
| `scripts/verify.sh` | runs `pnpm verify:*` from the current release with the production environment |
| `systemd/` | units, timers, the target |
| `systemd-dropins/` | the runtime=user drop-in (`install.sh --aws-runtime user`): the root-only AWS key handed to the services with `LoadCredential=` |
| `nginx/` | templates for the public site, rate-limit zones, proxy and security-header snippets |
| `env/` | documented environment templates (`common`, `api`, `worker`, `web`); they hold no secret: those live in AWS Secrets Manager (`OASIS_SECRET_ID`) |
| `logrotate/`, `journald/` | log rotation and journal limits |
| `lib/` | shared shell helpers, the ledger checks, backup encryption, the Tailscale serve checker, the password reset |

Tests: `pnpm test:ops-kit` (the files, the scripts end to end against real git, Postgres and the API process).
