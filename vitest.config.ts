import { defineConfig } from 'vitest/config'

// Integration tests share one Postgres server. Files run one at a time, each in a fresh child process: a single long-lived
// fork grew about 10 MB per file and ran out of its 2 GB heap two thirds of the way through the suite. Each worker owns its
// own schema (see test/helpers/db.ts), so more workers (pnpm test:fast) need no other change.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['./test/global-setup.ts'],
    pool: 'forks',
    poolOptions: { forks: { singleFork: false, isolate: true, minForks: 1, maxForks: 1 } },
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
