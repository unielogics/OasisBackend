// Fixture of the W3b suites (ADR 0160: the assistant's tools, in-chat actions, welcome flow and leads): the messaging-on-Postgres world
// (the `design` seed: catalog, bays, hours, clients with allowlisted numbers, the simulator device; frozen at Saturday 10:36 AM) with
// the assistant switched on in the environment, the W3 AssistantDeps over its real queue and scheduling ports, shop facts built from
// the public catalog (W3a builds the real ones), and a ToolContext the way the turn hands one to a tool.
import { beforeEach } from 'vitest'
import { sql } from 'kysely'
import * as audit from '../../src/platform/audit.js'
import type { Tx } from '../../src/platform/db.js'
import { schedulingPortsFor } from '../../src/composition.js'
import {
  AI_ACTOR_NAME,
  type AssistantDeps,
  type HandoffRequest,
  type ShopFacts,
  type ToolContext,
  type ToolHandoffReason,
  type TurnIdentity,
  type TurnTrust,
} from '../../src/modules/assistant/contract.js'
import { loadAppointmentRefs } from '../../src/modules/assistant/tools/refs.js'
import { grantTrust } from '../../src/modules/identity/trust.js'
import type { ClientLinkKind } from '../../src/modules/identity/schema.js'
import { ensureVehicleClasses } from '../../src/modules/catalog/vehicle-classes.js'
import { loadPublicCatalogV2 } from '../../src/modules/public/catalog.js'
import type { Actor, SchedulingCtx } from '../../src/modules/scheduling/context.js'
import { toBizDate } from '../../src/platform/time.js'
import { STRANGER, useWorld, type World } from '../messaging-db/world.js'

export { STRANGER }
export const STRANGER2 = '+13055550198'
export const PEPPER = Buffer.alloc(32, 7).toString('base64')

export interface ToolWorld extends World {
  readonly deps: AssistantDeps
  readonly facts: ShopFacts
  readonly logs: { level: string; obj: unknown; msg?: string }[]
  setting(key: string, value: unknown): Promise<void>
  assistantOn(o?: { actions?: boolean }): Promise<void>
  trust(phone: string, customerId: string): Promise<void>
  conversation(phone: string, customerId: string | null): Promise<string>
  ctx(o: { customerId: string | null; phone: string; trust: TurnTrust; provisional?: boolean; actionsEnabled?: boolean }): Promise<CtxProbe>
  scheduling(): SchedulingCtx
  aiActor(): Actor
}

export interface CtxProbe {
  ctx: ToolContext
  links: { url: string; kind: ClientLinkKind; expiresAt: Date; placeholder: string }[]
  handoffs: HandoffRequest[]
}

export function aiActorOf(locationId: string): Actor {
  return {
    auth: { userId: 'assistant', employeeId: null, locationId, permissions: new Set(['sched.edit', 'jobs.status']), actorName: AI_ACTOR_NAME, roles: ['assistant'] },
    audit: { actor: { name: AI_ACTOR_NAME } },
  }
}

/**
 * The owner has filled Settings → Prices by size: every active service the design seed priced with one figure gets that figure at
 * every active size (catalog v2 and the facts list no item without a price by size: ADR 0170 design 11, review Q4 F2). A service a
 * test priced itself is left alone.
 */
export async function priceTheGrid(w: World): Promise<void> {
  await ensureVehicleClasses(w.t.db, w.locationId)
  await sql`insert into service_class_prices (service_id, location_id, class_key, price_cents)
    select s.id, s.location_id, c.key, s.price_cents from services s
    join vehicle_classes c on c.location_id = s.location_id and c.active
    where s.location_id = ${w.locationId} and s.active and not s.quote_only and s.price_cents > 0
      and not exists (select 1 from service_class_prices p where p.service_id = s.id)
    on conflict do nothing`.execute(w.t.db)
}

