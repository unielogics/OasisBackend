// Gap 3c: the appointment file tells the Membership tab whether a client without a membership is worth an offer, from their real
// completed visits (3 or more in the last 60 days), never from a fixed number.
import { describe, expect, it } from 'vitest'
import { completedVisit, useRig, type Rig } from '../scheduling-gaps/support.js'

interface FileReply {
  membership: { plan: string } | null
  membershipUpgrade: { candidate: boolean; visits60: number; copy: string | null } | null
}

const fileOf = async (m: Rig, appointmentId: string): Promise<FileReply> =>
  (await m.get(m.superS(), `/appointments/${appointmentId}`)).json() as FileReply

describe('upgrade candidacy in the appointment file', () => {
  const m = useRig()

  it('counts real completed visits in the last 60 days: 3 is a candidate, with the real number in the copy', async () => {
    const customerId = await m.customer('Maria Delgado')
    for (const days of [3, 20, 55]) await completedVisit(m, customerId, days)
    const a = await m.book('Maria Delgado', 'Express Hand Wash')
    const file = await fileOf(m, a.appointmentId)
    expect(file.membership).toBeNull()
    expect(file.membershipUpgrade).toEqual({
      candidate: true,
      visits60: 3,
      copy: 'Maria Delgado is a strong upgrade candidate — 3 visits in 60 days. Offer Essential at check-out.',
    })
  })

  it('two visits is not a candidate; older visits, canceled and no-show jobs do not count', async () => {
    const customerId = await m.customer('Liam Chen')
    for (const days of [4, 30]) await completedVisit(m, customerId, days)
    for (const days of [61, 90, 200]) await completedVisit(m, customerId, days)
    await completedVisit(m, customerId, 10, 'canceled')
    await completedVisit(m, customerId, 12, 'no_show')
    const a = await m.book('Liam Chen', 'Express Hand Wash')
    expect((await fileOf(m, a.appointmentId)).membershipUpgrade).toEqual({
      candidate: false,
      visits60: 2,
      copy: null,
    })
  })

  it('four visits say four; a client with no history says zero', async () => {
    const customerId = await m.customer('Maria Delgado')
    for (const days of [1, 2, 3, 4]) await completedVisit(m, customerId, days)
    const a = await m.book('Maria Delgado', 'Express Hand Wash')
    expect((await fileOf(m, a.appointmentId)).membershipUpgrade).toMatchObject({
      candidate: true,
      visits60: 4,
    })
    const b = await m.book('Liam Chen', 'Express Hand Wash', '2026-06-13T15:00:00-04:00')
    expect((await fileOf(m, b.appointmentId)).membershipUpgrade).toEqual({
      candidate: false,
      visits60: 0,
      copy: null,
    })
  })

  it('a member has the membership block and no upgrade card; a canceled membership shows the card again', async () => {
    const customerId = await m.customer('Maria Delgado')
    for (const days of [1, 2, 3]) await completedVisit(m, customerId, days)
    const mem = await m.member('Maria Delgado', 'essential')
    const a = await m.book('Maria Delgado', 'Express Hand Wash')
    const member = await fileOf(m, a.appointmentId)
    expect(member.membership).toMatchObject({ plan: 'Essential' })
    expect(member.membershipUpgrade).toBeNull()
    const patch = await m.send(m.superS(), 'PATCH', `/memberships/${mem.id}`, { status: 'canceled' }, false)
    expect(patch.statusCode, patch.body).toBe(200)
    const gone = await fileOf(m, a.appointmentId)
    expect(gone.membership).toBeNull()
    expect(gone.membershipUpgrade).toMatchObject({ candidate: true, visits60: 3 })
  })
})
