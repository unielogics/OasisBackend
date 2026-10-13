// SQR-15, 16, 17, 19 and 20 of pnpm verify:square (ADR 0172): Oasis's own item library sync (the desired library, planner, merge and
// sender of src/modules/catalog/square, with the links in memory) against the Square SANDBOX (or --sim), on a small library of its
// own whose names carry the run's verify- reference; everything the run makes is deleted by the cleanup (SQR-11). SQR-20 is
// read-only (the production pre-flight): the shop's taxes against Oasis's rate and the number of items.
//   SQR-15  items, categories and the tax made; the same key and body answer the same objects; id_mappings for every temp id
//   SQR-16  a price changed in place (same variation id, new version); a size renamed and the sizes reordered; a size turned off is
//           hidden (same id), on again; the item archived and put back on sale
//   SQR-17  a variation staff added survives Oasis's read-modify-write; a stale version that changes a field changed since is
//           VERSION_MISMATCH; a BatchUpsert with one bad batch answers 400 and keeps the good one (why Oasis creates one item per call)
//   SQR-19  VARIABLE pricing (no price, the amount rung up) and a $0 price; CalculateOrder of the catalog lines with the tax auto-applied
//   SQR-20  (read-only) the shop's taxes against Oasis's rate (--rate, default 6.625), the item count
import type { SquareApi } from '../../src/integrations/ports/square.js'
import { SquareApiError } from '../../src/integrations/square/errors.js'
import { sqKey } from '../../src/integrations/square/keys.js'
import { usd } from '../../src/integrations/square/money.js'
import type { WireCatalogObject } from '../../src/integrations/square/wire.js'
import type { PriceBook } from '../../src/modules/catalog/price-book.js'
import { desiredLibrary, markerOf, type LibraryInput } from '../../src/modules/catalog/square/desired.js'
import { memoryLinkStore, runEngine } from '../../src/modules/catalog/square/engine.js'
import { planItems, planSetup, type RemoteView } from '../../src/modules/catalog/square/plan.js'
import { decideTax, listTaxes, squarePercent, type TaxCheck } from '../../src/modules/catalog/square/tax.js'
import { parseTaxPercent, salesTaxCents, SQUARE_TAX_ROUNDING, taxPercentLabel } from '../../src/platform/money.js'
import type { Report } from './lib.js'

type Cleanup = Array<{ what: string; run: () => Promise<unknown> }>

const svc = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

interface Cell {
  cents: number
  maxCents: number | null
}

/** The run's own little library: a wash priced by size (a range, a $0 size) and an add-on with one price. */
function library(ref: string, o: { cells: Record<string, Cell>; labels?: Record<string, string>; sorts?: Record<string, number>; off?: string[]; archived?: boolean }): LibraryInput {
  const classes = [
    { key: 'compact_car', label: o.labels?.compact_car ?? 'Compact car', sort: o.sorts?.compact_car ?? 10, active: !o.off?.includes('compact_car') },
    { key: 'large_suv', label: o.labels?.large_suv ?? 'Large SUV', sort: o.sorts?.large_suv ?? 20, active: !o.off?.includes('large_suv') },
    { key: 'truck', label: o.labels?.truck ?? 'Truck', sort: o.sorts?.truck ?? 30, active: !o.off?.includes('truck') },
  ]
  const services = [
    { id: svc(1), kind: 'package' as const, name: `Verify wash ${ref}`, publicName: null, sort: 1, category: 'wash', active: !o.archived, quoteOnly: false, priceCents: 4000 },
    { id: svc(2), kind: 'addon' as const, name: `Verify wax ${ref}`, publicName: null, sort: 2, category: 'addons', active: true, quoteOnly: false, priceCents: 1500 },
  ]
  const book: PriceBook = {
    classes: classes.filter((c) => c.active).map((c) => ({ key: c.key, label: c.label, sort: c.sort })),
    labels: new Map(classes.map((c) => [c.key, c.label])),
    services: new Map(services.map((s) => [s.id, { id: s.id, kind: s.kind, name: s.name, priceCents: s.priceCents, category: s.category, tags: [], active: s.active, quoteOnly: s.quoteOnly }])),
    cells: new Map([[svc(1), new Map(Object.entries(o.cells))]]),
    tintFilms: [],
  }
  return {
    classes,
    services,
    categories: [
      { key: 'wash', label: `Verify Wash ${ref}`, sort: 1 },
      { key: 'addons', label: `Verify Add-ons ${ref}`, sort: 2 },
    ],
    book,
  }
}

