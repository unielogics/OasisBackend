// The scrubbed sandbox answers captured by pnpm verify:square --capture on 2026-10-12 (test/fixtures/square/).
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

export const FIXTURE_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'fixtures', 'square')

export interface Capture {
  method: string
  path: string
  status: number
  body: Record<string, unknown>
}

export function fixture(name: string): Capture {
  return JSON.parse(readFileSync(path.join(FIXTURE_DIR, `${name}.json`), 'utf8')) as Capture
}

export function fixtureNames(): string[] {
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))
}