/** Shop facts from the public catalog v2 (facts-v4: the catalog part is what the tools read; the rest is plain filler). */
export async function testFacts(w: World): Promise<ShopFacts> {
  const now = w.clock.now()
  const cat = await loadPublicCatalogV2(w.t.db, w.locationId, now)
  const label = (key: string): string => cat.vehicleClasses.find((c) => c.key === key)?.label ?? key
  const today = toBizDate(now, 'America/New_York')
  return {
    version: 'test',
    generatedAt: now.toISOString(),
    business: { name: 'Oasis Auto Spa', address: '468 River Drive, Garfield NJ 07026', timeZone: 'America/New_York', website: 'https://oasisautospanj.com' },
    contact: { textingNumber: '(862) 388-5827', callingNumber: '(201) 598-6304', email: null, lines: ['This number is for texting.'] },
    hours: [
      { weekday: 0, day: 'Sunday', open: false, from: null, to: null },
      ...[1, 2, 3, 4, 5, 6].map((d) => ({ weekday: d, day: ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d]!, open: true, from: '8:00 AM', to: '6:00 PM' })),
    ],
    closures: [{ date: '2026-07-04', dateLabel: 'Saturday, Jul 4', name: 'Independence Day', type: 'closed', emergency: false }],
    today: { date: today, day: 'Saturday', closed: false, opensAt: '8:00 AM', closesAt: '6:00 PM', reason: null, reduced: false, emergency: false },
    bookingRules: { slotMinutes: 30, onlineLeadMinutes: 30, cutoffMinutes: 60, windowStdDays: 14, windowVipDays: 30, vipReleaseHours: 24, vipSameDayPerMonth: 2, lines: [] },
    fee: { guestBookingFeeCents: cat.guestBookingFeeCents, collect: 'counter', lines: ['Members pay no booking fee.'] },
    cancellation: { freeCancelHours: 24, lines: ['Free cancellation up to 24 hours before.'] },
    vip: { lines: ['VIP members book 30 days ahead.'] },
    arrival: { lines: ['Pull up to the front bay.'] },
    automaticTexts: { reminderOffsetsMin: [1440, 120], confirmRequest: true, categoryPrep: {}, statusTexts: { checkedIn: true, runningLate: true, ready: true, pickedUp: true }, lines: [] },
    catalog: {
      categories: cat.categories.map((c) => ({ key: c.key, label: c.label })),
      sizes: cat.vehicleClasses.map((c) => ({ key: c.key, label: c.label })),
      items: [
        ...[...cat.services.map((s) => ({ s, kind: 'package' as const })), ...cat.addons.map((s) => ({ s, kind: 'addon' as const }))].map(({ s, kind }) => ({
          key: s.key,
          name: s.name,
          kind,
          category: s.category,
          description: s.description,
          durationMin: 'durationMin' in s ? s.durationMin : null,
          prices: s.prices.map((p) => ({ class: p.class, classLabel: label(p.class), cents: p.cents, maxCents: p.maxCents, memberCents: p.memberCents })),
          fromCents: s.fromCents,
          fromClassLabel: s.fromClass ? label(s.fromClass) : null,
          memberFromCents: s.memberFromCents,
          includedIn: [],
          quoteOnly: false,
          tintFilm: 'tintFilm' in s ? (s.tintFilm?.key ?? null) : null,
        })),
        ...cat.quotes.map((q) => ({
          key: q.key,
          name: q.name,
          kind: q.kind,
          category: q.category,
          description: q.description,
          durationMin: null,
          prices: [],
          fromCents: null,
          fromClassLabel: null,
          memberFromCents: null,
          includedIn: [],
          quoteOnly: true,
          tintFilm: null,
        })),
      ],
      tintFilms: [],
      lines: [],
    },
    // the tiers sold online (facts-v4: priced ones only); the design world prices none, so the two the tests sell are written here
    plans: [
      {
        key: 'gold',
        label: 'Gold',
        prices: [{ class: 'compact_car', classLabel: 'Compact car', monthlyCents: 9900 }],
        fromCents: 9900,
        fromClassLabel: 'Compact car',
        memberDiscountBp: 0,
        vipBooking: false,
        inclusions: [],
        perks: ['4 hand washes a month'],
      },
      {
        key: 'vip',
        label: 'VIP',
        prices: [{ class: 'compact_car', classLabel: 'Compact car', monthlyCents: 16900 }],
        fromCents: 16900,
        fromClassLabel: 'Compact car',
        memberDiscountBp: 0,
        vipBooking: true,
        inclusions: [],
        perks: ['Everything in Gold'],
      },
    ],
    faq: [{ q: 'Do you take walk-ins?', a: 'Yes, when a bay is free.' }],
  }
}

