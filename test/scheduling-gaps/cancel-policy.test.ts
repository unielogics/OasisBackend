// Gap 1: cancel and no-show EXECUTE the deposit policy. The policy is a setting (free-cancel window, share kept inside it, share
// kept on a no-show, where a refund goes); cancel/no-show turn it into real ledger events through the payments command layer
// (system source, limit-exempt, idempotent, a card refund awaits Squarespace), settle the invoice state, write the activity log
// and queue the cancellation SMS. Real Postgres, the real app, the real payments gateway and the messaging queue.
import { describe, expect, it } from 'vitest'
import {
  activityOf,
  idemKey,
  invoiceState,
  ledgerOf,
  opsEvents,
  outboundTexts,
  recordPayment,
  setPolicy,
  useRig,
} from './support.js'

const SAT = '2026-06-13T14:00:00-04:00' // 3h24m after the frozen clock (10:36)
const MON = '2026-06-15T10:00:00-04:00' // 47h24m after it

interface Settlement {
  policy: string
  heldCents: number
  refundedCents: number
  retainedCents: number
  refunds: { eventId: string; amountCents: number; dest: string; state: string; awaitingProcessor: boolean }[]
  rule: string
}
interface Canceled {
  appointment: { status: string }
  invoice: { status: string; paidCents: number; refundPending: boolean }
  depositPolicy: string
  settlement: Settlement
}

