# Seeds

`pnpm seed -- --profile <name>` runs a named profile inside one transaction, after making sure the single location row
and the default settings exist (both idempotent). `pnpm seed -- --list` prints the registered profiles.

Profiles registered today: `empty` (location + default settings only). The planned set is `base`, `design`, `demo`,
`parity-ops` and `parity-pay`; each vertical adds the data it owns.

## Adding a profile

1. Create `db/seeds/<name>.ts` that calls `registerSeedProfile(name, { description, dependsOn?, run })`.
2. Import it from `db/seeds/index.ts` (one line) so the runner can see it.
3. `run(ctx)` receives `{ tx, clock, newId, rng, location, log }`. Use `ctx.clock.now()` for time (never `new Date()`),
   `ctx.newId()` for UUIDv7 ids and `ctx.rng(seed)` (mulberry32) for anything random so output is reproducible.
4. Make it idempotent (`on conflict do nothing` / natural keys); `dependsOn` profiles run first, once.

Parity profiles run against a separate database (`DATABASE_URL_PARITY`) with `CLOCK_FREEZE_AT=2026-06-13T10:36:00-04:00`
so `app_now()` and the injected clock agree. Seed phone numbers must be synthetic (555-01xx); non-production sends are
additionally restricted by `SMS_ALLOWLIST`.