const errCode = (e: unknown): string =>
  e instanceof SquareApiError
    ? `${e.status} ${e.code ?? ''}${e.errors[0]?.detail ? `: ${e.errors[0].detail.replace(/[A-Z0-9]{20,}/g, '<id>').slice(0, 300)}` : ''}`.trim()
    : e instanceof Error
      ? e.message
      : String(e)

export async function sqrItems(o: {
  api: SquareApi
  report: Report
  run: string
  ref: string
  locationId: string
  environment: string
  cleanup: Cleanup
  now: () => Date
}): Promise<void> {
  const { report, ref, locationId } = o
  // every item create Oasis sends, kept so SQR-15 can send one again
  const creates: Array<{ key: Parameters<SquareApi['catalog']['upsert']>[0]; object: Record<string, unknown>; id?: string }> = []
  const api: SquareApi = {
    ...o.api,
    catalog: {
      ...o.api.catalog,
      upsert: async (key, object) => {
        const r = await o.api.catalog.upsert(key, object)
        if (typeof object.id === 'string' && object.id.startsWith('#item-')) creates.push({ key, object: structuredClone(object), id: r.object.id })
        return r
      },
    },
  }
  const store = memoryLinkStore()
  let n = 0
  const newId = () => `20000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
  const rate = 6625
  const taxFor = async (): Promise<TaxCheck> =>
    decideTax(await listTaxes(api), {
      locationId,
      rateDbp: rate,
      rounding: SQUARE_TAX_ROUNDING,
      mode: 'create',
      chosenTaxId: null,
      ownTaxId: store.all().find((l) => l.kind === 'tax' && !l.adopted)?.objectId ?? null,
    })
  const sync = async (lib: LibraryInput, remote?: RemoteView) =>
    runEngine({ api, environment: `${o.environment}-${o.run}`, locationId, lib: desiredLibrary(lib), tax: await taxFor(), store, newId, now: o.now(), remote })
  const itemOf = async (serviceId: string): Promise<WireCatalogObject> => api.catalog.retrieve(store.all().find((l) => l.kind === 'item' && l.serviceId === serviceId)!.objectId!)
  const varOf = (item: WireCatalogObject, classKey: string | null) => item.item_data?.variations?.find((v) => v.item_variation_data?.user_data === markerOf(svc(1), classKey))
  let cleanupAdded = false
  const addCleanup = () => {
    if (cleanupAdded) return
    cleanupAdded = true
    o.cleanup.push({
      what: `verify item library objects (${ref})`,
      run: async () => {
        // items first (their variations go with them), then Oasis's own categories and tax; adopted ones are the shop's
        const mine = store.all().filter((l) => l.objectId && !l.adopted)
        for (const kind of ['item', 'category', 'tax'] as const)
          for (const l of mine.filter((x) => x.kind === kind)) await api.catalog.delete(l.objectId!).catch(() => undefined)
      },
    })
  }
  const base: Record<string, Cell> = { compact_car: { cents: 4000, maxCents: null }, large_suv: { cents: 6000, maxCents: null }, truck: { cents: 7000, maxCents: null } }

  // ---- SQR-15 -------------------------------------------------------------------------------------------------------------------
  let ok15 = false
  try {
    const first = await sync(library(ref, { cells: base }))
    addCleanup()
    const problems: string[] = []
    if (first.status !== 'done' || first.failed) problems.push(`sync ${first.status}: ${first.failures.join('; ') || first.blocked}`)
    if (first.created !== 2) problems.push(`${first.created} items made, expected 2`)
    if (first.taxCreated !== 1) problems.push('the tax was not made')
    const wash = await itemOf(svc(1))
    const prices = (wash.item_data?.variations ?? []).map((v) => `${v.item_variation_data?.name}=${v.item_variation_data?.price_money?.amount}`)
    if (prices.join(',') !== 'Compact car=4000,Large SUV=6000,Truck=7000') problems.push(`variations ${prices.join(',')}`)
    if (wash.present_at_all_locations !== false || JSON.stringify(wash.present_at_location_ids) !== JSON.stringify([locationId])) problems.push('the item is not at our location only')
    const tax = await api.catalog.retrieve(wash.item_data!.tax_ids![0]!)
    if (parseTaxPercent(tax.tax_data?.percentage ?? '') !== rate) problems.push(`the tax is ${tax.tax_data?.percentage}%`)
    // the same key and body again (what the outbox sends after a lost answer): the same item, with its id_mappings
    const sent = creates[creates.length - 1]
    if (!sent) problems.push('no item create was sent')
    else {
      const again = await o.api.catalog.upsert(sent.key, sent.object)
      if (again.object.id !== sent.id) problems.push('the same key and body made a second item')
      const temps = [sent.object.id, ...((sent.object.item_data as { variations?: Array<{ id: string }> }).variations ?? []).map((v) => v.id)]
      if (!temps.every((t) => again.idMappings.some((m) => m.client_object_id === t))) problems.push('id_mappings miss a temp id')
    }
    if (problems.length) report.fail('SQR-15', problems.join('; '))
    else {
      ok15 = true
      report.pass('SQR-15', `2 items (3 sizes and Regular), ${first.categoriesCreated + first.categoriesAdopted} categories and the tax at ${taxPercentLabel(rate)}; the same key and body answered the same item with its id_mappings`)
    }
  } catch (e) {
    report.fail('SQR-15', errCode(e))
  }
  if (!ok15) {
    for (const id of ['SQR-16', 'SQR-17', 'SQR-19']) report.skip(id, 'needs the items of SQR-15')
    return
  }

  // ---- SQR-16 -------------------------------------------------------------------------------------------------------------------
  try {
    const notes: string[] = []
    const problems: string[] = []
    const v0 = varOf(await itemOf(svc(1)), 'compact_car')!
    await sync(library(ref, { cells: { ...base, compact_car: { cents: 4500, maxCents: null } } }))
    const v1 = varOf(await itemOf(svc(1)), 'compact_car')!
    if (v1.id !== v0.id || v1.item_variation_data?.price_money?.amount !== 4500 || (v1.version ?? 0) <= (v0.version ?? 0)) problems.push('the price did not change in place')
    else notes.push('price in place (same id, new version)')
    await sync(library(ref, { cells: { ...base, compact_car: { cents: 4500, maxCents: null } }, labels: { truck: 'Pickup truck' }, sorts: { truck: 5 } }))
    const order = (await itemOf(svc(1))).item_data!.variations!.map((v) => v.item_variation_data?.name).join(',')
    if (order !== 'Pickup truck,Compact car,Large SUV') problems.push(`after rename and reorder: ${order}`)
    else notes.push('renamed and reordered')
    const truck = varOf(await itemOf(svc(1)), 'truck')!
    await sync(library(ref, { cells: { ...base, compact_car: { cents: 4500, maxCents: null } }, labels: { truck: 'Pickup truck' }, off: ['truck'] }))
    const hidden = varOf(await itemOf(svc(1)), 'truck')
    if (!hidden || hidden.id !== truck.id || hidden.present_at_all_locations !== false || (hidden.present_at_location_ids ?? []).length) problems.push('the size turned off was not hidden in place')
    else notes.push('a size off hidden (same id)')
    await sync(library(ref, { cells: { ...base, compact_car: { cents: 4500, maxCents: null } }, labels: { truck: 'Pickup truck' } }))
    const back = varOf(await itemOf(svc(1)), 'truck')
    if (back?.id !== truck.id || !(back.present_at_location_ids ?? []).includes(locationId)) problems.push('the size did not come back with its id')
    await sync(library(ref, { cells: base, archived: true }))
    const archived = (await itemOf(svc(1))).item_data?.is_archived
    await sync(library(ref, { cells: base }))
    const unarchived = (await itemOf(svc(1))).item_data?.is_archived
    if (archived !== true || unarchived !== false) problems.push(`archive ${archived}, unarchive ${unarchived}`)
    else notes.push('archived and back on sale')
    if (problems.length) report.fail('SQR-16', problems.join('; '), undefined, notes)
    else report.pass('SQR-16', notes.join('; '))
  } catch (e) {
    report.fail('SQR-16', errCode(e))
  }

  // ---- SQR-17 -------------------------------------------------------------------------------------------------------------------
  try {
    const notes: string[] = []
    const problems: string[] = []
    const cur = await itemOf(svc(1))
    const staff = await api.catalog.upsert(sqKey('ct', `${o.run}:staff`), {
      ...cur,
      item_data: {
        ...cur.item_data,
        variations: [...cur.item_data!.variations!, {
            type: 'ITEM_VARIATION',
            id: '#staff',
            present_at_all_locations: false,
            present_at_location_ids: [locationId],
            item_variation_data: { item_id: cur.id, name: `Staff special ${ref}`, pricing_type: 'FIXED_PRICING', price_money: usd(1234) },
          }],
      },
    })
    const staffId = staff.idMappings.find((m) => m.client_object_id === '#staff')?.object_id
    await sync(library(ref, { cells: { ...base, large_suv: { cents: 6500, maxCents: null } } }))
    const kept = (await itemOf(svc(1))).item_data!.variations!.find((v) => v.id === staffId)
    if (!kept || kept.item_variation_data?.price_money?.amount !== 1234) problems.push('the staff variation did not survive')
    else notes.push('a staff variation kept')
    // stale: change the name, then send the old version with another name
    const old = await itemOf(svc(1))
    await api.catalog.upsert(sqKey('ct', `${o.run}:rename1`), { ...old, item_data: { ...old.item_data, name: `Verify wash ${ref} B` } })
    try {
      await api.catalog.upsert(sqKey('ct', `${o.run}:rename2`), { ...old, item_data: { ...old.item_data, name: `Verify wash ${ref} C` } })
      problems.push('a stale version changing the same field was accepted')
    } catch (e) {
      if (e instanceof SquareApiError && e.hasCode('VERSION_MISMATCH')) notes.push('stale version: VERSION_MISMATCH')
      else problems.push(`stale version: ${errCode(e)}`)
    }
    // one bad batch among good ones
    let badAnswer = 'accepted'
    try {
      await api.catalog.batchUpsert(sqKey('ct', `${o.run}:badbatch`), [
        [{ type: 'CATEGORY', id: '#good', category_data: { name: `Verify good batch ${ref}` } }],
        [{ type: 'ITEM', id: '#bad', item_data: { name: `Verify bad ${ref}`, variations: [{ type: 'ITEM_VARIATION', id: '#bv', item_variation_data: { item_id: '#bad', name: 'x', pricing_type: 'FIXED_PRICING' } }] } }],
      ])
    } catch (e) {
      badAnswer = errCode(e)
    }
    const good = (await api.catalog.search({ object_types: ['CATEGORY'] })).items.find((c) => c.category_data?.name === `Verify good batch ${ref}`)
    if (good) o.cleanup.push({ what: `verify good-batch category ${good.id}`, run: () => api.catalog.delete(good.id) })
    notes.push(`a BatchUpsert with a bad batch: ${badAnswer}, the good batch ${good ? 'KEPT' : 'not kept'}`)
    // Oasis's sync, reading the item back (as the 5-minute run does with what changed), puts the name back
    const renamed = await itemOf(svc(1))
    const back = await sync(library(ref, { cells: { ...base, large_suv: { cents: 6500, maxCents: null } } }), { items: new Map([[renamed.id, renamed]]), categories: new Map(), gone: new Set() })
    notes.push(`put back: ${back.changedInSquare.join('; ') || 'nothing'}`)
    if ((await itemOf(svc(1))).item_data?.name !== `Verify wash ${ref}`) problems.push('the Square-side rename was not put back')
    if (problems.length) report.fail('SQR-17', problems.join('; '), undefined, notes)
    else report.pass('SQR-17', notes.join('; '))
  } catch (e) {
    report.fail('SQR-17', errCode(e))
  }

  // ---- SQR-19 -------------------------------------------------------------------------------------------------------------------
  try {
    const problems: string[] = []
    const cells = { compact_car: { cents: 0, maxCents: null }, large_suv: { cents: 22_900, maxCents: 27_900 }, truck: { cents: 7000, maxCents: null } }
    const r = await sync(library(ref, { cells }))
    if (r.failed) problems.push(r.failures.join('; '))
    const item = await itemOf(svc(1))
    const free = varOf(item, 'compact_car')
    const range = varOf(item, 'large_suv')
    if (free?.item_variation_data?.pricing_type !== 'FIXED_PRICING' || free.item_variation_data.price_money?.amount !== 0) problems.push('the $0 price is not FIXED 0')
    if (range?.item_variation_data?.pricing_type !== 'VARIABLE_PRICING' || range.item_variation_data.price_money) problems.push('the range is not VARIABLE without a price')
    if (range?.item_variation_data?.name !== 'Large SUV · $229–$279') problems.push(`the range is named ${range?.item_variation_data?.name}`)
    const calc = await api.orders.calculate({
      location_id: locationId,
      pricing_options: { auto_apply_taxes: true },
      line_items: [
        { quantity: '1', catalog_object_id: range!.id, base_price_money: usd(25_000) },
        { quantity: '1', catalog_object_id: free!.id },
        { quantity: '1', catalog_object_id: varOf(item, 'truck')!.id },
      ],
    })
    const want = salesTaxCents(32_000, { dbp: rate, rounding: SQUARE_TAX_ROUNDING })
    if (calc.total_tax_money?.amount !== want) problems.push(`CalculateOrder tax ${calc.total_tax_money?.amount}, Oasis ${want}`)
    if (problems.length) report.fail('SQR-19', problems.join('; '))
    else report.pass('SQR-19', `a range is VARIABLE ("Large SUV · $229–$279", the amount rung up), $0 is FIXED 0; CalculateOrder of $250 + $0 + $70 with the catalog tax: ${want}¢ = Oasis's`)
    // what the planner sees now: nothing to do
    const left = planItems(desiredLibrary(library(ref, { cells })), { locationId, links: store.all() }).length + planSetup(desiredLibrary(library(ref, { cells })), store.all(), await taxFor()).length
    if (left) report.note(`SQR-19: the planner still finds ${left} action(s) after the run`)
  } catch (e) {
    report.fail('SQR-19', errCode(e))
  }
}