describe('cancel executes the deposit policy', () => {
  const m = useRig()
  const cancel = (
    id: string,
    body: Record<string, unknown> = {},
    o: { key?: string; s?: ReturnType<typeof m.superS> } = {},
  ) =>
    m.send(
      o.s ?? m.superS(),
      'POST',
      `/appointments/${id}/cancel`,
      { reason: 'Customer called', ...body },
      o.key ?? idemKey(),
    )

  it('inside the free window with the default policy the deposit is refunded in full to the card and waits on Squarespace', async () => {
    const a = await m.book('Maria Delgado', 'Express Hand Wash', MON)
    const pay = await recordPayment(m, a.invoiceId, 2500)
    const res = await cancel(a.appointmentId, { notify: true })
    expect(res.statusCode, res.body).toBe(200)
    const b = res.json() as Canceled
    expect(b.appointment.status).toBe('canceled')
    expect(b.depositPolicy).toBe('policy')
    expect(b.settlement).toMatchObject({
      policy: 'policy',
      heldCents: 2500,
      refundedCents: 2500,
      retainedCents: 0,
      refunds: [{ amountCents: 2500, dest: 'card', state: 'done', awaitingProcessor: true }],
    })
    expect(b.settlement.rule).toBe(
      'Canceled 47h ahead · free cancellation up to 24h before · refunded in full',
    )
    expect(b.invoice).toMatchObject({ status: 'canceled_refunded', refundPending: false })

    const ledger = await ledgerOf(m, a.invoiceId)
    expect(ledger.map((e) => e.type)).toEqual(['pay', 'refund'])
    expect(ledger[1]).toMatchObject({
      amount_cents: 2500,
      status: 'done',
      dest: 'card',
      method_kind: 'card',
      processor_state: 'awaiting_processor',
      source: 'system',
      reason: 'Cancellation policy',
      actor_roles: 'Cancellation policy',
    })
    expect(ledger[1]!.note).toBe(b.settlement.rule)
    expect(await invoiceState(m, a.invoiceId)).toMatchObject({
      status: 'canceled_refunded',
      paid: 2500,
      refunded: 2500,
      balance: 0,
    })
    expect(pay).toBeTruthy()

    expect(await activityOf(m, a.appointmentId)).toEqual(
      expect.arrayContaining([
        'Appointment canceled · Customer called',
        'Deposit refunded · $25.00 to the card (awaiting Squarespace)',
        'Cancellation notice sent',
      ]),
    )
    const texts = await outboundTexts(m, a.appointmentId)
    expect(texts.at(-1)).toContain('has been canceled')
    expect(texts.at(-1)).toContain('Your $25.00 deposit is being refunded to your card.')
    expect((await opsEvents(m, 'appointment.updated')).at(-1)!.payload).toMatchObject({
      status: 'canceled',
      change: 'canceled',
    })
    expect(
      (
        await m.h.t.db
          .selectFrom('realtime_events')
          .select('type')
          .where('channel', '=', 'payments')
          .execute()
      ).map((e) => e.type),
    ).toContain('ledger.event')
  })

  it('inside the late window the deposit is kept: no refund event, canceled_kept, and the text says so', async () => {
    const a = await m.book('Maria Delgado', 'Express Hand Wash', SAT)
    await recordPayment(m, a.invoiceId, 2500)
    const b = (await cancel(a.appointmentId, { notify: true })).json() as Canceled
    expect(b.settlement).toMatchObject({
      heldCents: 2500,
      refundedCents: 0,
      retainedCents: 2500,
      refunds: [],
    })
    expect(b.settlement.rule).toBe(
      'Canceled 3h ahead · inside the 24h free cancellation window · deposit kept',
    )
    expect(b.invoice.status).toBe('canceled_kept')
    expect((await ledgerOf(m, a.invoiceId)).map((e) => e.type)).toEqual(['pay'])
    expect(await activityOf(m, a.appointmentId)).toContain('Deposit kept · $25.00 (cancellation policy)')
    expect((await outboundTexts(m, a.appointmentId)).at(-1)).toContain(
      'Your $25.00 deposit is kept under our cancellation policy.',
    )
  })

  it('a partly retained deposit refunds the rest: half-up on the kept share, one refund event', async () => {
    await setPolicy(m, { lateRetainBp: 5000 })
    const a = await m.book('Maria Delgado', 'Express Hand Wash', SAT)
    await recordPayment(m, a.invoiceId, 2501)
    const b = (await cancel(a.appointmentId, { notify: true })).json() as Canceled
    expect(b.settlement).toMatchObject({ heldCents: 2501, retainedCents: 1251, refundedCents: 1250 })
    expect(b.settlement.rule).toBe(
      'Canceled 3h ahead · inside the 24h free cancellation window · 50% of the deposit kept',
    )
    expect(b.invoice.status).toBe('canceled_kept')
    expect(await invoiceState(m, a.invoiceId)).toMatchObject({ paid: 2501, refunded: 1250 })
    expect((await outboundTexts(m, a.appointmentId)).at(-1)).toContain(
      '$12.50 of your $25.01 deposit is being refunded to your card; $12.51 is kept under our cancellation policy.',
    )
  })

  it('a cash deposit goes back as cash, a card one to the card, and refundTo credit issues store credit', async () => {
    const cash = await m.book('Maria Delgado', 'Express Hand Wash', MON)
    await recordPayment(m, cash.invoiceId, 2000, { kind: 'cash' })
    await cancel(cash.appointmentId)
    expect((await ledgerOf(m, cash.invoiceId))[1]).toMatchObject({
      dest: 'cash',
      method_kind: 'cash',
      processor_state: 'na',
    })

    await setPolicy(m, { refundTo: 'credit' })
    const card = await m.book('Liam Chen', 'Express Hand Wash', MON)
    await recordPayment(m, card.invoiceId, 3000)
    const b = (await cancel(card.appointmentId, { notify: true })).json() as Canceled
    expect(b.settlement.refunds).toEqual([
      expect.objectContaining({ amountCents: 3000, dest: 'credit', state: 'done', awaitingProcessor: false }),
    ])
    expect((await ledgerOf(m, card.invoiceId))[1]).toMatchObject({
      dest: 'credit',
      method_kind: 'store_credit',
      processor_state: 'na',
    })
    expect((await outboundTexts(m, card.appointmentId)).at(-1)).toContain(
      'Your $30.00 deposit was added to your store credit.',
    )
  })

  it('is exempt from the actor’s refund limit and needs no pay.refund: a cancel-only user still refunds a $400 deposit', async () => {
    const clerk = (await m.h.userWithPermissions(['sched.view', 'sched.cancel'], 'clerk@example.test'))
      .session
    const a = await m.book('Maria Delgado', 'Express Hand Wash', MON)
    await recordPayment(m, a.invoiceId, 40_000, { kind: 'cash' })
    const res = await cancel(a.appointmentId, {}, { s: clerk })
    expect(res.statusCode, res.body).toBe(200)
    const ev = (await ledgerOf(m, a.invoiceId))[1]!
    expect(ev).toMatchObject({ type: 'refund', amount_cents: 40_000, status: 'done', source: 'system' })
    expect((res.json() as Canceled).invoice.refundPending).toBe(false)
  })

  it('is idempotent: a replay returns the stored answer, a second cancel is refused, and the ledger holds one refund', async () => {
    const a = await m.book('Maria Delgado', 'Express Hand Wash', MON)
    await recordPayment(m, a.invoiceId, 2500)
    const key = idemKey()
    const first = await cancel(a.appointmentId, { notify: true }, { key })
    const replay = await cancel(a.appointmentId, { notify: true }, { key })
    expect(replay.headers['idempotent-replayed']).toBe('true')
    expect(replay.json()).toEqual(first.json())
    const again = await cancel(a.appointmentId, { notify: true })
    expect(again.statusCode).toBe(409)
    expect((await ledgerOf(m, a.invoiceId)).filter((e) => e.type === 'refund')).toHaveLength(1)
    expect(
      (await outboundTexts(m, a.appointmentId)).filter((t) => t.includes('has been canceled')),
    ).toHaveLength(1)
  })

  it('reopening revives the invoice with a kept deposit; canceling again settles what is held, once', async () => {
    const a = await m.book('Maria Delgado', 'Express Hand Wash', MON)
    await recordPayment(m, a.invoiceId, 2500)
    const kept = (await cancel(a.appointmentId, { deposit: 'keep' })).json() as Canceled
    expect(kept.invoice.status).toBe('canceled_kept')
    const reopened = await m.send(m.superS(), 'POST', `/appointments/${a.appointmentId}/reopen`, {}, false)
    expect(reopened.statusCode, reopened.body).toBe(200)
    expect(await invoiceState(m, a.invoiceId)).toMatchObject({
      status: 'partially_paid',
      paid: 2500,
      refunded: 0,
    })
    expect((await invoiceState(m, a.invoiceId)).balance).toBeGreaterThan(0)
    const second = (await cancel(a.appointmentId)).json() as Canceled
    expect(second.settlement).toMatchObject({ heldCents: 2500, refundedCents: 2500, retainedCents: 0 })
    expect((await ledgerOf(m, a.invoiceId)).filter((e) => e.type === 'refund')).toHaveLength(1)
  })

  it('a job whose deposit was refunded cannot be reopened (a refund does not reopen the balance): book a new one', async () => {
    const a = await m.book('Maria Delgado', 'Express Hand Wash', MON)
    await recordPayment(m, a.invoiceId, 2500)
    await cancel(a.appointmentId)
    const res = await m.send(m.superS(), 'POST', `/appointments/${a.appointmentId}/reopen`, {}, false)
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({
      code: 'REOPEN_REFUNDED',
      title: 'Can’t reopen',
      detail: 'The deposit was refunded. Book a new appointment instead',
    })
    const row = await m.h.t.db
      .selectFrom('appointments')
      .select('status')
      .where('id', '=', a.appointmentId)
      .executeTakeFirstOrThrow()
    expect(row.status).toBe('canceled')
    expect((await invoiceState(m, a.invoiceId)).status).toBe('canceled_refunded')
  })

  it('reopening a job that held nothing makes its invoice unpaid again', async () => {
    const a = await m.book('Maria Delgado', 'Express Hand Wash', MON)
    await cancel(a.appointmentId)
    expect((await invoiceState(m, a.invoiceId)).status).toBe('canceled')
    expect(
      (await m.send(m.superS(), 'POST', `/appointments/${a.appointmentId}/reopen`, {}, false)).statusCode,
    ).toBe(200)
    expect(await invoiceState(m, a.invoiceId)).toMatchObject({ status: 'unpaid', paid: 0 })
  })

  it('a job with no money held settles to nothing and logs no deposit line', async () => {
    const a = await m.book('Maria Delgado', 'Express Hand Wash', MON)
    const b = (await cancel(a.appointmentId, { notify: true })).json() as Canceled
    expect(b.settlement).toMatchObject({ heldCents: 0, refundedCents: 0, retainedCents: 0, refunds: [] })
    expect(b.invoice.status).toBe('canceled')
    expect((await activityOf(m, a.appointmentId)).some((t) => t.startsWith('Deposit'))).toBe(false)
    expect((await outboundTexts(m, a.appointmentId)).at(-1)).not.toContain('deposit')
  })
})

