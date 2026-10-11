// In-chat actions confirmed by a reply number (ADR 0160, design sections 0, 3, 4 and 10): only inside the number's trust; the 4-digit
// number is stored only as a salted hash and handed to the caller once; one pending action per number; 15 minutes; 3 wrong replies
// lock it; a spoofed or guessed reply never yields the payload; the trust is checked again at confirmation.
import { describe, expect, it } from 'vitest'
import { hashCode } from '../../src/modules/public/otp.js'
import {
  cancelPendingActions,
  completePendingAction,
  confirmPendingAction,
  createPendingAction,
  expirePendingActions,
  failPendingAction,
  findPendingAction,
  PENDING_ACTION_TTL_MS,
  PENDING_ACTION_WRONG_PER_DAY,
  wrongRepliesToday,
} from '../../src/modules/identity/pending-actions.js'
import { revokeForOptOut } from '../../src/modules/identity/revoke.js'
import { grantTrust, revokeTrust } from '../../src/modules/identity/trust.js'
import { PHONES, useIdentityWorld } from './world.js'

const w = useIdentityWorld()
const MIN = 60_000

async function trusted(): Promise<{ maria: string; conversationId: string }> {
  const maria = await w.customer({})
  const conversationId = w.newId()
  await w.t.db.insertInto('assistant_conversations').values({ id: conversationId, location_id: w.locationId, phone_e164: PHONES.maria, customer_id: maria } as never).execute()
  await w.tx((tx) => grantTrust(tx, { locationId: w.locationId, phone: PHONES.maria, customerId: maria, verifiedBy: 'pin', now: w.clock.now() }))
  return { maria, conversationId }
}

const propose = (o: { maria: string; conversationId: string }, payload: Record<string, string | number> = { serviceKey: 'signature', date: '2026-06-20', startMin: 600 }) =>
  w.tx((tx) =>
    createPendingAction(tx, { newId: w.newId, now: w.clock.now() }, { locationId: w.locationId, conversationId: o.conversationId, customerId: o.maria, phone: PHONES.maria, kind: 'book', payload }),
  )
const reply = (code: string, phone: string = PHONES.maria) => w.tx((tx) => confirmPendingAction(tx, { locationId: w.locationId, phone, code, now: w.clock.now() }))
const wrongOf = (code: string) => String((Number(code) + 1) % 10_000).padStart(4, '0')

describe('createPendingAction', () => {
  it('returns a 4-digit reply number once and stores only its salted hash, 15 minutes', async () => {
    const o = await trusted()
    const p = await propose(o)
    expect(p.code).toMatch(/^\d{4}$/)
    expect(p.expiresAt.getTime() - w.clock.now().getTime()).toBe(PENDING_ACTION_TTL_MS)
    const row = await w.t.db.selectFrom('assistant_pending_actions').selectAll().executeTakeFirstOrThrow()
    expect(row.code_hash).toBe(hashCode(p.id, p.code))
    expect(JSON.stringify(row)).not.toContain(`"${p.code}"`)
    expect(row).toMatchObject({ state: 'pending', attempts: 0, max_attempts: 3, kind: 'book', customer_id: o.maria })
    expect(await findPendingAction(w.t.db, { locationId: w.locationId, phone: PHONES.maria, now: w.clock.now() })).toMatchObject({ id: p.id, kind: 'book', attemptsLeft: 3 })
  })

  it('is refused outside the number’s trust (the assistant’s own check is not the only one)', async () => {
    const maria = await w.customer({})
    const conversationId = w.newId()
    await w.t.db.insertInto('assistant_conversations').values({ id: conversationId, location_id: w.locationId, phone_e164: PHONES.maria, customer_id: maria } as never).execute()
    await expect(propose({ maria, conversationId })).rejects.toMatchObject({ code: 'IDENTITY_NOT_TRUSTED', status: 403 })
    // nor for a client the trust does not belong to
    const liam = await w.customer({ name: 'Liam Chen', phone: PHONES.liam })
    await w.tx((tx) => grantTrust(tx, { locationId: w.locationId, phone: PHONES.liam, customerId: liam, verifiedBy: 'code', now: w.clock.now() }))
    await expect(propose({ maria: liam, conversationId })).rejects.toMatchObject({ code: 'IDENTITY_NOT_TRUSTED' }) // phone is Maria's
  })

  it('keeps one pending action per number: a new proposal supersedes the old one and its number', async () => {
    const o = await trusted()
    const first = await propose(o)
    const second = await propose(o, { serviceKey: 'exterior', date: '2026-06-21', startMin: 540 })
    expect((await w.t.db.selectFrom('assistant_pending_actions').select('state').where('id', '=', first.id).executeTakeFirstOrThrow()).state).toBe('superseded')
    if (first.code !== second.code) expect(await reply(first.code)).toMatchObject({ status: 'wrong' })
    expect(await reply(second.code)).toMatchObject({ status: 'confirmed', action: { id: second.id, payload: { serviceKey: 'exterior' } } })
  })
})

