import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/smsgate')

export interface WebhookFixture {
  name: string
  description: string
  secret: string
  headers: Record<string, string>
  body: string
  expect: Record<string, unknown>
}

/** 2026-06-13T16:00:05Z: the moment every webhook fixture was signed. */
export const FIXTURE_NOW = new Date('2026-06-13T16:00:05Z')
export const FIXTURE_SECRET = 'fixture-signing-key'
export const FIXTURE_DEVICE = 'FxDevice0000000001'

export function webhookFixture(name: string): WebhookFixture {
  return JSON.parse(readFileSync(join(ROOT, 'webhooks', `${name}.json`), 'utf8')) as WebhookFixture
}

export function allWebhookFixtures(): WebhookFixture[] {
  return readdirSync(join(ROOT, 'webhooks'))
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => webhookFixture(f.replace(/\.json$/, '')))
}

export interface HttpExchange {
  request: { method: string; path: string; body?: unknown }
  response: { status: number; headers?: Record<string, string>; body?: unknown }
}

export function httpFixtures(): Record<string, HttpExchange> {
  const raw = JSON.parse(readFileSync(join(ROOT, 'http.json'), 'utf8')) as Record<string, unknown>
  delete raw._provenance
  return raw as Record<string, HttpExchange>
}