describe('a manual choice at cancel overrides the policy', () => {
  const m = useRig()
  const cancel = (id: string, body: Record<string, unknown>, s = m.superS()) =>
    m.send(s, 'POST', `/appointments/${id}/cancel`, { reason: 'Customer called', ...body }, idemKey())

  it('keep holds the deposit even when the policy would refund it', async () => {
    const a = await m.book('Maria Delgado', 'Express Hand Wash', MON)
    await recordPayment(m, a.invoiceId, 2500)
    const b = (await cancel(a.appointmentId, { deposit: 'keep' })).json() as Canceled
    expect(b.depositPolicy).toBe('keep')
    expect(b.settlement).toMatchObject({ policy: 'keep', retainedCents: 2500, refundedCents: 0 })
    expect(b.settlement.rule).toBe('Deposit kept by staff')
    expect(b.invoice.status).toBe('canceled_kept')
  })

  it('refund_card refunds in full through the actor’s own refund right and limit: over it the request waits for approval', async () => {
    const desk = (
      await m.h.userWithPermissions(['sched.view', 'sched.cancel', 'pay.refund'], 'desk@example.test')
    ).session
    const small = await m.book('Maria Delgado', 'Express Hand Wash', SAT)
    await recordPayment(m, small.invoiceId, 2500)
    const ok = (await cancel(small.appointmentId, { deposit: 'refund_card' }, desk)).json() as Canceled
    expect(ok.settlement.refunds).toEqual([
      expect.objectContaining({ amountCents: 2500, state: 'done', dest: 'card' }),
    ])
    expect((await ledgerOf(m, small.invoiceId))[1]).toMatchObject({
      source: 'oasis',
      status: 'done',
      reason: 'Customer canceled',
    })

    const big = await m.book('Liam Chen', 'Express Hand Wash', SAT)
    await recordPayment(m, big.invoiceId, 9000)
    const pending = (await cancel(big.appointmentId, { deposit: 'refund_card' }, desk)).json() as Canceled
    expect(pending.settlement.refunds).toEqual([
      expect.objectContaining({ amountCents: 9000, state: 'pending' }),
    ])
    expect(pending.invoice.refundPending).toBe(true)
  })

  it('refund_card without pay.refund is refused and nothing is canceled', async () => {
    const clerk = (await m.h.userWithPermissions(['sched.view', 'sched.cancel'], 'clerk2@example.test'))
      .session
    const a = await m.book('Maria Delgado', 'Express Hand Wash', SAT)
    await recordPayment(m, a.invoiceId, 2500)
    const res = await cancel(a.appointmentId, { deposit: 'refund_card' }, clerk)
    expect(res.statusCode).toBe(403)
    expect((res.json() as { meta: { required: string[] } }).meta.required).toEqual(['pay.refund'])
    const row = await m.h.t.db
      .selectFrom('appointments')
      .select('status')
      .where('id', '=', a.appointmentId)
      .executeTakeFirstOrThrow()
    expect(row.status).toBe('booked')
  })

  it('refund_credit puts the whole deposit on store credit', async () => {
    const a = await m.book('Maria Delgado', 'Express Hand Wash', SAT)
    await recordPayment(m, a.invoiceId, 2500)
    const b = (await cancel(a.appointmentId, { deposit: 'refund_credit' })).json() as Canceled
    expect(b.settlement.refunds).toEqual([
      expect.objectContaining({ amountCents: 2500, dest: 'credit', state: 'done' }),
    ])
  })
})

