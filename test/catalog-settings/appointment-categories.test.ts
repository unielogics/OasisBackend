// appointments.categories (ADR 0160, plan K) kept right by every path that changes what a visit holds: booking (createAppointment,
// the one command the dashboard, the website, the standing materializer and the assistant book through), adding and removing an
// add-on, and a service moving category. Over the design seed with the real scheduling commands.
import { describe, expect, it } from 'vitest'
import {
  categoriesOf,
  refreshAllAppointmentCategories,
  refreshAppointmentCategories,
  visitCategory,
} from '../../src/modules/catalog/appointment-categories.js'
import { putWebsiteFields, websiteFieldsOf } from '../../src/modules/catalog/website.js'
import { requireService } from '../../src/modules/catalog/service.js'
import { addAddon, removeAddon } from '../../src/modules/scheduling/addons.js'
import { createAppointment } from '../../src/modules/scheduling/booking.js'
import { useOps } from '../scheduling/helpers.js'

const o = useOps()
const at = (hhmm: string): Date => new Date(`2026-06-13T${hhmm}:00-04:00`)

let n = 0
/** A service written straight to the table in the given category (the design seed has no tint). */
async function service(kind: 'package' | 'addon', category: string, name = `${category} ${kind} ${++n}`): Promise<string> {
  const id = o.ctx.newId()
  await o.t.db
    .insertInto('services')
    .values({
      id,
      location_id: o.locationId,
      kind,
      name,
      short_name: null,
      price_cents: 10_000,
      duration_min: kind === 'addon' ? 0 : 60,
      sqsp_sku: null,
      category,
    })
    .execute()
  return id
}

const categoriesOfRow = async (id: string): Promise<string[]> =>
  (await o.t.db.selectFrom('appointments').select('categories').where('id', '=', id).executeTakeFirstOrThrow()).categories

describe('booking', () => {
  it('a wash with a tint add-on is a mixed visit; a plain wash is a wash; categories follow the category order', async () => {
    const tintAddon = await service('addon', 'tint')
    const actor = await o.actor()
    const mixed = await o.tx((tx) =>
      createAppointment(tx, o.ctx, actor, {
        customer: { id: o.customer('Maria Delgado') },
        serviceId: o.svc('Express Hand Wash').id,
        addonIds: [tintAddon, o.svc('Wax').id],
        start: at('13:00'),
      }),
    )
    expect(await categoriesOfRow(mixed.appointment.id)).toEqual(['wash', 'addons', 'tint'])
    expect(visitCategory(await categoriesOfRow(mixed.appointment.id))).toBe('mixed')

    const plain = await o.book({ serviceName: 'Express Hand Wash', customerName: 'Liam Chen', at: '2026-06-13T14:00:00-04:00' })
    expect(await categoriesOfRow(plain.appointment.id)).toEqual(['wash'])
    expect(visitCategory(['wash'])).toBe('wash')

    // the design's Executive Detail is a detail (tag executive), not a wash
    const detail = await o.book({ serviceName: 'Executive Detail', customerName: 'Priya Nair', at: '2026-06-13T15:00:00-04:00' })
    expect(await categoriesOfRow(detail.appointment.id)).toEqual(['detail'])
  })

  it('a tint package with a wash add-on is mixed too', async () => {
    const tint = await service('package', 'tint')
    const washAddon = await service('addon', 'wash')
    const r = await o.book({ serviceId: tint, addonIds: [washAddon], customerName: 'Tom Bradley', at: '2026-06-13T13:30:00-04:00' })
    expect(await categoriesOfRow(r.appointment.id)).toEqual(['wash', 'tint'])
    expect(await categoriesOfRow(r.appointment.id)).toEqual(await categoriesOf(o.t.db, o.locationId, [tint, washAddon]))
  })
})

