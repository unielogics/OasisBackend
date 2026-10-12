// Staff routes of the identity core (ADR 0160, design sections 5 and 8): a client's phone identity, masked (cli.view: the client
// file's Overview), and three actions with cli.edit: Clear PIN (the client verifies by texted code again; every link, session and the
// trust end), Revoke trust (the number must verify again on a link page before the AI acts for it; live sessions end too) and
// Confirm the number (a staff action ends the stale-record rule, W4c fixes); and the links' kill switch (owner level: the links
// epoch). All audited. Nothing here sends a text or exposes a token, hash or code.
import { access } from '../../../http/access.js'
import { auditContextOf } from '../../../http/authorizer.js'
import type { AppInstance } from '../../../http/types.js'
import { z } from '../../../http/zod.js'
import * as audit from '../../../platform/audit.js'
import { transaction } from '../../../platform/db.js'
import { AppError } from '../../../platform/errors.js'
import { clearCustomerPin } from '../pin-service.js'
import { revokeSessions } from '../sessions.js'
import { identityStateOf, type IdentityState } from '../staff-view.js'
import { killAllLinks } from '../kill.js'
import { cancelPendingActions } from '../pending-actions.js'
import { confirmClientIdentity } from '../rebind.js'
import { storedUserId } from '../../settings/http/runtime.js'
import { revokeTrust } from '../trust.js'

const TAGS = ['customers']
const IdParams = z.object({ id: z.string().uuid() })
const iso = z.string().nullable()

const IdentityStateDto = z.object({
  customerId: z.string(),
  phone: z.string().nullable().describe('The client’s number masked to its last four digits'),
  pin: z.object({
    status: z.enum(['none', 'set', 'locked', 'disabled', 'cleared']),
    setAt: iso,
    lockedUntil: iso,
    resetHoldUntil: iso.describe('After a reset by texted code, membership changes and payments through links wait until then'),
  }),
  trust: z.object({
    trusted: z.boolean(),
    until: iso,
    verifiedAt: iso,
    verifiedBy: z.enum(['pin', 'code']).nullable(),
    reason: z.enum(['none', 'expired', 'revoked', 'epoch', 'owner_changed', 'opted_out', 'stale']).nullable(),
    revokeReason: z.string().nullable(),
  }),
  links: z.object({
    live: z.number().int(),
    byKind: z.record(z.string(), z.number().int()),
    lastIssuedAt: iso,
  }),
  sessions: z.object({ live: z.number().int() }),
  pendingAction: z.object({ kind: z.enum(['book', 'reschedule', 'cancel']), expiresAt: z.string() }).nullable(),
  stale: z
    .object({ stale: z.boolean(), reason: z.enum(['inactive', 'invalid_number']).nullable(), lastActivityAt: z.string() })
    .nullable()
    .describe('The stale-record rule: no activity for 180 days, or the last text bounced as an invalid number'),
  numberReassigned: z
    .object({ at: z.string(), toCustomerId: z.string().nullable() })
    .nullable()
    .describe('Someone who verified only this number (a texted code) while the record was stale booked as a new client, so the number moved to that client: merge the two if it is the same person'),
})

const d = (x: Date | null): string | null => (x ? x.toISOString() : null)

export function identityDto(s: IdentityState): z.infer<typeof IdentityStateDto> {
  return {
    customerId: s.customerId,
    phone: s.phone,
    pin: { status: s.pin.status, setAt: d(s.pin.setAt), lockedUntil: d(s.pin.lockedUntil), resetHoldUntil: d(s.pin.resetHoldUntil) },
    trust: {
      trusted: s.trust.trusted,
      until: d(s.trust.until),
      verifiedAt: d(s.trust.verifiedAt),
      verifiedBy: s.trust.verifiedBy,
      reason: s.trust.reason,
      revokeReason: s.trust.revokeReason,
    },
    links: { live: s.links.live, byKind: s.links.byKind as Record<string, number>, lastIssuedAt: d(s.links.lastIssuedAt) },
    sessions: s.sessions,
    pendingAction: s.pendingAction ? { kind: s.pendingAction.kind, expiresAt: s.pendingAction.expiresAt.toISOString() } : null,
    stale: s.stale ? { stale: s.stale.stale, reason: s.stale.reason, lastActivityAt: s.stale.lastActivityAt.toISOString() } : null,
    numberReassigned: s.numberReassigned ? { at: s.numberReassigned.at.toISOString(), toCustomerId: s.numberReassigned.toCustomerId } : null,
  }
}