describe('no-show executes the policy too', () => {
  const m = useRig()
  const noShow = (id: string) => m.send(m.superS(), 'POST', `/appointments/${id}/no-show`, {}, idemKey())

  it('keeps the deposit by default (canceled_kept), sends no text, and never auto-consumes a credit', async () => {
    const a = await m.book('Maria Delgado', 'Express Hand Wash', SAT)
    await recordPayment(m, a.invoiceId, 2500)
    m.h.clock.set('2026-06-13T14:11:00-04:00')
    const res = await noShow(a.appointmentId)
    expect(res.statusCode, res.body).toBe(200)
    const b = res.json() as Canceled
    expect(b.appointment.status).toBe('no_show')
    expect(b.settlement).toMatchObject({ heldCents: 2500, retainedCents: 2500, refundedCents: 0 })
    expect(b.settlement.rule).toBe('No-show · deposit kept')
    expect(b.invoice.status).toBe('canceled_kept')
    expect(await activityOf(m, a.appointmentId)).toEqual(
      expect.arrayContaining(['Marked no-show', 'Deposit kept · $25.00 (no-show policy)']),
    )
    expect(await outboundTexts(m, a.appointmentId)).toEqual([expect.stringContaining('thanks for booking')])
  })

  it('noShowRetainBp 0 refunds in full and 5000 refunds half', async () => {
    await setPolicy(m, { noShowRetainBp: 0 })
    const a = await m.book('Maria Delgado', 'Express Hand Wash', SAT)
    await recordPayment(m, a.invoiceId, 2500, { kind: 'cash' })
    m.h.clock.set('2026-06-13T14:11:00-04:00')
    const b = (await noShow(a.appointmentId)).json() as Canceled
    expect(b.settlement).toMatchObject({ refundedCents: 2500, retainedCents: 0 })
    expect(b.invoice.status).toBe('canceled_refunded')

    m.h.clock.set('2026-06-13T10:36:00-04:00')
    await setPolicy(m, { noShowRetainBp: 5000 })
    const c = await m.book('Liam Chen', 'Express Hand Wash', SAT)
    await recordPayment(m, c.invoiceId, 4000)
    m.h.clock.set('2026-06-13T14:11:00-04:00')
    const d = (await noShow(c.appointmentId)).json() as Canceled
    expect(d.settlement).toMatchObject({ heldCents: 4000, refundedCents: 2000, retainedCents: 2000 })
    expect(d.invoice.status).toBe('canceled_kept')
  })

  it('a replay of the same request is answered from the store and does not refund twice', async () => {
    await setPolicy(m, { noShowRetainBp: 0 })
    const a = await m.book('Maria Delgado', 'Express Hand Wash', SAT)
    await recordPayment(m, a.invoiceId, 2500)
    m.h.clock.set('2026-06-13T14:11:00-04:00')
    const key = idemKey()
    const first = await m.send(m.superS(), 'POST', `/appointments/${a.appointmentId}/no-show`, {}, key)
    const replay = await m.send(m.superS(), 'POST', `/appointments/${a.appointmentId}/no-show`, {}, key)
    expect(replay.headers['idempotent-replayed']).toBe('true')
    expect(replay.json()).toEqual(first.json())
    expect((await ledgerOf(m, a.invoiceId)).filter((e) => e.type === 'refund')).toHaveLength(1)
  })
})

