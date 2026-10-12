// pnpm square:webhooks: what --apply would do, and doing it against the simulator (create prints the key once, update keeps it).
import { describe, expect, it } from 'vitest'
import { planWebhookSubscription, runSquareWebhooks } from '../../scripts/square-webhooks.js'
import { createSquareApi } from '../../src/integrations/square/api/index.js'
import { SquareClient } from '../../src/integrations/square/client.js'
import { SQUARE_EVENT_TYPES } from '../../src/integrations/square/webhook.js'
import { SquareSimApi, SquareSimStore, simFetch } from '../../src/integrations/square/sim/index.js'
import { FixedClock } from '../../src/platform/clock.js'

const URL_ = 'https://oasis.example.com/hooks/square'

describe('square:webhooks', () => {
  it('plans create, update (missing types, another version, disabled) or nothing', () => {
    expect(planWebhookSubscription([], URL_).action).toBe('create')
    const full = { id: 'w1', notification_url: URL_, event_types: [...SQUARE_EVENT_TYPES], api_version: '2026-09-16', enabled: true }
    expect(planWebhookSubscription([full], URL_)).toMatchObject({ action: 'none', subscriptionId: 'w1' })
    expect(planWebhookSubscription([{ ...full, event_types: ['payment.updated'] }], URL_)).toMatchObject({ action: 'update', missingTypes: expect.arrayContaining(['refund.created']) })
    expect(planWebhookSubscription([{ ...full, api_version: '2025-01-23' }], URL_).reasons).toEqual(['API version 2025-01-23 instead of 2026-09-16'])
    expect(planWebhookSubscription([{ ...full, enabled: false }], URL_).reasons).toEqual(['disabled'])
    expect(planWebhookSubscription([{ ...full, notification_url: 'https://other/hooks/square' }], URL_).action).toBe('create')
  })

  it('--apply creates the subscription and prints its key once; a second --apply changes nothing; --rotate-key prints a new key', async () => {
    const store = new SquareSimStore(new FixedClock('2026-10-12T15:00:00Z'))
    const sim = new SquareSimApi(store, { tokens: ['t-0000000001'] })
    const api = createSquareApi(new SquareClient({ baseUrl: 'http://sim', accessToken: 't-0000000001', fetch: simFetch(sim), writesEnabled: false }))
    const lines: string[] = []
    const log = (l: string) => lines.push(l)
    expect(await runSquareWebhooks(api, { url: URL_, apply: false, rotate: false, log })).toBe(0)
    expect(store.webhookSubscriptions.size).toBe(0)
    expect(lines.join('\n')).toMatch(/run again with --apply/)
    lines.length = 0
    expect(await runSquareWebhooks(api, { url: URL_, apply: true, rotate: false, log })).toBe(0)
    expect(store.webhookSubscriptions.size).toBe(1)
    const sub = [...store.webhookSubscriptions.values()][0]!
    expect(sub).toMatchObject({ notification_url: URL_, api_version: '2026-09-16', event_types: [...SQUARE_EVENT_TYPES] })
    expect(lines[1]).toMatch(/shown once/)
    expect(lines[2]!.length).toBeGreaterThan(10)
    lines.length = 0
    await runSquareWebhooks(api, { url: URL_, apply: true, rotate: false, log })
    expect(lines).toEqual([`webhook subscription for ${URL_}: up to date`])
    lines.length = 0
    expect(await runSquareWebhooks(api, { url: URL_, apply: false, rotate: true, log })).toBe(0)
    expect(lines.at(-1)!.length).toBeGreaterThan(10)
  })
})