describe('confirmPendingAction', () => {
  it('the right number claims the action and returns its stored payload, once', async () => {
    const o = await trusted()
    const p = await propose(o)
    const r = await reply(`  ${p.code} `)
    expect(r).toEqual({
      status: 'confirmed',
      action: { id: p.id, kind: 'book', customerId: o.maria, conversationId: o.conversationId, payload: { serviceKey: 'signature', date: '2026-06-20', startMin: 600 } },
    })
    expect(await reply(p.code)).toEqual({ status: 'none' })
    const appt = null
    await w.tx((tx) => completePendingAction(tx, p.id, { appointmentId: appt }))
    expect((await w.t.db.selectFrom('assistant_pending_actions').select(['state', 'resolved_at']).executeTakeFirstOrThrow())).toEqual({ state: 'executed', resolved_at: w.clock.now() })
  })

  it('a spoofed or guessed reply never yields the payload: 3 wrong numbers lock the action', async () => {
    const o = await trusted()
    const p = await propose(o)
    expect(await reply(wrongOf(p.code))).toEqual({ status: 'wrong', attemptsLeft: 2 })
    expect(await reply('yes')).toEqual({ status: 'wrong', attemptsLeft: 1 })
    expect(await reply(wrongOf(wrongOf(p.code)))).toEqual({ status: 'locked' })
    expect(await reply(p.code)).toEqual({ status: 'none' })
    // another number cannot confirm it
    const q = await propose(o)
    expect(await reply(q.code, PHONES.liam)).toEqual({ status: 'none' })
  })

  it('expires after 15 minutes (on read, and by the maintenance sweep)', async () => {
    const o = await trusted()
    const p = await propose(o)
    w.advance(15 * MIN)
    expect(await findPendingAction(w.t.db, { locationId: w.locationId, phone: PHONES.maria, now: w.clock.now() })).toBeNull()
    expect(await reply(p.code)).toEqual({ status: 'expired' })
    await propose(o)
    w.advance(16 * MIN)
    expect(await expirePendingActions(w.t.db, w.clock.now())).toBe(1)
    expect(await expirePendingActions(w.t.db, w.clock.now())).toBe(0)
  })

  it('checks the trust again: a revoke or a STOP after the proposal cancels it', async () => {
    const o = await trusted()
    const p = await propose(o)
    await w.tx((tx) => revokeTrust(tx, { locationId: w.locationId, phone: PHONES.maria, reason: 'staff' }))
    expect(await reply(p.code)).toEqual({ status: 'untrusted' })
    expect((await w.t.db.selectFrom('assistant_pending_actions').select(['state', 'error']).executeTakeFirstOrThrow())).toEqual({ state: 'canceled', error: 'trust ended: revoked' })

    await w.tx((tx) => grantTrust(tx, { locationId: w.locationId, phone: PHONES.maria, customerId: o.maria, verifiedBy: 'pin', now: w.clock.now() }))
    await propose(o)
    expect(await w.tx((tx) => revokeForOptOut(tx, { locationId: w.locationId, phone: PHONES.maria, now: w.clock.now() }))).toMatchObject({ pendingActions: 1 })
    expect(await findPendingAction(w.t.db, { locationId: w.locationId, phone: PHONES.maria, now: w.clock.now() })).toBeNull()
  })

  it('records a refused execution, and a cancel by client', async () => {
    const o = await trusted()
    const p = await propose(o)
    await reply(p.code)
    await w.tx((tx) => failPendingAction(tx, p.id, { error: 'slot taken', now: w.clock.now() }))
    expect((await w.t.db.selectFrom('assistant_pending_actions').select(['state', 'error']).executeTakeFirstOrThrow())).toEqual({ state: 'failed', error: 'slot taken' })
    await propose(o)
    expect(await w.tx((tx) => cancelPendingActions(tx, { customerId: o.maria, now: w.clock.now(), error: 'handoff' }))).toBe(1)
  })
})

