import { defineConfig } from 'vitest/config'

// Integration tests share one Postgres server; a single fork keeps connection use and migration time predictable and
// each worker owns its own schema (see test/helpers/db.ts), so adding workers later needs no other change. The fork keeps
// about 10 MB per test file, so it gets its own 6 GB heap (4 GB ran out at about 380 files, 2026-10-12) (a fresh fork per file re-migrates its schema and is 5x slower).
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['./test/global-setup.ts'],
    pool: 'forks',
    poolOptions: { forks: { singleFork: true, execArgv: ['--max-old-space-size=6144'] } },
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
