// What a member billed by Square is told (ADR 0171 wave Q3b), always in the caller's transaction through the messaging queue (the one
// SMS policy gate: consent, opt-out, quiet hours, the allowlist) and the email outbox:
//   - a renewal Square could not charge (day 0): a text with their own card page (a personal link, kind card, texted as a secret) and
//     Square's page for the invoice; an email with Square's page (personal links go by text only);
//   - a first payment that failed: the membership did not start; a text with a new membership page to try another card;
//   - "Move members": the price-change notice, by text and email, with the date it takes effect.
// Each message carries a dedupe key, so a job that runs again never sends it twice.
import type { Env } from '../../../config/env.js'
import type { Clock } from '../../../platform/clock.js'
import type { Tx } from '../../../platform/db.js'
import type { NewId } from '../../../platform/ids.js'
import { formatUsd } from '../../../platform/money.js'
import { issueClientLink } from '../../identity/links.js'
import { messagingConfig } from '../../messaging/config.js'
import { loadCustomerTarget } from '../../messaging/db/recipients.js'
import { queueEmail } from '../../messaging/email/service.js'
import { DbMessageQueue } from '../../messaging/queue.js'

export interface NoticeDeps {
  clock: Clock
  newId: NewId
  env: Env
  locationId: string
}

export type TextOutcome = 'queued' | 'skipped' | 'no_client'

async function text(
  tx: Tx,
  d: NoticeDeps,
  customerId: string,
  m: { templateKey: string; vars: Record<string, string>; secretVars?: Record<string, string>; dedupeKey: string; purpose: string },
): Promise<TextOutcome> {
  const target = await loadCustomerTarget(tx, d.locationId, customerId)
  if (!target) return 'no_client'
  const queue = new DbMessageQueue({ clock: d.clock, newId: d.newId, config: messagingConfig(d.env) })
  const out = await queue.enqueueFor(tx, {
    locationId: d.locationId,
    customerId,
    recipient: target.recipient,
    appointmentId: null,
    templateKey: m.templateKey,
    vars: { first: target.firstName, ...m.vars },
    ...(m.secretVars ? { secretVars: m.secretVars } : {}),
    purpose: m.purpose,
    senderKind: 'system',
    dedupeKey: m.dedupeKey,
  })
  return out.queued ? 'queued' : 'skipped'
}

async function email(
  tx: Tx,
  d: NoticeDeps,
  customerId: string,
  to: string | null,
  m: { template: string; vars: Record<string, string | number>; dedupeKey: string; purpose: string },
): Promise<boolean> {
  const target = await loadCustomerTarget(tx, d.locationId, customerId)
  const address = to ?? target?.email ?? null
  if (!address || (target?.emailBounced && address === target.email)) return false
  await queueEmail(
    tx,
    {
      locationId: d.locationId,
      to: address,
      template: m.template,
      vars: { ...(target ? { customerName: target.firstName } : {}), ...(d.env.BUSINESS_PHONE ? { shopPhone: d.env.BUSINESS_PHONE } : {}), ...m.vars },
      purpose: m.purpose,
      customerId,
      dedupeKey: m.dedupeKey,
    },
    { newId: d.newId, clock: d.clock },
  )
  return true
}

const siteOf = (env: Env) => (env.PUBLIC_SITE_URL ? { siteUrl: env.PUBLIC_SITE_URL } : {})

/** Day 0 of a failed renewal: the card page by text (with Square's invoice page), Square's invoice page by email. */
export async function sendPaymentFailed(
  tx: Tx,
  d: NoticeDeps,
  m: { membershipId: string; customerId: string; tierName: string; amountCents: number; payUrl: string | null; email: string | null; graceDays: number; failureKey: string },
): Promise<{ text: TextOutcome; email: boolean }> {
  let sms: TextOutcome = 'no_client'
  try {
    const link = await issueClientLink(tx, { newId: d.newId, now: d.clock.now(), ...siteOf(d.env) }, { locationId: d.locationId, kind: 'card', customerId: m.customerId, issuedBy: 'system' })
    sms = await text(tx, d, m.customerId, {
      templateKey: 'membership_payment_failed',
      vars: { tier: m.tierName, ...(m.payUrl ? { pay_url: m.payUrl } : {}) },
      secretVars: { link: link.url },
      dedupeKey: `membership_payment_failed:${m.failureKey}`,
      purpose: 'membership',
    })
  } catch (e) {
    // a client without a textable number gets the email alone (IDENTITY_NO_PHONE)
    if (!(e instanceof Error && 'code' in e && (e as { code?: string }).code === 'IDENTITY_NO_PHONE')) throw e
  }
  const mailed = await email(tx, d, m.customerId, m.email, {
    template: 'membership_payment_failed',
    vars: { tierName: m.tierName, amountCents: m.amountCents, graceDays: m.graceDays, ...(m.payUrl ? { payUrl: m.payUrl } : {}) },
    dedupeKey: `membership_payment_failed:${m.failureKey}`,
    purpose: 'membership',
  })
  return { text: sms, email: mailed }
}

/** The first payment failed: a new membership page for the same tier, to try another card. */
export async function sendJoinRetry(tx: Tx, d: NoticeDeps, m: { customerId: string; planKey: string; tierName: string; enrollmentId: string }): Promise<TextOutcome> {
  try {
    const link = await issueClientLink(tx, { newId: d.newId, now: d.clock.now(), ...siteOf(d.env) }, {
      locationId: d.locationId,
      kind: 'membership',
      customerId: m.customerId,
      planKey: m.planKey,
      issuedBy: 'system',
    })
    return await text(tx, d, m.customerId, {
      templateKey: 'membership_join_retry',
      vars: { tier: m.tierName },
      secretVars: { link: link.url },
      dedupeKey: `membership_join_retry:${m.enrollmentId}`,
      purpose: 'membership',
    })
  } catch (e) {
    if (e instanceof Error && 'code' in e && (e as { code?: string }).code === 'IDENTITY_NO_PHONE') return 'no_client'
    throw e
  }
}

/** "Move members": the price-change notice by text and email. */
export async function sendPriceChange(
  tx: Tx,
  d: NoticeDeps,
  m: { membershipId: string; customerId: string; tierName: string; fromCents: number; toCents: number; dateLabel: string; email: string | null; moveKey: string },
): Promise<{ text: TextOutcome; email: boolean }> {
  const sms = await text(tx, d, m.customerId, {
    templateKey: 'membership_price_change',
    vars: { tier: m.tierName, price: formatUsd(m.toCents).replace(/\.00$/, ''), date: m.dateLabel },
    dedupeKey: `membership_price_change:${m.moveKey}`,
    purpose: 'membership',
  })
  const mailed = await email(tx, d, m.customerId, m.email, {
    template: 'membership_price_change',
    vars: { tierName: m.tierName, fromCents: m.fromCents, toCents: m.toCents, dateLabel: m.dateLabel },
    dedupeKey: `membership_price_change:${m.moveKey}`,
    purpose: 'membership',
  })
  return { text: sms, email: mailed }
}
