import type { Executor } from '../../../platform/db.js'
import type { ConsentSource, SmsRecipient } from '../policy/canSend.js'
import '../schema.js'
import '../../customers/schema.js'

const CONSENT: Record<string, ConsentSource> = {
  online: 'web_form',
  squarespace: 'web_form',
  dashboard: 'staff_attested',
  walk_in: 'staff_attested',
  inbound_sms: 'inbound_reply',
  keyword: 'inbound_reply',
  import: 'import',
}

export interface CustomerTarget {
  customerId: string
  name: string
  firstName: string
  email: string | null
  emailBounced: boolean
  recipient: SmsRecipient
}

/** True when sms_opt_outs holds an active STOP (or a staff opt-out) for the number. */
export async function hasActiveOptOut(db: Executor, locationId: string, phone: string): Promise<boolean> {
  const r = await db
    .selectFrom('sms_opt_outs')
    .select('id')
    .where('location_id', '=', locationId)
    .where('phone_e164', '=', phone)
    .where('opted_in_again_at', 'is', null)
    .limit(1)
    .executeTakeFirst()
  return r !== undefined
}

/** The customer as the SMS policy sees them: consent flags, the active opt-out by number, the synthetic marker. */
export async function loadCustomerTarget(db: Executor, locationId: string, customerId: string): Promise<CustomerTarget | null> {
  const c = await db
    .selectFrom('customers')
    .select(['id', 'full_name', 'phone_e164', 'email', 'email_bounced_at', 'sms_opted_in', 'sms_opt_in_source', 'sms_opted_out_at', 'synthetic'])
    .where('id', '=', customerId)
    .executeTakeFirst()
  if (!c) return null
  const optedOut = c.sms_opted_out_at !== null || (c.phone_e164 !== null && (await hasActiveOptOut(db, locationId, c.phone_e164)))
  return {
    customerId: c.id,
    name: c.full_name,
    firstName: c.full_name.trim().split(/\s+/)[0] ?? c.full_name,
    email: c.email,
    emailBounced: c.email_bounced_at !== null,
    recipient: {
      kind: 'customer',
      id: c.id,
      phone: c.phone_e164,
      smsOptIn: c.sms_opted_in,
      activeOptOut: optedOut,
      synthetic: c.synthetic,
      consentSource: c.sms_opt_in_source ? (CONSENT[c.sms_opt_in_source] ?? 'unknown') : null,
    },
  }
}

/** A bare number with no customer row (a stranger who texted STOP or HELP): consent-exempt replies only. */
export async function strangerRecipient(db: Executor, locationId: string, phone: string): Promise<SmsRecipient> {
  return {
    kind: 'customer',
    phone,
    smsOptIn: false,
    activeOptOut: await hasActiveOptOut(db, locationId, phone),
    synthetic: false,
    consentSource: null,
  }
}