/** SQR-20 (read-only): the shop's taxes against Oasis's rate and the item count, the pre-flight before the sync goes on. */
export async function sqr20(o: { api: SquareApi; report: Report; locationId: string; rateDbp: number }): Promise<void> {
  try {
    const taxes = await listTaxes(o.api)
    const t = decideTax(taxes, { locationId: o.locationId, rateDbp: o.rateDbp, rounding: SQUARE_TAX_ROUNDING, mode: 'auto', chosenTaxId: null, ownTaxId: null })
    let items = 0
    let cursor: string | undefined
    for (let i = 0; i < 100; i++) {
      const page = await o.api.catalog.search({ object_types: ['ITEM'], cursor })
      items += page.items.length
      cursor = page.cursor
      if (!cursor) break
    }
    const evidence = [
      `taxes at the location: ${t.candidates.map((c) => `${c.name} ${c.percentage ?? '?'}%${c.matches ? ' (matches)' : ` (${c.problem})`}`).join('; ') || 'none'}`,
      `items in the library: ${items}`,
      'what the sync would create: Settings, Billing & integrations, Square item library, "Sync now" while watch-only (the preview)',
    ]
    const detail = `Oasis ${squarePercent(o.rateDbp)}%: ${t.detail}; ${items} item(s) in Square's library`
    if (t.status === 'ok' || t.status === 'create') o.report.pass('SQR-20', detail, evidence)
    else o.report.fail('SQR-20', detail, 'make the shop’s Square tax the same percentage, added to the price, at the shop (or pick the tax in Settings)', evidence)
  } catch (e) {
    o.report.fail('SQR-20', errCode(e))
  }
}
