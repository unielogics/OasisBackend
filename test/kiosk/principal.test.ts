// Who a request counts as (ADR 0180): a kiosk is its device for rate limits, idempotency keys, ledger and card request keys and the
// stream cap; a user stays their user id (keys stored before kiosk mode still replay). A missing user id never matches another.
import { describe, expect, it } from 'vitest'
import { keyOwnerOf, principalKey, type AuthContext, type KioskAuthContext } from '../../src/http/authorizer.js'
import { actorFromAuth, sameUser } from '../../src/modules/payments/actor.js'
import { approvalRights } from '../../src/modules/payments/detail.js'
import { KIOSK_PERMISSIONS } from '../../src/modules/rbac/catalog.js'

const user: AuthContext = {
  userId: '0190a000-0000-7000-8000-000000000001',
  employeeId: '0190a000-0000-7000-8000-0000000000e1',
  locationId: 'loc',
  permissions: new Set(['*']),
}

const kiosk = (deviceId: string): KioskAuthContext => ({
  kind: 'kiosk',
  userId: null,
  employeeId: '0190a000-0000-7000-8000-0000000000e2',
  locationId: 'loc',
  permissions: KIOSK_PERMISSIONS,
  limits: {},
  roles: ['Kiosk'],
  actorName: 'Marco R.',
  kiosk: { sessionId: 's', deviceId, deviceName: 'Front desk tablet', csrfSecret: 'x', locksAt: new Date(), acting: null },
})

describe('principal keys', () => {
  it('a kiosk is its device; a user is their user id', () => {
    expect(principalKey(kiosk('d1'))).toBe('kiosk:d1')
    expect(principalKey(user)).toBe(`user:${user.userId}`)
    expect(keyOwnerOf(kiosk('d1'))).toBe('kiosk:d1')
    expect(keyOwnerOf(kiosk('d2'))).not.toBe(keyOwnerOf(kiosk('d1')))
    expect(keyOwnerOf(user)).toBe(user.userId) // unchanged for stored keys
  })

  it('the payments actor of a kiosk has no user, the tapped employee and its own key space, and no money limits', () => {
    const a = actorFromAuth(kiosk('d1'))
    expect(a).toMatchObject({ userId: null, employeeId: '0190a000-0000-7000-8000-0000000000e2', keyOwner: 'kiosk:d1' })
    expect(a.has('pay.collect')).toBe(true)
    expect(a.has('pay.refund')).toBe(false)
    expect(a.limit('refund')).toBe(0)
    expect(actorFromAuth(user).keyOwner).toBe(user.userId)
  })
})

describe('self-approval never matches two missing user ids', () => {
  it('sameUser', () => {
    expect(sameUser(null, null)).toBe(false)
    expect(sameUser(undefined, null)).toBe(false)
    expect(sameUser('a', 'a')).toBe(true)
    expect(sameUser('a', 'b')).toBe(false)
  })

  it('a refund requested without a user (a kiosk, an import) is not "your own" for an approver without one', () => {
    const limited = {
      ...actorFromAuth({ ...user, userId: null, permissions: new Set(['pay.refund']), limits: { refund: 10_000 } }),
    }
    const e = { type: 'refund' as const, status: 'pending' as const, amount_cents: 500, actor_user_id: null }
    expect(approvalRights(limited, e, { allowSelf: false })).toEqual({ canApprove: true, block: null })
    const mine = actorFromAuth({ ...user, permissions: new Set(['pay.refund']), limits: { refund: 10_000 } })
    expect(approvalRights(mine, { ...e, actor_user_id: user.userId }, { allowSelf: false }).block).toBe('self')
  })
})
