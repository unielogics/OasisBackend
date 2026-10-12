// pnpm square:webhooks: what --apply would do, and doing it against the simulator (create prints the key once, update keeps it); the
// real program runs before the signature key exists (the first --apply of the rollout, while the stack is still SQUARE_PROVIDER=sim).
import path from 'node:path'
import type { Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { loadEnv } from '../../src/config/env.js'
import { planWebhookSubscription, runSquareWebhooks, webhooksScriptEnv } from '../../scripts/square-webhooks.js'
import { closeSim, createSquareSimHttpServer, listenSim } from '../../src/integrations/square/sim/index.js'
import { sh } from '../ops-kit/deploy-helpers.js'
import { testDatabaseUrl } from '../helpers/env.js'
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

  it('reads only the Square settings it needs: no signature key yet, whatever SQUARE_PROVIDER says, always the live client', () => {
    const base = { SQUARE_ACCESS_TOKEN: 'test-token-not-real-0001', SQUARE_WEBHOOK_URL: URL_ }
    // the deadlock this avoids: the full contract refuses live without the key the script is there to create
    expect(() => loadEnv({ NODE_ENV: 'test', DATABASE_URL: testDatabaseUrl(), ...base, SQUARE_PROVIDER: 'live', SQUARE_LOCATION_ID: 'L1', SQUARE_APPLICATION_ID: 'a' })).toThrow(
      /SQUARE_WEBHOOK_SIGNATURE_KEY: required when SQUARE_PROVIDER=live/,
    )
    for (const provider of ['sim', 'live', undefined]) {
      const r = webhooksScriptEnv({ ...base, SQUARE_PROVIDER: provider, SQUARE_ENVIRONMENT: 'production' })
      expect(r.ok, String(provider)).toBe(true)
      if (r.ok) expect(r.env).toMatchObject({ SQUARE_PROVIDER: 'live', SQUARE_ENVIRONMENT: 'production', SQUARE_WEBHOOK_URL: URL_ })
    }
    expect(webhooksScriptEnv({ SQUARE_WEBHOOK_URL: URL_ })).toEqual({ ok: false, message: expect.stringMatching(/needs SQUARE_ACCESS_TOKEN$/) })
    expect(webhooksScriptEnv({ SQUARE_ACCESS_TOKEN: base.SQUARE_ACCESS_TOKEN })).toEqual({ ok: false, message: expect.stringMatching(/needs SQUARE_WEBHOOK_URL/) })
    expect(webhooksScriptEnv({ ...base, SQUARE_WEBHOOK_URL: 'not a url' })).toEqual({ ok: false, message: expect.stringMatching(/SQUARE_WEBHOOK_URL/) })
  })

  describe('the program', () => {
    let server: Server | undefined
    afterEach(async () => {
      if (server) await closeSim(server)
      server = undefined
    })

    it('--apply creates the subscription with no signature key configured, on a stack still at SQUARE_PROVIDER=sim', async () => {
      const store = new SquareSimStore(new FixedClock('2026-10-12T15:00:00Z'))
      server = createSquareSimHttpServer(new SquareSimApi(store, { tokens: ['t-0000000001'] }))
      const base = await listenSim(server)
      const env = {
        SQUARE_PROVIDER: 'sim',
        SQUARE_ACCESS_TOKEN: 't-0000000001',
        SQUARE_WEBHOOK_URL: URL_,
        SQUARE_API_BASE: base,
        SQUARE_WEBHOOK_SIGNATURE_KEY: undefined,
        SQUARE_WEBHOOK_SIGNATURE_KEY_PREVIOUS: undefined,
        OASIS_SECRET_ID: undefined,
      }
      const r = await sh(path.join(process.cwd(), 'node_modules/.bin/tsx'), [path.join(process.cwd(), 'scripts/square-webhooks.ts'), '--apply'], env)
      expect(r.code, r.out).toBe(0)
      expect(r.stdout).toMatch(/created subscription/)
      expect(store.webhookSubscriptions.size).toBe(1)
      // the same with SQUARE_PROVIDER=live and still no key: the app would refuse to start, the script does not need it
      const again = await sh(path.join(process.cwd(), 'node_modules/.bin/tsx'), [path.join(process.cwd(), 'scripts/square-webhooks.ts')], { ...env, SQUARE_PROVIDER: 'live' })
      expect(again.code, again.out).toBe(0)
      expect(again.stdout).toMatch(/up to date/)
      // nothing to talk to without a token
      const none = await sh(path.join(process.cwd(), 'node_modules/.bin/tsx'), [path.join(process.cwd(), 'scripts/square-webhooks.ts')], { ...env, SQUARE_ACCESS_TOKEN: undefined })
      expect(none.code).toBe(2)
      expect(none.stdout).toMatch(/needs SQUARE_ACCESS_TOKEN/)
    }, 60_000)
  })
})
