# 0020 Domain core schema

Status: accepted (2026-10-06)

The domain core is one migration (`domain_core`) landing before the Settings vertical, because closure affected counts,
the emergency list, the VIP-to-customer link and the idle strip need real customers, vehicles, bays and appointments
(review B1, delivery B1).

- **Location scoping.** Parents carry `location_id` and every unique key leads with it; children inherit it through their
  parent FK. Customers and vehicles are brand-global.
- **Missing foreign keys.** People, auth, memberships, messages and standing series arrive in other branches, so the
  columns that will point at them are plain `uuid`. `docs/data-model.md` lists every one for a later links migration that
  adds the constraints `not valid` and validates them.
- **Enums are `text` with `check`**, not Postgres enums: cheaper to extend in a forward-only migration.
- **Bay occupancy lives in the database**: partial unique index `uq_bay_occupied (bay_id) where status='cleaning'` plus
  `check (status <> 'cleaning' or bay_id is not null)`. Concurrent starts are decided by Postgres, not by application locks.
- **Soft deletes** (`deleted_at`) for customers, vehicles and closures; partial unique indexes ignore deleted rows, except the
  federal key (ADR 0022). Retired services and checklist tasks are flagged, never removed, because snapshots reference them.
- **Synthetic people** carry `synthetic=true`; a check limits their numbers to `+1 AAA 555 01xx`, so seeds and tests can
  never hold a real-looking number (and `SMS_ALLOWLIST` is a second guard at send time).
- **Hours and rules share one `version`** (`booking_rules.version`); `online_lead_minutes` is added to `booking_rules`
  (default 30), resolving review C10 where `lead_min` was used but undefined.
- **Types live next to their module**, registered by `declare module '../../platform/schema.js'`; appointment tables are typed
  in `src/modules/customers/schema.ts` until a scheduling module exists.
