// Leads (ADR 0160, design section 1 "Leads", plan J): one light record per number that asked about something and has not booked
// (strangers the assistant answered, website visitors, walk-ins), with the categories they asked about. The single automatic follow-up
// (follow-up.ts) is planned at follow_up_at = their last text + leads.follow_up_delay_min and sent at most once per lead. A booking
// closes the lead as booked: explicitly (markBooked: the reply-number handler, a personal-link booking) and, for any other booking
// (staff, website), by the reconciliation the follow-up job runs before it sends anything.
import { sql } from 'kysely'
import type { Executor, Tx } from '../../platform/db.js'
import type { NewId } from '../../platform/ids.js'
import { getSetting } from '../../platform/settings.js'
import type { LeadSource, LeadStatus } from './schema.js'
import './schema.js'
import '../customers/schema.js'

export const MAX_INTERESTS = 10
const E164 = /^\+[1-9][0-9]{6,14}$/
const MIN = 60_000

export interface OpenLeadInput {
  locationId: string
  phone: string
  customerId: string | null
  source: LeadSource
  at: Date
}

/** The minutes after their last text the follow-up is planned for (setting leads.follow_up_delay_min). */
export async function followUpDelayMs(db: Executor, locationId: string): Promise<number> {
  return (await getSetting(db, locationId, 'leads.follow_up_delay_min')).value * MIN
}

/**
 * Opens the number's lead, or touches it: the client is filled in when known, last_contact_at moves forward, a lead closed without a
 * booking opens again (a booked one stays booked) and the follow-up is planned again from the new last contact while none was sent.
 * Idempotent per (location, phone).
 */
export async function openLead(tx: Tx, newId: NewId, o: OpenLeadInput): Promise<{ leadId: string; created: boolean }> {
  if (!E164.test(o.phone)) throw new Error('leads: the phone must be E.164')
  const delay = await followUpDelayMs(tx, o.locationId)
  const followUpAt = new Date(o.at.getTime() + delay)
  const r = await sql<{ id: string; created: boolean }>`
    insert into leads (id, location_id, phone_e164, customer_id, source, first_contact_at, last_contact_at, follow_up_at, updated_at)
    values (${newId()}, ${o.locationId}, ${o.phone}, ${o.customerId}, ${o.source}, ${o.at}, ${o.at}, ${followUpAt}, ${o.at})
    on conflict (location_id, phone_e164) do update set
      customer_id = coalesce(excluded.customer_id, leads.customer_id),
      last_contact_at = greatest(leads.last_contact_at, excluded.last_contact_at),
      status = case when leads.status = 'closed' then 'new' else leads.status end,
      closed_at = case when leads.status = 'closed' then null else leads.closed_at end,
      follow_up_at = case
        when leads.status in ('new', 'closed') and leads.follow_up_message_id is null
          then greatest(leads.last_contact_at, excluded.last_contact_at) + ${`${delay} milliseconds`}::interval
        else leads.follow_up_at end,
      version = leads.version + 1,
      updated_at = excluded.updated_at
    returning id, (xmax = 0) as created`.execute(tx)
  const row = r.rows[0]!
  return { leadId: row.id, created: row.created }
}

/** Adds interest categories (kept in first-seen order, at most MAX_INTERESTS) and moves last_contact_at. No lead: nothing. */
export async function noteLeadInterest(tx: Tx, o: { locationId: string; phone: string; categories: readonly string[]; at: Date }): Promise<string[] | null> {
  const lead = await tx
    .selectFrom('leads')
    .select(['id', 'interests', 'status', 'follow_up_message_id', 'last_contact_at'])
    .where('location_id', '=', o.locationId)
    .where('phone_e164', '=', o.phone)
    .forUpdate()
    .executeTakeFirst()
  if (!lead) return null
  const merged = [...new Set([...lead.interests, ...o.categories])].slice(0, MAX_INTERESTS)
  const last = lead.last_contact_at.getTime() >= o.at.getTime() ? lead.last_contact_at : o.at
  const replan = lead.status === 'new' && lead.follow_up_message_id === null
  const delay = replan ? await followUpDelayMs(tx, o.locationId) : 0
  await tx
    .updateTable('leads')
    .set((eb) => ({
      interests: merged,
      last_contact_at: last,
      ...(replan ? { follow_up_at: new Date(last.getTime() + delay) } : {}),
      version: eb('version', '+', 1),
      updated_at: o.at,
    }))
    .where('id', '=', lead.id)
    .execute()
  return merged
}

