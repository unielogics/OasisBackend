# 0001 Stack
Status: accepted (2026-10-06)

Node 22 LTS + TypeScript (strict, ESM); Fastify 5 with Zod → OpenAPI; Kysely over `pg` (typed SQL, no native engine; the
reports are CTE/window heavy and the schema uses views, partial indexes and triggers); hand-written forward-only SQL
migrations; pg-boss for jobs (Postgres only, no Redis); SSE for realtime; scrypt (`node:crypto`) for passwords so no native
build is needed; Vitest against a real Postgres. Single location, but every location-scoped table carries `location_id`.
