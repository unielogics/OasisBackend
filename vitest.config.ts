import { defineConfig } from 'vitest/config'

// Integration tests share one Postgres server; a single fork keeps connection use and migration time predictable and
// each worker owns its own schema (see test/helpers/db.ts), so adding workers later needs no other change.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['./test/global-setup.ts'],
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