describe('add-on changes', () => {
  it('adding a tint add-on makes the visit mixed; removing it makes it a wash again; a repeated add changes nothing', async () => {
    const tintAddon = await service('addon', 'tint')
    const actor = await o.actor()
    const r = await o.book({ serviceName: 'Express Hand Wash', at: '2026-06-13T13:00:00-04:00' })
    expect(await categoriesOfRow(r.appointment.id)).toEqual(['wash'])

    await o.tx((tx) => addAddon(tx, o.ctx, actor, r.appointment.id, tintAddon))
    expect(await categoriesOfRow(r.appointment.id)).toEqual(['wash', 'tint'])
    await o.tx((tx) => addAddon(tx, o.ctx, actor, r.appointment.id, o.svc('Wax').id))
    expect(await categoriesOfRow(r.appointment.id)).toEqual(['wash', 'addons', 'tint'])
    await o.tx((tx) => addAddon(tx, o.ctx, actor, r.appointment.id, tintAddon))
    expect(await categoriesOfRow(r.appointment.id)).toEqual(['wash', 'addons', 'tint'])

    await o.tx((tx) => removeAddon(tx, o.ctx, actor, r.appointment.id, tintAddon))
    expect(await categoriesOfRow(r.appointment.id)).toEqual(['wash', 'addons'])
    expect(visitCategory(await categoriesOfRow(r.appointment.id))).toBe('wash')
    await o.tx((tx) => removeAddon(tx, o.ctx, actor, r.appointment.id, o.svc('Wax').id))
    expect(await categoriesOfRow(r.appointment.id)).toEqual(['wash'])
  })
})

describe('a service changing category', () => {
  it('re-derives the open visits holding it (as package or live add-on) and leaves finished ones as they were', async () => {
    const addon = await service('addon', 'addons', 'Glass coating test')
    const actor = await o.actor()
    const open = await o.book({ serviceName: 'Express Hand Wash', addonIds: [addon], at: '2026-06-13T13:00:00-04:00' })
    const finished = await o.insert({ customerName: 'Liam Chen', serviceName: 'Express Hand Wash', at: '2026-06-13T08:00:00-04:00', status: 'completed', completedAt: '2026-06-13T08:45:00-04:00' })
    await o.tx(async (tx) => {
      await tx.insertInto('appointment_addons').values({ id: o.ctx.newId(), appointment_id: finished, service_id: addon, name: 'Glass coating test', price_cents: 1000, added_by: null }).execute()
      await refreshAppointmentCategories(tx, finished)
    })
    expect(await categoriesOfRow(finished)).toEqual(['wash', 'addons'])

    const svc = await requireService(o.t.db, o.locationId, addon)
    const r = await o.tx((tx) =>
      putWebsiteFields(tx, { locationId: o.locationId, serviceId: addon, fields: { ...websiteFieldsOf(svc), category: 'detail' }, audit: actor.audit }),
    )
    expect(r.appointmentsUpdated).toBe(1)
    expect(await categoriesOfRow(open.appointment.id)).toEqual(['wash', 'detail'])
    expect(await categoriesOfRow(finished)).toEqual(['wash', 'addons'])
  })

  it('refreshAll fills rows written straight to the table (the seeds) and is a no-op the second time', async () => {
    const id = await o.insert({ customerName: 'Grace Adeyemi', serviceName: 'Full Detail', at: '2026-06-13T12:00:00-04:00' })
    expect(await categoriesOfRow(id)).toEqual([])
    const first = await o.tx((tx) => refreshAllAppointmentCategories(tx, o.locationId))
    expect(first).toBeGreaterThanOrEqual(1)
    expect(await categoriesOfRow(id)).toEqual(['detail'])
    expect(await o.tx((tx) => refreshAllAppointmentCategories(tx, o.locationId))).toBe(0)
  })
})

describe('visitCategory', () => {
  it('ignores add-ons unless they are all there is', () => {
    expect(visitCategory([])).toBeNull()
    expect(visitCategory(['addons'])).toBe('addons')
    expect(visitCategory(['wash', 'addons'])).toBe('wash')
    expect(visitCategory(['wash', 'tint'])).toBe('mixed')
    expect(visitCategory(['detail', 'quote'])).toBe('mixed')
  })
})