/** A booking closes the number's open lead as booked (status booked, the appointment linked, no follow-up any more). */
export async function markLeadBooked(tx: Tx, o: { locationId: string; phone: string; appointmentId: string; at: Date }): Promise<boolean> {
  const r = await tx
    .updateTable('leads')
    .set((eb) => ({
      status: 'booked' as const,
      closed_at: o.at,
      booked_appointment_id: o.appointmentId,
      follow_up_at: null,
      version: eb('version', '+', 1),
      updated_at: o.at,
    }))
    .where('location_id', '=', o.locationId)
    .where('phone_e164', '=', o.phone)
    .where('status', 'in', ['new', 'followed_up'])
    .executeTakeFirst()
  return Number(r.numUpdatedRows) > 0
}

/** Closes the open lead of a number without a booking (the provisional client was archived). */
export async function closeLead(tx: Tx, o: { locationId: string; phone: string; at: Date }): Promise<boolean> {
  const r = await tx
    .updateTable('leads')
    .set((eb) => ({ status: 'closed' as const, closed_at: o.at, follow_up_at: null, version: eb('version', '+', 1), updated_at: o.at }))
    .where('location_id', '=', o.locationId)
    .where('phone_e164', '=', o.phone)
    .where('status', 'in', ['new', 'followed_up'])
    .executeTakeFirst()
  return Number(r.numUpdatedRows) > 0
}

/**
 * Closes as booked every open lead whose client (the lead's, else the number's current owner) has a booking made since the lead's
 * first contact that was not canceled: staff and website bookings close leads too, without a hook in the booking code.
 */
export async function reconcileBookedLeads(db: Executor, locationId: string, now: Date): Promise<number> {
  const r = await sql<{ id: string }>`
    with open as (
      select l.id, l.first_contact_at,
        coalesce(l.customer_id, (select c.id from customers c where c.phone_e164 = l.phone_e164 and c.merged_into is null
          and c.deleted_at is null limit 1)) as customer_id
      from leads l where l.location_id = ${locationId} and l.status in ('new', 'followed_up')
    ), hit as (
      select o.id, (select a.id from appointments a where a.customer_id = o.customer_id and a.location_id = ${locationId}
          and a.created_at >= o.first_contact_at and a.status not in ('canceled', 'no_show')
          order by a.created_at desc, a.id desc limit 1) as appointment_id
      from open o where o.customer_id is not null
    )
    update leads l set status = 'booked', closed_at = ${now}, booked_appointment_id = hit.appointment_id, follow_up_at = null,
      version = l.version + 1, updated_at = ${now}
    from hit where hit.id = l.id and hit.appointment_id is not null
    returning l.id`.execute(db)
  return r.rows.length
}

export type LeadListFilter = 'open' | 'all' | LeadStatus

export interface LeadRow {
  id: string
  phone: string
  customerId: string | null
  customerName: string | null
  /** The client's record is still the welcome flow's placeholder (no name given yet). */
  customerNeedsDetails: boolean
  source: LeadSource
  interests: string[]
  status: LeadStatus
  firstContactAt: Date
  lastContactAt: Date
  followUpAt: Date | null
  followUpMessageId: string | null
  followedUpAt: Date | null
  bookedAppointmentId: string | null
  closedAt: Date | null
}

/** The staff list: newest contact first. */
export async function listLeads(db: Executor, o: { locationId: string; status: LeadListFilter; limit: number }): Promise<LeadRow[]> {
  const rows = await db
    .selectFrom('leads as l')
    .leftJoin('customers as c', 'c.id', 'l.customer_id')
    .leftJoin('messages as m', 'm.id', 'l.follow_up_message_id')
    .select([
      'l.id',
      'l.phone_e164',
      'l.customer_id',
      'c.full_name',
      'c.needs_details',
      'l.source',
      'l.interests',
      'l.status',
      'l.first_contact_at',
      'l.last_contact_at',
      'l.follow_up_at',
      'l.follow_up_message_id',
      'm.queued_at',
      'l.booked_appointment_id',
      'l.closed_at',
    ])
    .where('l.location_id', '=', o.locationId)
    .$if(o.status === 'open', (q) => q.where('l.status', 'in', ['new', 'followed_up']))
    .$if(o.status !== 'open' && o.status !== 'all', (q) => q.where('l.status', '=', o.status as LeadStatus))
    .orderBy('l.last_contact_at', 'desc')
    .orderBy('l.id', 'desc')
    .limit(o.limit)
    .execute()
  return rows.map((r) => ({
    id: r.id,
    phone: r.phone_e164,
    customerId: r.customer_id,
    customerName: r.full_name ?? null,
    customerNeedsDetails: r.needs_details ?? false,
    source: r.source,
    interests: r.interests,
    status: r.status,
    firstContactAt: r.first_contact_at,
    lastContactAt: r.last_contact_at,
    followUpAt: r.follow_up_at,
    followUpMessageId: r.follow_up_message_id,
    followedUpAt: r.queued_at ?? null,
    bookedAppointmentId: r.booked_appointment_id,
    closedAt: r.closed_at,
  }))
}
