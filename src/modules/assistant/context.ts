// What a turn knows (ADR 0160, design section 3 "Turn" and the W3 contract): who is texting (TurnIdentity, decided server side from
// the number: a stranger, the client on file, a client whose phone is trusted), the client's own appointments as refs A1..A3, the
// turn context the model reads, and the last texts of the conversation. Nothing here hands the model a phone number, an id or a
// token: names are first names, appointments are refs, numbers inside texts are masked.
import { sql } from 'kysely'
import type { Executor } from '../../platform/db.js'
import { DAY_ABBR } from '../settings/labels.js'
import { bizWeekday, clockLabel, dateLabel, toBizDate } from '../../platform/time.js'
import { getCustomer } from '../customers/service.js'
import { ownerOf } from '../identity/common.js'
import { staleRecord } from '../identity/stale.js'
import { evaluateTrust } from '../identity/trust.js'
import { memberView } from '../public/members.js'
import type { AppointmentRefLabel, AppointmentRefs, TurnIdentity } from './contract.js'
import { nextIntakeStep, type HistoryLine, type TurnContextData } from './prompt.js'
import { maskPhones } from './transcript.js'
import '../customers/schema.js'
import '../messaging/schema.js'
import '../scheduling/schema.js'
import '../leads/schema.js'
import './schema.js'

/** The welcome flow's placeholder name ("New texter ••0142"). */
export const PROVISIONAL_NAME = /^New texter\b/

export interface ResolvedIdentity {
  identity: TurnIdentity
  /** The client whose thread the turn's texts are filed in (the stale record's too): null for a stranger. */
  threadCustomerId: string | null
  fullName: string | null
}

/** Who is texting from `phone` now (design section 5 stale rule; identity/trust.ts). */
export async function resolveIdentity(
  db: Executor,
  o: { locationId: string; phone: string; customerId: string | null; now: Date },
): Promise<ResolvedIdentity> {
  let candidate: string | null = null
  if (o.customerId) {
    const c = await db
      .selectFrom('customers')
      .select('id')
      .where('id', '=', o.customerId)
      .where('phone_e164', '=', o.phone)
      .where('merged_into', 'is', null)
      .where('deleted_at', 'is', null)
      .executeTakeFirst()
    candidate = c?.id ?? null
  }
  candidate ??= (await ownerOf(db, o.phone)) ?? null
  const none: TurnIdentity = { locationId: o.locationId, phone: o.phone, customerId: null, provisional: false, trust: 'unknown', trustUntil: null }
  if (!candidate) return { identity: none, threadCustomerId: null, fullName: null }
  const c = await db.selectFrom('customers').select(['full_name', 'needs_details']).where('id', '=', candidate).executeTakeFirstOrThrow()
  const provisional = c.needs_details && PROVISIONAL_NAME.test(c.full_name)
  // the stale-record rule holds a provisional record too (W4c re-review M1): a "New texter" record quiet for 180 days may carry a
  // previous holder's vehicle and visits, so it is unknown (no name, vehicles, visits, membership or balance) until proof
  const stale = await staleRecord(db, { locationId: o.locationId, customerId: candidate, phone: o.phone, now: o.now })
  if (stale.stale) return { identity: none, threadCustomerId: candidate, fullName: null }
  const trust = await evaluateTrust(db, { locationId: o.locationId, phone: o.phone, now: o.now, customerId: candidate })
  return {
    identity: {
      locationId: o.locationId,
      phone: o.phone,
      customerId: candidate,
      provisional,
      trust: trust.trusted ? 'trusted' : 'caller',
      trustUntil: trust.trusted ? trust.until : null,
    },
    threadCustomerId: candidate,
    fullName: provisional ? null : c.full_name,
  }
}

export interface AppointmentRefRow {
  ref: AppointmentRefLabel
  appointmentId: string
  start: Date
  packageName: string
  status: string
}

const OPEN = ['booked', 'confirmed', 'arrived', 'cleaning'] as const
const LABELS: readonly AppointmentRefLabel[] = ['A1', 'A2', 'A3']

/** The client's open upcoming appointments by start, then the most recent past one; at most three (contract AppointmentRefs). */
export async function loadAppointmentRefs(db: Executor, o: { locationId: string; customerId: string | null; now: Date }): Promise<AppointmentRefRow[]> {
  if (!o.customerId) return []
  const upcoming = await db
    .selectFrom('appointments')
    .select(['id', 'scheduled_start', 'package_name', 'status'])
    .where('location_id', '=', o.locationId)
    .where('customer_id', '=', o.customerId)
    .where('status', 'in', [...OPEN])
    .where('scheduled_end', '>=', o.now)
    .orderBy('scheduled_start')
    .orderBy('id')
    .limit(3)
    .execute()
  const rows = [...upcoming]
  if (rows.length < 3) {
    const past = await db
      .selectFrom('appointments')
      .select(['id', 'scheduled_start', 'package_name', 'status'])
      .where('location_id', '=', o.locationId)
      .where('customer_id', '=', o.customerId)
      .where('scheduled_start', '<', o.now)
      .where('id', 'not in', rows.length > 0 ? rows.map((r) => r.id) : ['00000000-0000-0000-0000-000000000000'])
      .orderBy('scheduled_start', 'desc')
      .orderBy('id')
      .limit(1)
      .executeTakeFirst()
    if (past) rows.push(past)
  }
  return rows.slice(0, 3).map((r, i) => ({ ref: LABELS[i]!, appointmentId: r.id, start: r.scheduled_start, packageName: r.package_name, status: r.status }))
}

