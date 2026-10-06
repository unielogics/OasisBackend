// GET /appointments: a keyset-paged list of cards for a date range, status, customer or search text.
import { sql } from 'kysely'
import type { Executor } from '../../platform/db.js'
import { decodeCursor, keysetCondition, toPage, type Page } from '../../platform/pagination.js'
import { bizDayBounds, addDays } from '../../platform/time.js'
import '../customers/schema.js'
import type { AppointmentStatus } from '../customers/schema.js'
import { listBays } from './appointments.js'
import { loadBoardRows, toCard, type OpsCard } from './board.js'
import { loadSettingsBundle, type SchedulingCtx } from './context.js'

const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (m) => `\\${m}`)

export interface ListQuery {
  from?: string
  to?: string
  status?: AppointmentStatus
  customerId?: string
  q?: string
  limit: number
  cursor?: string
  canContact: boolean
}

export async function listAppointments(db: Executor, c: SchedulingCtx, q: ListQuery): Promise<Page<OpsCard>> {
  let ids = db
    .selectFrom('appointments as a')
    .innerJoin('customers as cu', 'cu.id', 'a.customer_id')
    .leftJoin('vehicles as v', 'v.id', 'a.vehicle_id')
    .select(['a.id', 'a.scheduled_start', 'a.seq'])
    .where('a.location_id', '=', c.locationId)
  if (q.from) ids = ids.where('a.scheduled_start', '>=', bizDayBounds(q.from, c.tz).start)
  if (q.to) ids = ids.where('a.scheduled_start', '<', bizDayBounds(addDays(q.to, 1), c.tz).start)
  if (q.status) ids = ids.where('a.status', '=', q.status)
  if (q.customerId) ids = ids.where('a.customer_id', '=', q.customerId)
  const text = q.q?.trim()
  if (text) {
    const pat = `%${escapeLike(text)}%`
    ids = ids.where((eb) => {
      const parts = [
        sql<boolean>`cu.full_name ilike ${pat}`,
        sql<boolean>`(v.make ilike ${pat} or v.model ilike ${pat} or v.color ilike ${pat} or v.plate ilike ${pat})`,
        sql<boolean>`a.package_name ilike ${pat}`,
      ]
      if (q.canContact)
        parts.push(sql<boolean>`(cu.phone_display ilike ${pat} or cu.phone_e164 ilike ${pat})`)
      return eb.or(parts)
    })
  }
  if (q.cursor) {
    const [start, seq] = decodeCursor(q.cursor, 2)
    ids = ids.where(keysetCondition(['a.scheduled_start', 'a.seq'], [start as string, seq as number], 'asc'))
  }
  const page = await ids
    .orderBy('a.scheduled_start')
    .orderBy('a.seq')
    .limit(q.limit + 1)
    .execute()
  const slice = toPage(page, q.limit, (r) => [r.scheduled_start.toISOString(), r.seq])
  const order = new Map(slice.items.map((r, i) => [r.id, i]))
  const rows = await loadBoardRows(db, c, {
    from: new Date(0),
    to: new Date(0),
    ids: slice.items.map((r) => r.id),
    statuses: ['booked', 'confirmed', 'arrived', 'cleaning', 'completed', 'canceled', 'no_show'],
  })
  const [bays, settings] = await Promise.all([
    listBays(db, c.locationId),
    loadSettingsBundle(db, c.locationId),
  ])
  const index = { byId: new Map(bays.map((b) => [b.id, { id: b.id, number: b.number }])) }
  const now = c.clock.now()
  const items = rows
    .sort((x, y) => order.get(x.a.id)! - order.get(y.a.id)!)
    .map((r) => toCard(r, { now, tz: c.tz, lateGraceMin: settings.ops.lateGraceMin, bays: index }))
  return { items, nextCursor: slice.nextCursor }
}
