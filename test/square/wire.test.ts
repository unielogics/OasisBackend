// Every captured sandbox answer parses through our wire schemas (unknown fields pass through), errors map to our typed errors, and
// the captured events go through the dispatcher. The fixtures themselves carry no secret and no real id.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SquareDeclined, SquareApiError, squareErrorFrom } from '../../src/integrations/square/errors.js'
import { SQUARE_EVENT_TYPES, classifySquareEvent, parseSquareEvent } from '../../src/integrations/square/webhook.js'
import { wire } from '../../src/integrations/square/wire.js'
import { FIXTURE_DIR, fixture, fixtureNames } from './fixtures.js'

const SCHEMA: Record<string, keyof typeof wire> = {
  locations: 'locations',
  'customer-create': 'customer',
  'customers-search': 'customers',
  'card-create': 'card',
  'card-disable': 'card',
  'payment-card-on-file': 'payment',
  'payment-link-order': 'payment',
  'refund-create': 'refund',
  'refund-completed': 'refund',
  'payment-link-create': 'paymentLink',
  'payment-link-quick-pay': 'paymentLink',
  'payment-link-retrieve-after-pay': 'paymentLink',
  'payment-link-delete': 'deletedPaymentLink',
  'order-link-draft': 'order',
  'order-open': 'order',
  'catalog-plan-upsert': 'catalogObject',
  'catalog-variations-batch-upsert': 'catalogBatch',
  'subscription-create': 'subscription',
  'subscription-active-with-invoice': 'subscription',
  'subscription-swap-plan': 'subscription',
  'subscription-pause': 'subscription',
  'subscription-cancel': 'subscription',
  'invoice-paid': 'invoice',
  'invoice-unpaid-subscription': 'invoice',
  'events-search': 'events',
  'event-types': 'eventTypes',
  'webhook-event-types': 'eventTypes',
  'events-enable': 'empty',
  'customer-delete': 'empty',
}

describe('wire schemas against the sandbox answers', () => {
  it('every 2xx fixture has a schema and parses', () => {
    for (const name of fixtureNames()) {
      const f = fixture(name)
      if (f.status >= 300) continue
      const key = SCHEMA[name]
      expect(key, `no schema mapped for fixture ${name}`).toBeDefined()
      const r = wire[key!].safeParse(f.body)
      expect(r.success, `${name}: ${r.success ? '' : r.error.message}`).toBe(true)
    }
  })

  it('keeps the facts Oasis relies on', () => {
    const p = wire.payment.parse(fixture('payment-card-on-file').body).payment
    expect(p).toMatchObject({ status: 'COMPLETED', source_type: 'CARD', card_details: { entry_method: 'ON_FILE', card: { card_brand: 'VISA', last_4: '5858' } } })
    expect(p.application_details?.square_product).toBe('ECOMMERCE_API')
    const link = wire.paymentLink.parse(fixture('payment-link-create').body)
    expect(new URL(link.payment_link.url).host).toBe('sandbox.square.link')
    expect(link.related_resources?.orders?.[0]).toMatchObject({ state: 'DRAFT', total_money: { amount: 4265, currency: 'USD' } })
    const sub = wire.subscription.parse(fixture('subscription-active-with-invoice').body).subscription
    expect(sub).toMatchObject({ status: 'ACTIVE', charged_through_date: '2026-11-12' })
    expect(sub.invoice_ids).toHaveLength(1)
    const unpaid = wire.invoice.parse(fixture('invoice-unpaid-subscription').body).invoice
    expect(unpaid).toMatchObject({ status: 'UNPAID', subscription_id: expect.any(String) })
    expect(unpaid.payment_requests?.[0]?.automatic_payment_source).toBe('NONE')
    const swap = wire.subscription.parse(fixture('subscription-swap-plan').body)
    expect(swap.actions?.[0]).toMatchObject({ type: 'SWAP_PLAN', effective_date: '2026-11-12' })
  })

  it('error answers become our typed errors', () => {
    const e = (name: string) => {
      const f = fixture(name)
      return squareErrorFrom(f.status, f.body, f.method, f.path)
    }
    const declined = e('payment-declined-generic')
    expect(declined).toBeInstanceOf(SquareDeclined)
    expect(declined.code).toBe('GENERIC_DECLINE')
    expect((declined.body as { payment: { status: string } }).payment.status).toBe('FAILED')
    expect(e('payment-declined-cvv').code).toBe('CVV_FAILURE')
    expect(e('card-create-declined-nonce')).not.toBeInstanceOf(SquareDeclined)
    expect(e('card-create-declined-nonce').code).toBe('INVALID_CARD_DATA')
    expect(e('subscription-resume-invalid-date').code).toBe('INVALID_DATE')
    expect(e('subscription-cancel-again').errors[0]!.detail).toMatch(/already has a pending cancel date/)
    const forbidden = e('payment-invoice-order-forbidden')
    expect(forbidden).toBeInstanceOf(SquareApiError)
    expect(forbidden.status).toBe(403)
  })

  it('every captured event parses and the dispatcher classifies it; our event types exist for webhooks and events', () => {
    const events = wire.events.parse(fixture('events-search').body).events
    expect(events.length).toBeGreaterThan(10)
    const kinds = new Set<string>()
    for (const e of events) {
      const r = parseSquareEvent(JSON.stringify(e))
      expect(r.ok, e.type).toBe(true)
      const c = classifySquareEvent(e)
      if (c.kind) kinds.add(c.kind)
    }
    expect([...kinds].sort()).toEqual(['card', 'customer', 'invoice', 'payment', 'refund', 'subscription'])
    for (const name of ['webhook-event-types', 'event-types']) {
      const types = wire.eventTypes.parse(fixture(name).body).event_types
      for (const t of SQUARE_EVENT_TYPES) expect(types, `${name}: ${t}`).toContain(t)
    }
  })

  it('the fixtures hold no token, no application id, no real id and no email but the placeholder', () => {
    for (const name of fixtureNames()) {
      const text = readFileSync(path.join(FIXTURE_DIR, `${name}.json`), 'utf8')
      expect(text, name).not.toMatch(/EAAA|sq0a[tc]p-|sq0csp-|sq0idp-|sq0idb-|ccof:|inv:0-|LCEVRH/)
      for (const m of text.matchAll(/[\w.+-]+@[\w-]+\.[\w.]+/g)) expect(m[0], name).toBe('verify@example.com')
    }
  })
})