export function registerIdentityStaffRoutes(app: AppInstance): void {
  app.get(
    '/customers/:id/identity',
    {
      config: { access: access.perm('cli.view') },
      schema: {
        tags: TAGS,
        summary: 'A client’s phone identity: website PIN, 30-day trust, live links (masked)',
        description:
          'What the client file shows ("Website PIN: Set · trusted to Nov 9"): the PIN status (none, set, locked, disabled after too many wrong tries, cleared), the number’s trust and why it ended, how many personal links and link sessions are live, a pending in-chat action and the stale-record verdict. The number is masked; no token, hash or code is returned.',
        params: IdParams,
        response: { 200: IdentityStateDto },
      },
    },
    async (req) => {
      const s = await identityStateOf(app.db, { locationId: req.auth!.locationId, customerId: req.params.id, now: app.clock.now() })
      if (!s) throw new AppError('NOT_FOUND')
      return identityDto(s)
    },
  )

  app.post(
    '/customers/:id/identity/pin/clear',
    {
      config: { access: access.perm('cli.edit') },
      schema: {
        tags: TAGS,
        summary: 'Clear the client’s website PIN',
        description:
          'The PIN is removed (its version moves on, so every link issued before is dead), every live link and link session of the client ends, the number’s 30-day trust and a pending in-chat action end. The client verifies with a texted code next time and may create a new PIN. Clearing when no PIN is set changes nothing. Audited as identity.pin.cleared.',
        params: IdParams,
        response: { 200: IdentityStateDto },
      },
    },
    async (req) =>
      transaction(app.db, async (tx) => {
        const locationId = req.auth!.locationId
        const now = app.clock.now()
        if (!(await identityStateOf(tx, { locationId, customerId: req.params.id, now }))) throw new AppError('NOT_FOUND')
        await clearCustomerPin(tx, { locationId, customerId: req.params.id, now, audit: auditContextOf(req) })
        return identityDto((await identityStateOf(tx, { locationId, customerId: req.params.id, now }))!)
      }),
  )

  app.post(
    '/customers/:id/identity/trust/revoke',
    {
      config: { access: access.perm('cli.edit') },
      schema: {
        tags: TAGS,
        summary: 'Revoke the trust of the client’s number',
        description:
          'Ends the number’s 30-day trust (the AI asks the client to verify on a link page before it books, reschedules or cancels again), the client’s live link sessions and a pending in-chat action. Links stay usable to verify again. Audited as identity.trust.revoked.',
        params: IdParams,
        response: { 200: IdentityStateDto },
      },
    },
    async (req) =>
      transaction(app.db, async (tx) => {
        const locationId = req.auth!.locationId
        const now = app.clock.now()
        const before = await identityStateOf(tx, { locationId, customerId: req.params.id, now })
        if (!before) throw new AppError('NOT_FOUND')
        const trust = await revokeTrust(tx, { locationId, customerId: req.params.id, reason: 'staff', now })
        const sessions = await revokeSessions(tx, { customerId: req.params.id, now })
        const actions = await cancelPendingActions(tx, { locationId, customerId: req.params.id, now, error: 'trust revoked by staff' })
        await audit.record(tx, {
          locationId,
          action: 'identity.trust.revoked',
          entityType: 'customer',
          entityId: req.params.id,
          before: { trusted: before.trust.trusted, until: d(before.trust.until) },
          after: { trusted: false, revoked: { trust, sessions, pendingActions: actions } },
          ctx: auditContextOf(req),
        })
        return identityDto((await identityStateOf(tx, { locationId, customerId: req.params.id, now }))!)
      }),
  )

  app.post(
    '/customers/:id/identity/confirm',
    {
      config: { access: access.perm('cli.edit') },
      schema: {
        tags: TAGS,
        summary: 'Confirm the number still belongs to this client',
        description:
          'Staff confirmed with the client (in person or on the phone) that the number on file is still theirs: a staff action is proof of the client, so the stale-record rule (180 days without proof, or a bounce as an invalid number) no longer holds the record and the assistant and the link pages know the client again. A texted code never does this (it proves only the number). 422 `IDENTITY_NO_PHONE` for a client without a number. Audited as identity.client.confirmed.',
        params: IdParams,
        response: { 200: IdentityStateDto },
      },
    },
    async (req) =>
      transaction(app.db, async (tx) => {
        const locationId = req.auth!.locationId
        const now = app.clock.now()
        const before = await identityStateOf(tx, { locationId, customerId: req.params.id, now })
        if (!before) throw new AppError('NOT_FOUND')
        if (!before.phone) throw new AppError('IDENTITY_NO_PHONE')
        await confirmClientIdentity(tx, { customerId: req.params.id, now })
        await audit.record(tx, {
          locationId,
          action: 'identity.client.confirmed',
          entityType: 'customer',
          entityId: req.params.id,
          before: { stale: before.stale?.stale ?? null },
          after: { stale: false },
          ctx: auditContextOf(req),
        })
        return identityDto((await identityStateOf(tx, { locationId, customerId: req.params.id, now }))!)
      }),
  )

  app.post(
    '/identity/links/kill',
    {
      config: { access: access.perm('set.billing', 'team.roles') },
      schema: {
        tags: TAGS,
        summary: 'Kill switch: end every personal link, link session and phone trust now',
        description:
          'Bumps the links epoch (setting `links.epoch`): every personal link, every page opened from one and every 30-day phone trust issued before end at their next use, and a reply number in chat stops running (the trust it needs is gone). Clients verify again on a new link. Needs both owner-level permissions (Billing & integrations and Roles: a Super Admin). `reason` is kept in the audit log (identity.links.killed, beside settings.update). The break-glass CLI deploy/scripts/links-kill.sh does the same; PUBLIC_LINKS_ENABLED=false closes the link routes (docs/runbook.md "Personal links").',
        body: z.object({ reason: z.string().trim().min(3).max(300) }).strict(),
        response: { 200: z.object({ epoch: z.number().int(), epochBefore: z.number().int() }) },
      },
    },
    async (req) =>
      transaction(app.db, async (tx) =>
        killAllLinks(tx, {
          locationId: req.auth!.locationId,
          reason: req.body.reason,
          updatedBy: await storedUserId(tx, req.auth!.userId),
          audit: auditContextOf(req),
        }),
      ),
  )
}
