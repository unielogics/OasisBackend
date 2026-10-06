# Oasis Auto Spa — backend

Fastify + Postgres API for the Oasis dashboard (Operations, Payments, Settings). Built from three Claude Design prototypes
that are the source of truth; see [`docs/plan.md`](docs/plan.md) for the approved plan and
[`docs/reference/`](docs/reference) for the extraction reports, designs and adversarial reviews it was built from.

## Quick start
```bash
cp .env.example .env        # fill DATABASE_URL etc. (bootstrap already created .env on the dev box)
pnpm install
pnpm check                  # lint + typecheck + tests
pnpm bootstrap:verify       # asserts the box toolchain (node 22, postgres 15, chromium libs, tailscale, remotes)
```

## Conventions
- Integer cents everywhere; 7% tax half-up (a setting). Business tz America/New_York, UTC storage.
- All time goes through the injected `Clock` (`src/platform/clock.ts`) / SQL `app_now()`; `Date.now()`, `new Date()` and
  `Math.random()` are lint-banned outside the platform modules.
- Every integration is a port in `src/integrations/ports/` with a real adapter and a simulator, selected by `*_PROVIDER`.
- Squarespace is the card processor but its API is read-only for payments; Oasis owns the ledger (see ADR 0006).
- Decisions live in [`docs/decisions/`](docs/decisions). Small commits straight to `main`; every commit passes `pnpm check`.
