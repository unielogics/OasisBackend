// The registry, the catalogue and docs/jobs.md must agree. A job added without a catalogue entry or without a row in the
// document fails here; so does a document that is out of date or that claims a job that does not exist.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { jobDefinitions } from '../../src/platform/job-registry.js'
import {
  jobCatalog,
  renderJobsTable,
  JOBS_TABLE_END,
  JOBS_TABLE_START,
} from '../../src/platform/jobs-catalog.js'
import { assertValidCron, dstRiskyCron } from '../../src/platform/jobs-cron.js'
import { JOBS_DOC, renderedJobsDoc } from '../../src/platform/jobs-doc.js'
import { DEFAULT_TZ } from '../../src/platform/time.js'

const doc = readFileSync(JOBS_DOC, 'utf8')
const names = jobDefinitions.map((d) => d.name)

describe('job registry', () => {
  it('has unique <area>.<action> names', () => {
    expect(new Set(names).size).toBe(names.length)
    for (const n of names) expect(n, n).toMatch(/^[a-z_]+(\.[a-z_-]+)+$/)
  })

  it('has valid cron schedules, none at a fixed local time in the DST-sensitive hours', () => {
    for (const d of jobDefinitions) {
      if (!d.cron) continue
      expect(() => assertValidCron(d.cron!, d.tz ?? DEFAULT_TZ), d.name).not.toThrow()
      expect(dstRiskyCron(d.cron), `${d.name} ${d.cron}`).toBe(false)
    }
  })

  it('gives every periodic job a policy that cannot pile up (no standard or singleton policy on a cron job)', () => {
    for (const d of jobDefinitions.filter((j) => j.cron))
      expect(['short', 'stately'], `${d.name} policy`).toContain(d.policy)
  })

  it('expires a job that fires every few minutes within 15 minutes, so a crashed run is noticed before many are missed', () => {
    for (const d of jobDefinitions.filter((j) => j.cron && /^\*(\/\d+)? \* \* \* \*$/.test(j.cron))) {
      // a job that fires every few minutes must not wait 15 minutes to be recognised as crashed when it is retried
      expect(d.expireInSeconds ?? 900, `${d.name} expiry`).toBeLessThanOrEqual(900)
    }
  })
})

describe('the job catalogue', () => {
  it('has an entry for every registered job and no entry for a job that does not exist', () => {
    expect(Object.keys(jobCatalog).sort()).toEqual([...names].sort())
  })

  it('states, for every job, why a repeat is safe, how it reads time and which tests run it', () => {
    for (const [name, c] of Object.entries(jobCatalog)) {
      for (const f of ['owner', 'purpose', 'idempotency', 'clock', 'tests'] as const)
        expect(c[f].trim().length, `${name}.${f}`).toBeGreaterThan(5)
      if (!jobDefinitions.find((d) => d.name === name)?.cron)
        expect(c.enqueuedBy, `${name} enqueuedBy`).toBeTruthy()
      expect(['built', 'existing']).toContain(c.status)
    }
  })
})

describe('docs/jobs.md', () => {
  it('contains exactly the table rendered from the registry (run pnpm jobs:doc after changing a job)', () => {
    expect(renderedJobsDoc(doc)).toBe(doc)
    const a = doc.indexOf(JOBS_TABLE_START)
    const b = doc.indexOf(JOBS_TABLE_END)
    expect(doc.slice(a + JOBS_TABLE_START.length, b).trim()).toBe(renderJobsTable(jobDefinitions, DEFAULT_TZ))
  })

  it('lists every registered job, and names no job that is not registered', () => {
    for (const n of names) expect(doc, n).toContain(`\`${n}\``)
    const mentioned = new Set([...doc.matchAll(/`([a-z_]+(?:\.[a-z_-]+)+)`/g)].map((m) => m[1]!))
    const known = new Set(names)
    const shaped = [...mentioned].filter(
      (m) =>
        /^(appointments|credit|email|emergency|federal_holidays|maintenance|membership|payments|photos|sms|sqsp|vip|ledger|notifications|standing|waitlist)\./.test(
          m,
        ) &&
        !m.endsWith('.ts') &&
        !m.endsWith('.md'),
    )
    // the gap rows name jobs that deliberately do not exist; everything else must be real
    const GAPS = new Set([
      'appointments.no_show_scan',
      'ledger.integrity_check',
      'notifications.alerts_refresh',
      'standing.*',
      'waitlist.*',
      'sqsp.token.refresh',
      'sqsp.webhooks.ensure',
      'maintenance.*',
    ])
    expect(shaped.filter((m) => !known.has(m) && !GAPS.has(m) && !m.endsWith('.dead'))).toEqual([])
  })

  it('has a state of exists, built or gap on every row of the required-behaviours table, and gaps say why', () => {
    const section = doc.slice(doc.indexOf('## Required behaviours'), doc.indexOf('## What the platform does'))
    const rows = section
      .split('\n')
      .filter((l) => l.startsWith('| ') && !l.startsWith('| Behaviour') && !l.startsWith('|---'))
    expect(rows.length).toBeGreaterThanOrEqual(20)
    for (const r of rows) {
      const cells = r
        .split('|')
        .slice(1, -1)
        .map((c) => c.trim())
      expect(cells, r).toHaveLength(4)
      expect(cells[2], r).toMatch(/^(exists|built|gap)\b/)
      expect(cells[3]!.length, r).toBeGreaterThan(10)
      if (cells[2]!.startsWith('exists') || cells[2]!.startsWith('built')) {
        const jobsNamed = [...cells[1]!.matchAll(/`([^`]+)`/g)].map((m) => m[1]!)
        const real = jobsNamed.filter((j) => names.includes(j))
        const exempt = /pg-boss supervisor|maintenance\.\*/.test(cells[1]! + cells[2]!)
        expect(real.length > 0 || exempt, r).toBe(true)
      }
    }
  })
})
