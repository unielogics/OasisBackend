// Regenerates (or with --check, verifies) the job table of docs/jobs.md from the registry: pnpm jobs:doc
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DEFAULT_TZ } from './time.js'
import { jobDefinitions } from './job-registry.js'
import { renderJobsTable, withJobsTable } from './jobs-catalog.js'

export const JOBS_DOC = fileURLToPath(new URL('../../docs/jobs.md', import.meta.url))

export const renderedJobsDoc = (current: string): string =>
  withJobsTable(current, renderJobsTable(jobDefinitions, DEFAULT_TZ))

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const current = readFileSync(JOBS_DOC, 'utf8')
  const next = renderedJobsDoc(current)
  if (process.argv.includes('--check')) {
    if (next !== current) {
      console.error('docs/jobs.md is out of date: run pnpm jobs:doc')
      process.exit(1)
    }
  } else if (next !== current) {
    writeFileSync(JOBS_DOC, next)
    console.log('docs/jobs.md updated')
  }
}
