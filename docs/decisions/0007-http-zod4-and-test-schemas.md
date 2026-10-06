# 0007 HTTP schemas on Zod 4; integration tests isolate by schema

Status: accepted (2026-10-06)

**Zod.** `fastify-type-provider-zod` 5.x builds on the `zod/v4` API (bundled in zod 3.25), while the env contract and the
integration ports are written against zod 3. Rather than bump the whole repo (zod 4 changes `.default()` semantics on
transformed schemas, which would silently break the env boolean parsing), anything attached to a route imports `z` from
`src/http/zod.ts` (zod 4); the rest keeps `zod`. Revisit when the repo moves to zod 4 as a whole.

**Test isolation.** The `oasis` database role has no `CREATEDB`, so cloning `test_<n>` databases from a template is not
possible without changing server roles. Each vitest worker instead owns a schema `t_<hash of the checkout path>_<worker id>`
in `DATABASE_URL_TEST`, migrated with the production runner, set first on the connection `search_path`, reused across runs
while migration checksums match and rebuilt if they do not. The checkout hash keeps git worktrees and concurrent agents
apart. The realtime NOTIFY channel is per schema (`oasis_rt_<schema>`) so parallel workers never hear each other. If the
role later gets `CREATEDB` nothing else needs to change; a template-database strategy can be added behind `createTestDb`.
