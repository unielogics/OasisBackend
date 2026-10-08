// SEC-15: the invoice a booking creates (and the one a reopen brings back) is audited with the person and the request that did
// it, like every other money row: actor, request id, idempotency key and address.
import { describe, expect, it } from 'vitest'
import { idemKey, useRig } from '../scheduling-gaps/support.js'

describe('SEC-15 invoice audit rows carry the actor and the request', () => {
  const m = useRig()

  const auditOf = (action: string, entityId: string) =>
    m.h.t.db
      .selectFrom('audit_log')
      .select(['actor_user_id', 'actor_employee_id', 'actor_name', 'request_id', 'idempotency_key', 'ip'])
      .where('action', '=', action)
      .where('entity_id', '=', entityId)
      .execute()

  it('payments.invoice_created and payments.invoice_reopened name who booked and which request', async () => {
    const amara = await m.h.t.db
      .selectFrom('users as u')
      .innerJoin('employees as e', 'e.id', 'u.employee_id')
      .select(['u.id as userId', 'e.id as employeeId'])
      .where('u.email', '=', 'amara@example.test')
      .executeTakeFirstOrThrow()
    const svc = await m.h.t.db
      .selectFrom('services')
      .select('id')
      .where('name', '=', 'Express Hand Wash')
      .executeTakeFirstOrThrow()
    const key = idemKey()
    const res = await m.h.call('POST', '/api/v1/appointments', {
      session: m.superS(),
      body: { customer: { id: await m.customer('Liam Chen') }, serviceId: svc.id, start: '2026-06-13T15:00:00-04:00' },
      headers: { 'idempotency-key': key, 'x-request-id': 'req-sec15-book-0001' },
      ip: '10.77.0.1',
    })
    expect(res.statusCode, res.body).toBe(201)
    const appointmentId = (res.json() as { appointment: { id: string } }).appointment.id
    const invoice = await m.h.t.db
      .selectFrom('invoices')
      .select('id')
      .where('appointment_id', '=', appointmentId)
      .executeTakeFirstOrThrow()

    expect(await auditOf('payments.invoice_created', invoice.id)).toEqual([
      {
        actor_user_id: amara.userId,
        actor_employee_id: amara.employeeId,
        actor_name: expect.stringMatching(/\S/),
        request_id: 'req-sec15-book-0001',
        idempotency_key: key,
        ip: '10.77.0.1',
      },
    ])

    const cancel = await m.h.call('POST', `/api/v1/appointments/${appointmentId}/cancel`, {
      session: m.superS(),
      body: { reason: 'Customer called' },
      headers: { 'idempotency-key': idemKey() },
      ip: '10.77.0.2',
    })
    expect(cancel.statusCode, cancel.body).toBe(200)
    const reopen = await m.h.call('POST', `/api/v1/appointments/${appointmentId}/reopen`, {
      session: m.superS(),
      body: {},
      headers: { 'idempotency-key': idemKey(), 'x-request-id': 'req-sec15-reopen-01' },
      ip: '10.77.0.3',
    })
    expect(reopen.statusCode, reopen.body).toBe(200)
    expect(await auditOf('payments.invoice_reopened', invoice.id)).toMatchObject([
      { actor_user_id: amara.userId, request_id: 'req-sec15-reopen-01', ip: '10.77.0.3' },
    ])
  })
})