export function useToolWorld(o: { env?: Record<string, string> } = {}): ToolWorld {
  const w = useWorld({
    env: {
      AI_ENABLED: 'true',
      AI_ACTIONS_ENABLED: 'true',
      PUBLIC_LINKS_ENABLED: 'true',
      PIN_PEPPER: PEPPER,
      PUBLIC_SITE_URL: 'https://oasisautospanj.com',
      BUSINESS_PHONE: '+12015986304',
      ...o.env,
    },
  })
  let facts: ShopFacts
  let deps: AssistantDeps
  const logs: { level: string; obj: unknown; msg?: string }[] = []
  let turn = 0

  beforeEach(async () => {
    await sql`truncate table leads, assistant_pending_actions, assistant_tool_calls, assistant_turns, assistant_conversations,
      client_link_sessions, client_links, phone_trust, customer_pins cascade`.execute(w.t.db)
    await sql`delete from settings where key like 'assistant.%' or key like 'leads.%'`.execute(w.t.db)
    // what a test created: the welcome flow's clients (their texts and threads went with the world's truncate) and added vehicles
    await sql`delete from vehicles where customer_id in (select id from customers where source = 'inbound_sms')`.execute(w.t.db)
    await sql`delete from customers where source = 'inbound_sms'`.execute(w.t.db)
    await sql`delete from vehicles where created_at > ${new Date(w.clock.now().getTime() - 60_000)} and plate is null`.execute(w.t.db)
    await sql`update vehicles set vehicle_type = null`.execute(w.t.db)
    await sql`update customers set needs_details = false, deleted_at = null, archived_at = null where source <> 'inbound_sms'`.execute(w.t.db)
    logs.length = 0
    await priceTheGrid(w)
    facts = await testFacts(w)
    const log = {
      info: (obj: unknown, msg?: string) => void logs.push({ level: 'info', obj, ...(msg ? { msg } : {}) }),
      warn: (obj: unknown, msg?: string) => void logs.push({ level: 'warn', obj, ...(msg ? { msg } : {}) }),
      error: (obj: unknown, msg?: string) => void logs.push({ level: 'error', obj, ...(msg ? { msg } : {}) }),
    }
    deps = {
      db: w.t.db,
      clock: w.clock,
      newId: w.newId,
      env: w.env,
      queue: w.rt.queue,
      log: log as AssistantDeps['log'],
      facts: { get: async () => facts },
      schedulingFor: (locationId) => ({ clock: w.clock, newId: w.newId, locationId, tz: 'America/New_York', ports: schedulingPortsFor({ db: w.t.db, clock: w.clock, env: w.env, newId: w.newId }, w.rt) }),
      actorFor: (locationId) => aiActorOf(locationId),
    }
  })

  const self: ToolWorld = Object.create(w, {
    deps: { get: () => deps },
    facts: { get: () => facts },
    logs: { get: () => logs },
  }) as ToolWorld

  self.setting = async (key, value) => {
    await sql`insert into settings (location_id, key, value) values (${w.locationId}, ${key}, ${JSON.stringify(value)}::jsonb)
      on conflict (location_id, key) do update set value = excluded.value, version = settings.version + 1`.execute(w.t.db)
  }
  self.assistantOn = async (a = {}) => {
    await self.setting('assistant.enabled', true)
    await self.setting('assistant.stage', 'everyone')
    if (a.actions) await self.setting('assistant.actions_enabled', true)
  }
  self.trust = async (phone, customerId) => {
    await w.tx((tx) => grantTrust(tx, { locationId: w.locationId, phone, customerId, verifiedBy: 'pin', now: w.clock.now() }))
  }
  self.conversation = async (phone, customerId) => {
    const r = await sql<{ id: string }>`
      insert into assistant_conversations (id, location_id, phone_e164, customer_id) values (${w.newId()}, ${w.locationId}, ${phone}, ${customerId})
      on conflict (location_id, phone_e164) do update set customer_id = coalesce(excluded.customer_id, assistant_conversations.customer_id)
      returning id`.execute(w.t.db)
    return r.rows[0]!.id
  }
  self.scheduling = () => deps.schedulingFor(w.locationId)
  self.aiActor = () => aiActorOf(w.locationId)
  self.ctx = async (c) => {
    const links: CtxProbe['links'] = []
    const handoffs: HandoffRequest[] = []
    const conversationId = await self.conversation(c.phone, c.customerId)
    turn += 1
    const turnId = `turn-${turn}`
    const identity: TurnIdentity = {
      locationId: w.locationId,
      phone: c.phone,
      customerId: c.customerId,
      provisional: c.provisional ?? false,
      trust: c.trust,
      trustUntil: c.trust === 'trusted' ? new Date(w.clock.now().getTime() + 30 * 86_400_000) : null,
    }
    const ctx: ToolContext = {
      db: w.t.db,
      clock: w.clock,
      now: w.clock.now(),
      newId: w.newId,
      env: w.env,
      identity,
      conversationId,
      turnId,
      facts,
      refs: await loadAppointmentRefs(w.t.db, { locationId: w.locationId, customerId: c.trust === 'unknown' ? null : c.customerId, now: w.clock.now() }),
      actionsEnabled: c.actionsEnabled ?? true,
      scheduling: self.scheduling(),
      actor: self.aiActor(),
      queue: w.rt.queue,
      log: deps.log,
      signal: new AbortController().signal,
      addLink(url, link) {
        const placeholder = `{link${links.length + 1}}`
        links.push({ url, ...link, placeholder })
        return placeholder
      },
      handoff(reason: ToolHandoffReason, summary: string) {
        if (handoffs.length === 0) handoffs.push({ reason, summary })
      },
      handoffRequested: () => handoffs.length > 0,
      async audit(tx: Tx, action, detail) {
        await audit.record(tx, { locationId: w.locationId, action, ...detail, ctx: { actor: { name: AI_ACTOR_NAME }, requestId: turnId } })
      },
      async setCustomer() {
        throw new Error('not used by the W3b tools')
      },
    }
    return { ctx, links, handoffs }
  }
  return self
}