describe('the policy setting', () => {
  const m = useRig()

  it('GET is open to any signed-in user, PUT needs set.hours and a current version, and values are validated', async () => {
    const got = (await m.get(m.limited(), '/settings/cancellation-policy')).json() as {
      policy: Record<string, unknown>
      version: number
    }
    expect(got.policy).toEqual({
      freeCancelHours: 24,
      lateRetainBp: 10_000,
      noShowRetainBp: 10_000,
      refundTo: 'original',
    })
    const body = { ...got.policy, version: got.version }
    expect((await m.send(m.limited(), 'PUT', '/settings/cancellation-policy', body, false)).statusCode).toBe(
      403,
    )
    const bad = await m.send(
      m.superS(),
      'PUT',
      '/settings/cancellation-policy',
      { ...body, lateRetainBp: 10_001 },
      false,
    )
    expect(bad.statusCode).toBe(422)
    const saved = await m.send(
      m.superS(),
      'PUT',
      '/settings/cancellation-policy',
      { ...body, freeCancelHours: 48 },
      false,
    )
    expect(saved.statusCode, saved.body).toBe(200)
    expect(saved.json()).toMatchObject({ policy: { freeCancelHours: 48 }, version: got.version + 1 })
    const stale = await m.send(
      m.superS(),
      'PUT',
      '/settings/cancellation-policy',
      { ...body, freeCancelHours: 12 },
      false,
    )
    expect(stale.statusCode).toBe(412)
    expect(
      (
        await m.h.t.db
          .selectFrom('audit_log')
          .select('action')
          .where('action', '=', 'settings.update')
          .execute()
      ).length,
    ).toBeGreaterThan(0)
  })
})
