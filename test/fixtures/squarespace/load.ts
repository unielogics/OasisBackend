import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const dir = dirname(fileURLToPath(import.meta.url))

export function fixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(join(dir, name), 'utf8')) as T
}

export interface WebhookFixture {
  secret: string
  orderCreate: { body: string; signature: string }
  orderUpdate: { body: string; signature: string }
  extensionUninstall: { body: string; signature: string }
}

export const NOW = '2026-10-06T14:00:00.000Z'
