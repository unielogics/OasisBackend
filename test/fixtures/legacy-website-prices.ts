// The website's old figures (the "Oasis Site v2" design, before ADR 0170) as prices by size, for the tests that pin how prices are
// worded (the assistant's facts and renderings): the regular price is the old guest price (member + 20%), the tiers' member % off is
// 16.67% (so every old member price comes back to the dollar: $54 -> $45, $47 -> $39, $275 -> $229, …), Gold is $99 and VIP $169 a
// month, and the sizes are the old tint matrix's vehicle types (sedan, suv, truck with their labels) so the tint placeholders keep
// their keys. Run after the website-catalog seed. Production never runs this: the owner's prices are set in Settings.
import { putClassPrices, type PriceRowInput } from '../../src/modules/catalog/class-prices.js'
import { putTierPrices, requireTier } from '../../src/modules/catalog/tiers.js'
import type { Clock } from '../../src/platform/clock.js'
import { transaction, type Db } from '../../src/platform/db.js'
import { createIdGenerator } from '../../src/platform/ids.js'
import { getSetting, updateSetting } from '../../src/platform/settings.js'

/** The old guest prices in dollars at a sedan (the website's member price + 20%, to the dollar). */
export const LEGACY_GUEST_DOLLARS: Readonly<Record<string, number>> = {
  'Signature Hand Wash': 54,
  'Exterior Hand Wash': 38,
  'Interior detail': 179,
  'Full detail': 299,
  'Hand wax': 47,
  'Engine bay wash': 54,
  'Leather conditioning': 42,
  'Stain removal': 71,
  'Tire shine & dressing': 14,
  'Rain-repellent glass': 30,
  'Odor removal': 36,
  'Pet hair removal': 42,
  'Interior deep clean': 72,
}

/** The old tint matrix's guest ranges in dollars, by film and vehicle type. */
export const LEGACY_TINT_DOLLARS: Readonly<Record<'carbon' | 'ceramic', Record<'sedan' | 'suv' | 'truck', [number, number]>>> = {
  carbon: { sedan: [275, 335], suv: [323, 395], truck: [299, 359] },
  ceramic: { sedan: [455, 539], suv: [515, 635], truck: [479, 575] },
}

/** 16.67% off: every old guest price comes back to its old member price, rounded to whole dollars. */
export const LEGACY_MEMBER_BP = 1667

export async function seedLegacyWebsitePrices(db: Db, clock: Clock, locationId: string): Promise<void> {
  const newId = createIdGenerator(clock)
  await transaction(db, async (tx) => {
    // the sizes: the old vehicle types, smallest first; the defaults other than truck turned off
    await tx.updateTable('vehicle_classes').set({ active: false }).where('location_id', '=', locationId).where('key', '<>', 'truck').execute()
    await tx
      .insertInto('vehicle_classes')
      .values([
        { location_id: locationId, key: 'sedan', label: 'Sedan / Coupe', sort: 1 },
        { location_id: locationId, key: 'suv', label: 'SUV / Crossover', sort: 2 },
      ])
      .onConflict((oc) => oc.columns(['location_id', 'key']).doUpdateSet({ active: true }))
      .execute()
    await tx.updateTable('vehicle_classes').set({ label: 'Truck / Van', sort: 3, active: true }).where('location_id', '=', locationId).where('key', '=', 'truck').execute()

    const services = await tx.selectFrom('services').select(['id', 'name', 'version']).where('location_id', '=', locationId).where('active', '=', true).execute()
    const rows = services.flatMap((s): PriceRowInput[] => {
      const film = s.name === 'Carbon window tint' ? 'carbon' : s.name === 'Ceramic window tint' ? 'ceramic' : null
      if (film)
        return [
          {
            serviceId: s.id,
            version: s.version,
            cells: (['sedan', 'suv', 'truck'] as const).map((v) => ({
              class: v,
              cents: LEGACY_TINT_DOLLARS[film][v][0] * 100,
              maxCents: LEGACY_TINT_DOLLARS[film][v][1] * 100,
            })),
          },
        ]
      const dollars = LEGACY_GUEST_DOLLARS[s.name]
      return dollars === undefined ? [] : [{ serviceId: s.id, version: s.version, cells: [{ class: 'sedan', cents: dollars * 100, maxCents: null }] }]
    })
    await putClassPrices(tx, { locationId, rows, userId: null })

    for (const [key, monthly] of [
      ['gold', 9900],
      ['vip', 16900],
    ] as const) {
      await tx.updateTable('membership_plans').set({ member_discount_bp: LEGACY_MEMBER_BP }).where('location_id', '=', locationId).where('key', '=', key).execute()
      const t = await requireTier(tx, locationId, key)
      await putTierPrices(tx, { newId, now: clock.now() }, {
        locationId,
        userId: null,
        rows: [{ tierKey: key, priceVersion: t.priceVersion, cells: [{ class: 'sedan', monthlyCents: monthly }] }],
      })
    }
    // the films with the old matrix's shades (the website-catalog seed sets them when empty)
    const films = await getSetting(tx, locationId, 'catalog.tint_films')
    if (films.value.length === 0)
      await updateSetting(tx, {
        locationId,
        key: 'catalog.tint_films',
        value: [
          { key: 'carbon', label: 'Carbon', vlt: [5, 20, 35, 50, 70] },
          { key: 'ceramic', label: 'Ceramic', vlt: [5, 20, 35, 50, 70] },
        ],
      })
  })
}
