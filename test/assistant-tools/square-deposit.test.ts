// The booking deposit by Square link on the assistant's path (ADR 0171 D2): a booking confirmed by its reply number asks for a deposit
// link in the same transaction when the guest fee is collected by link and Square is the processor (the job square.deposit-link makes
// and texts it); a member owes none; before the cutover nothing is asked.
import { afterEach, describe, expect, it } from 'vitest'
import { SIM_DEVICE_KEY } from '../../db/seeds/messaging.js'
import { loadEnv } from '../../src/config/env.js'
import type { AnyAssistantTool, ToolOutcome } from '../../src/modules/assistant/contract.js'
import { createActionCodeHandler } from '../../src/modules/assistant/actions/handler.js'
import { createToolRegistry } from '../../src/modules/assistant/tools/index.js'
import { configureSquareRuntime } from '../../src/modules/square/runtime.js'
import { testDatabaseUrl } from '../helpers/env.js'
import { coreVars } from '../square-db/core.js'
import { useToolWorld, type CtxProbe } from './world.js'

const w = useToolWorld()
afterEach(() => configureSquareRuntime({}))
const tool = (name: string): AnyAssistantTool => createToolRegistry(w.deps).get(name)!
const maria = () => w.customer('Maria Delgado')
let n = 5000

async function run(name: string, probe: CtxProbe, input: unknown): Promise<ToolOutcome> {
  const t = tool(name)
  return t.run(probe.ctx, t.input.parse(input))
}

async function inbound(phone: string, text: string) {
  n += 1
  const ev = w.signed('sms:received', { messageId: `sq-in-${n}`, sender: phone, recipient: '+18623885827', simNumber: 1, message: text, receivedAt: w.clock.now().toISOString() })
  await w.rt.webhooks.receive(SIM_DEVICE_KEY, ev.headers, ev.body)
  await w.settle()
}

async function lastCode(phone: string): Promise<string> {
  const r = await w.t.db.selectFrom('sms_outbox').select('body').where('to_e164', '=', phone).where('klass', '=', 'action_confirm').orderBy('queued_at', 'desc').executeTakeFirstOrThrow()
  return /Reply (\d{4}) to confirm/.exec(r.body)![1]!
}

async function bookByText(): Promise<string> {
  await w.assistantOn({ actions: true })
  await w.trust(maria().phone, maria().id)
  await inbound(maria().phone, 'Can I book an express wash Monday at 10?')
  const probe = await w.ctx({ customerId: maria().id, phone: maria().phone, trust: 'trusted' })
  const r = await run('propose_booking', probe, { serviceKey: 'express-hand-wash', addonKeys: [], date: '2026-06-15', startMin: 600, vehicle: null })
  expect(r.ok).toBe(true)
  const code = await lastCode(maria().phone)
  await w.tx((tx) => createActionCodeHandler(w.deps).handle(tx, { locationId: w.locationId, phone: maria().phone, customerId: maria().id, code, inboxId: w.newId(), at: w.clock.now() }))
  const a = await w.t.db.selectFrom('appointments').select('id').where('customer_id', '=', maria().id).executeTakeFirstOrThrow()
  return a.id
}

const depositRows = () => w.t.db.selectFrom('payment_links').select(['state', 'origin', 'expected_cents', 'purpose', 'provider']).execute()

describe('deposit link on the assistant’s booking path', () => {
  it('with Square and the fee by link: a deposit request for the fee, in the booking’s transaction', async () => {
    configureSquareRuntime({ env: loadEnv({ NODE_ENV: 'test', DATABASE_URL: testDatabaseUrl(), ...coreVars }) })
    await w.setting('booking.guest_fee', { cents: 2000, collect: 'link' })
    await bookByText()
    expect(await depositRows()).toEqual([{ state: 'pending', origin: 'booking', expected_cents: 2000, purpose: 'deposit', provider: 'square' }])
  })

  it('before the cutover, or with the fee at the counter, nothing is asked', async () => {
    configureSquareRuntime({ env: loadEnv({ NODE_ENV: 'test', DATABASE_URL: testDatabaseUrl(), ...coreVars, PAYMENT_PROCESSOR: 'squarespace' }) })
    await w.setting('booking.guest_fee', { cents: 2000, collect: 'link' })
    await bookByText()
    expect(await depositRows()).toEqual([])
  })
})