describe('wrong reply numbers per number and day (W4c review)', () => {
  it('a new or superseding proposal never brings fresh guesses: 5 wrong replies a day per number, then no proposal', async () => {
    const o = await trusted()
    let guesses = 0
    for (let i = 0; i < 10; i++) {
      let p
      try {
        p = await propose(o)
      } catch (e) {
        expect(e).toMatchObject({ code: 'IDENTITY_TOO_MANY_TRIES', status: 429 })
        break
      }
      // two wrong numbers, then ask for a new proposal (supersede), then a third run that locks
      for (let k = 0; k < (i % 2 === 0 ? 2 : 3); k++) {
        const r = await reply(wrongOf(p.code))
        if (r.status === 'wrong' || r.status === 'locked') guesses += 1
      }
    }
    expect(guesses).toBe(PENDING_ACTION_WRONG_PER_DAY)
    expect(await wrongRepliesToday(w.t.db, { locationId: w.locationId, phone: PHONES.maria, now: w.clock.now() })).toBe(PENDING_ACTION_WRONG_PER_DAY)
    await expect(propose(o)).rejects.toMatchObject({ code: 'IDENTITY_TOO_MANY_TRIES', meta: { limit: 'reply_numbers_day' } })
    // the day passes: the number may be proposed to again
    w.advance(24 * 60 * MIN + MIN)
    const p = await propose(o)
    expect(await reply(p.code)).toMatchObject({ status: 'confirmed' })
  })

  it('the wrong reply that reaches the day’s limit locks the pending action at once (its own tries left do not matter)', async () => {
    const o = await trusted()
    const a = await propose(o)
    for (let k = 0; k < 2; k++) expect(await reply(wrongOf(a.code))).toMatchObject({ status: 'wrong' })
    const b = await propose(o) // supersedes a: 2 wrong so far
    for (let k = 0; k < 2; k++) expect(await reply(wrongOf(b.code))).toMatchObject({ status: 'wrong' })
    const c = await propose(o) // 4 wrong so far: the next wrong one is the fifth
    expect(await reply(wrongOf(c.code))).toEqual({ status: 'locked' })
    expect(await reply(c.code)).toEqual({ status: 'none' })
    expect((await w.t.db.selectFrom('assistant_pending_actions').select('state').where('id', '=', c.id).executeTakeFirstOrThrow()).state).toBe('locked')
  })

  it('right replies do not count: a client who confirms every day is never limited', async () => {
    const o = await trusted()
    for (let i = 0; i < 8; i++) {
      const p = await propose(o)
      expect(await reply(p.code)).toMatchObject({ status: 'confirmed' })
    }
    expect(await wrongRepliesToday(w.t.db, { locationId: w.locationId, phone: PHONES.maria, now: w.clock.now() })).toBe(0)
  })

  it('another number’s wrong replies never count against this one', async () => {
    const o = await trusted()
    const liam = await w.customer({ name: 'Liam Chen', phone: PHONES.liam })
    await w.tx((tx) => grantTrust(tx, { locationId: w.locationId, phone: PHONES.liam, customerId: liam, verifiedBy: 'pin', now: w.clock.now() }))
    const lp = await w.tx((tx) =>
      createPendingAction(tx, { newId: w.newId, now: w.clock.now() }, { locationId: w.locationId, conversationId: o.conversationId, customerId: liam, phone: PHONES.liam, kind: 'book', payload: { x: 1 } }),
    )
    for (let k = 0; k < 3; k++) await reply(wrongOf(lp.code), PHONES.liam)
    const p = await propose(o)
    expect(await reply(p.code)).toMatchObject({ status: 'confirmed' })
  })
})
