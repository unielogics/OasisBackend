# 0085 The data-model document is generated and tested against the schema

Status: accepted (2026-10-07). Closes gap 6 of the b6 list.

`docs/data-model.md` described only the domain-core migration while the schema grew to 79 tables. It now has three layers, each
tied to the next so that no layer can drift without a test failing:

1. **Migrations to `db/schema.sql`**: `pnpm db:schema` (existing; `test/integration/seeds-cli.test.ts` fails when the file is stale).
2. **`db/schema.sql` to the schema reference** at the end of the document: `pnpm data-model` (`scripts/data-model.ts`, parser and
   renderer in `scripts/data-model-lib.ts`) writes every table's columns (type, nullability, default), primary key, unique keys,
   foreign keys with `on delete`, check count, indexes (partial predicates included) and triggers, plus the view and functions, between
   `<!-- schema-reference:start/end -->`. `pnpm data-model:check` compares.
3. **The hand-written sections** (platform, people and RBAC, domain core, scheduling, payments, messaging, memberships, Squarespace
   sync, foreign keys) explain what the tables are for; each table has a row whose first cell is its name, and the migration table
   lists every file in `db/migrations`.

`test/unit/data-model.test.ts` fails when: a table of the schema has no row in the sections (or a row names a table that does not
exist), a migration file is missing from the migration table, the generated reference differs from what `db/schema.sql` renders to,
`db/schema.sql` differs in tables or columns from the live migrated test database, or `pnpm data-model:check` disagrees. It runs in
`pnpm test`, so `pnpm check` enforces it. Adding a migration therefore means: `pnpm db:schema`, one row in the right section, `pnpm
data-model`.

The document's old "intentionally missing foreign keys" list is replaced by the three that remain (`appointments.membership_id`,
`appointments.standing_series_id`, `emergency_notifications.message_id`): the domain tables must not depend on the later verticals
(`test/domain-schema/migration.test.ts`).
