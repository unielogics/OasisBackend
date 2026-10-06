# Decisions (ADRs)

| # | Title |
|---|---|
| [0001](0001-stack.md) | Stack: Node 22, Fastify, Kysely, pg-boss, Postgres 15 |
| [0002](0002-money-and-time.md) | Money in integer cents; injectable time; business tz |
| [0003](0003-squarespace-boundary.md) | Squarespace stays the card processor; Oasis owns the ledger |
| [0004](0004-sms-gate.md) | SMS only, via SMS Gate on a tablet over Tailscale |
| [0005](0005-react-18-pages-router.md) | Dashboard: Next Pages Router + React 18.3.1 pin |
| [0006](0006-error-model-and-idempotency.md) | Error model (RFC 9457) and idempotency keys |
| [0007](0007-http-zod4-and-test-schemas.md) | HTTP schemas on Zod 4; per-worker schemas for integration tests |
| [0008](0008-sessions-and-csrf.md) | Sessions, CSRF and login throttling |
| [0009](0009-view-as.md) | Super Admin view-as semantics |
| [0010](0010-money-limit-storage.md) | Money limit storage (cents, explicit unlimited) and resolution |
| [0020](0020-domain-core-schema.md) | Domain core schema: location scoping, deferred foreign keys, bay-occupancy index |
| [0021](0021-checklist-task-ids.md) | Checklist tasks keep stable ids; the PUT diff rules |
| [0022](0022-closures-federal-holidays-emergency.md) | Closures, federal holidays, dayInfo and emergency closures |
| [0023](0023-vip-and-settings-data-rules.md) | VIP, arrival and settings data rules |
| [0030](0030-settings-http-contract.md) | Settings HTTP contract: versions, time forms, bundle filtering, VIP-by-name, idempotency |
| [0031](0031-emergency-over-http.md) | Emergency closing over HTTP: B38 guard, auto-reopen and sweep, events, crew alert |
| [0032](0032-settings-adapters-and-ports.md) | Settings adapters and ports: DB hours port, recording notifiers, ChecklistSync, jobs |
| [0033](0033-settings-oracle.md) | The original design as an automated oracle for Settings |