/** Refs that resolve only to the turn's own rows (a label of another list, or anything else, is null). */
export function appointmentRefs(rows: readonly AppointmentRefRow[]): AppointmentRefs {
  const list = rows.map((r) => ({ ref: r.ref, appointmentId: r.appointmentId }))
  return {
    resolve: (ref: string) => list.find((r) => r.ref === ref.trim().toUpperCase())?.appointmentId ?? null,
    all: () => list,
  }
}

const STATUS_WORDS: Record<string, string> = {
  booked: 'booked',
  confirmed: 'confirmed',
  arrived: 'checked in',
  cleaning: 'being cleaned',
  completed: 'done',
  canceled: 'canceled',
  no_show: 'missed',
}

/**
 * Phone numbers, ids and long digit runs in a text, masked (texts are data for the model, never a way to pass a number): the same
 * pattern set as the stored transcript (transcript.ts PHONE_PATTERNS via maskPhones).
 */
export function maskForModel(text: string): string {
  return maskPhones(text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '[id]'), () => '[number]').replace(
    /\b(?:oa_|tok_)[A-Za-z0-9_-]{8,}\b/g,
    '[token]',
  )
}

export interface ConversationSnapshot {
  lines: HistoryLine[]
  /** The newest inbound text this turn answers (its received_at). */
  newestInboundAt: Date | null
  /** The inbox rows this turn answers. */
  inboxIds: string[]
  /** The client wrote before this burst or the shop texted the number before: not a first contact. */
  firstContact: boolean
}

/** The last historyLimit texts of the number within historyWindowMs, inbound (sms_inbox) and outbound (messages), oldest first. */
export async function loadConversation(
  db: Executor,
  o: { locationId: string; conversationId: string; phone: string; pendingSince: Date | null; now: Date; tz: string; limit: number; windowMs: number },
): Promise<ConversationSnapshot> {
  const since = new Date(o.now.getTime() - o.windowMs)
  const inbound = await db
    .selectFrom('sms_inbox as i')
    .innerJoin('sms_devices as d', 'd.id', 'i.device_id')
    .select(['i.id', 'i.body', 'i.received_at', 'i.decision', 'i.assistant_conversation_id'])
    .where('d.location_id', '=', o.locationId)
    .where('i.from_e164', '=', o.phone)
    .where('i.superseded_by', 'is', null)
    .where('i.received_at', '>', since)
    .where('i.received_at', '<=', o.now)
    .orderBy('i.received_at', 'desc')
    .limit(o.limit)
    .execute()
  const outbound = await db
    .selectFrom('messages')
    .select(['body', 'sender_kind', 'queued_at'])
    .where('location_id', '=', o.locationId)
    .where('direction', '=', 'out')
    .where('peer_e164', '=', o.phone)
    .where('status', 'not in', ['failed', 'canceled', 'expired'])
    .where('queued_at', '>', since)
    .where('queued_at', '<=', o.now)
    .orderBy('queued_at', 'desc')
    .limit(o.limit)
    .execute()
  const when = (at: Date): string => `[${DAY_ABBR[bizWeekday(toBizDate(at, o.tz))]} ${clockLabel(at, o.tz)}]`
  const pending = o.pendingSince?.getTime() ?? Infinity
  const fresh = (r: (typeof inbound)[number]): boolean =>
    r.assistant_conversation_id === o.conversationId && r.decision === 'assistant' && r.received_at.getTime() >= pending
  const lines: HistoryLine[] = [
    ...inbound.map((r) => ({ at: r.received_at, when: when(r.received_at), who: 'client' as const, text: maskForModel(r.body), fresh: fresh(r) })),
    ...outbound.map((m) => ({
      at: m.queued_at,
      when: when(m.queued_at),
      who: m.sender_kind === 'ai' ? ('ai' as const) : m.sender_kind === 'staff' ? ('staff' as const) : ('shop' as const),
      text: maskForModel(m.body),
      fresh: false,
    })),
  ]
    .sort((a, b) => a.at.getTime() - b.at.getTime() || (a.who === 'client' ? -1 : 1))
    .slice(-o.limit)
  const answered = inbound.filter(fresh)
  const prior = await sql<{ n: number }>`
    select (
      (select count(*) from messages where location_id = ${o.locationId} and direction = 'out' and peer_e164 = ${o.phone})
      + (select count(*) from sms_inbox i join sms_devices d on d.id = i.device_id
          where d.location_id = ${o.locationId} and i.from_e164 = ${o.phone} and i.received_at < ${new Date(Math.min(pending, o.now.getTime()))}::timestamptz)
    )::int as n`.execute(db)
  return {
    lines,
    newestInboundAt: answered.length > 0 ? answered[0]!.received_at : (inbound[0]?.received_at ?? null),
    inboxIds: answered.map((r) => r.id),
    firstContact: (prior.rows[0]?.n ?? 0) === 0,
  }
}

/**
 * How a reply may name a vehicle on file: "2021 Tesla Model 3", "Tesla Model 3", and the model alone when it has a letter ("Model 3",
 * "C300", "F-150"; never a bare "911"). The guard skips them in the secret and promise word lists only: they are client-entered, so
 * the money, digit and host rules still read them and the judge never trusts them.
 */
export function vehicleLiterals(v: { year: number | null; make: string | null; model: string | null }): string[] {
  const make = v.make?.trim() ?? ''
  const model = v.model?.trim() ?? ''
  const out = [[v.year, make, model].filter((x) => x !== null && String(x).trim() !== '').join(' '), [make, model].filter((x) => x !== '').join(' ')]
  if (/\p{L}/u.test(model) && /\d/.test(model)) out.push(model)
  return [...new Set(out.filter((x) => /\d/.test(x)))]
}

/** The turn context data of design section 3 (no phone, ids or tokens). */
export async function loadTurnContext(
  db: Executor,
  o: {
    resolved: ResolvedIdentity
    conversationId: string
    refs: readonly AppointmentRefRow[]
    actionsEnabled: boolean
    firstContact: boolean
    now: Date
    tz: string
  },
): Promise<TurnContextData> {
  const { identity } = o.resolved
  const customerId = identity.customerId
  const firstName = o.resolved.fullName ? (o.resolved.fullName.trim().split(/\s+/)[0] ?? null) : null
  let membership: string | null = null
  let memberActive = false
  let vehicles: string[] = []
  let vehicleNames: string[] = []
  let hasAppointments = false
  let welcomed = false
  if (customerId) {
    const customer = await getCustomer(db, customerId)
    // a client the welcome flow created (owner 2026-10-11) stays a new texter until the intake is done or they book
    welcomed = customer?.source === 'inbound_sms'
    const view = await memberView(db, identity.locationId, customer)
    if (view.active) {
      memberActive = true
      membership = `${view.plan ?? 'member'}, active${view.washesLeft !== null ? `, ${view.washesLeft} wash${view.washesLeft === 1 ? '' : 'es'} left this cycle` : ''}`
    }
    const rows = await db
      .selectFrom('vehicles')
      .select(['year', 'make', 'model', 'color'])
      .where('customer_id', '=', customerId)
      .where('deleted_at', 'is', null)
      .orderBy('created_at')
      .limit(3)
      .execute()
    vehicles = rows.map((v) => [v.year, v.make, v.model].filter((x) => x !== null && String(x).trim() !== '').join(' ') + (v.color ? `, ${v.color}` : ''))
    vehicleNames = rows.flatMap((v) => vehicleLiterals(v))
    hasAppointments =
      (await db.selectFrom('appointments').select('id').where('customer_id', '=', customerId).limit(1).executeTakeFirst()) !== undefined
  }
  const lead = await db
    .selectFrom('leads')
    .select('interests')
    .where('location_id', '=', identity.locationId)
    .where('phone_e164', '=', identity.phone)
    .executeTakeFirst()
  const presented = await db
    .selectFrom('assistant_tool_calls as c')
    .innerJoin('assistant_turns as t', 't.id', 'c.turn_id')
    .select('c.id')
    .where('t.conversation_id', '=', o.conversationId)
    .where('c.tool', '=', 'get_membership_info')
    .where('c.outcome', '=', 'ok')
    .limit(1)
    .executeTakeFirst()
  const unknownNumber = customerId === null
  const newClient = unknownNumber || identity.provisional || (welcomed && !hasAppointments)
  return {
    nowLabel: `${dateLabel(o.now, o.tz)}, ${o.now.toLocaleString('en-US', { timeZone: o.tz, year: 'numeric' })}, ${clockLabel(o.now, o.tz)}`,
    firstName,
    unknownNumber,
    firstContact: o.firstContact,
    trusted: identity.trust === 'trusted',
    trustUntilLabel: identity.trustUntil ? dateLabel(identity.trustUntil, o.tz) : null,
    actionsEnabled: o.actionsEnabled,
    membership,
    vehicles,
    vehicleNames,
    appointments: o.refs.map((r) => ({
      ref: r.ref,
      label: `${dateLabel(r.start, o.tz)} at ${clockLabel(r.start, o.tz)}, ${maskForModel(r.packageName)} (${STATUS_WORDS[r.status] ?? r.status})`,
    })),
    intake: nextIntakeStep({
      newClient,
      nameKnown: firstName !== null,
      intentKnown: (lead?.interests.length ?? 0) > 0 || hasAppointments,
      membershipsPresented: memberActive || presented !== undefined,
      vehicleKnown: vehicles.length > 0,
    }),
  }
}
