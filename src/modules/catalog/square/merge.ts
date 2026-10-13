// The item body Oasis sends to Square (ADR 0172), pure. UpsertCatalogObject REPLACES an item, and a variation left out of it is
// deleted (sandbox 2026-10-13), so an update is read-modify-write: Oasis lays the fields it owns over the item as just read from
// Square and keeps everything else as Square has it (pictures, descriptions, modifier lists, colours, Square's own fields, and every
// variation staff added). Fields Oasis owns:
//   item       name, buyer_facing_name, categories (its Oasis category and "Oasis"), reporting_category, tax_ids, is_taxable,
//              is_archived, presence (our location only), the order of its own variations;
//   variation  name, pricing_type, price_money, presence (our location, or nowhere when hidden), user_data (the marker), and no
//              price override at our location.
// The versions of the item and of every nested variation are the ones just read: Square checks them per field, nested ones too.
// ownedDiff says, in plain words, where Square's copy differs from what Oasis wants (empty: in step).
import type { WireCatalogObject, WireItemData, WireNestedVariation } from '../../../integrations/square/wire.js'
import { parseMarker, type DesiredItem, type DesiredVariation, type ItemRefs } from './desired.js'

type Obj = Record<string, unknown>

export const tempItemId = (serviceId: string): string => `#item-${serviceId}`
export const tempVariationId = (serviceId: string, classKey: string | null): string => `#var-${serviceId}-${classKey ?? 'base'}`

export interface MergeContext {
  /** The Square location Oasis sells at. */
  locationId: string
  refs: ItemRefs
  /** The variation ids Oasis linked for this service, by size key ('' = Regular). */
  linkedVariations: ReadonlyMap<string, string>
}

const sizeKey = (classKey: string | null): string => classKey ?? ''
const usd = (amount: number) => ({ amount, currency: 'USD' })

/** The Oasis variation of a remote item for a size: by its link, else by its marker. */
function remoteVariationFor(remote: readonly WireNestedVariation[], serviceId: string, classKey: string | null, linked: ReadonlyMap<string, string>): WireNestedVariation | undefined {
  const id = linked.get(sizeKey(classKey))
  if (id) {
    const v = remote.find((x) => x.id === id && !x.is_deleted)
    if (v) return v
  }
  return remote.find((x) => {
    const m = parseMarker(x.item_variation_data?.user_data)
    return !x.is_deleted && m?.serviceId === serviceId && m.classKey === classKey
  })
}

/** A remote variation is Oasis's own: linked to this service, or carrying this service's marker. */
function isOurs(v: WireNestedVariation, serviceId: string, linked: ReadonlyMap<string, string>): boolean {
  if ([...linked.values()].includes(v.id)) return true
  return parseMarker(v.item_variation_data?.user_data)?.serviceId === serviceId
}

function variationData(base: Obj, d: DesiredVariation, itemId: string, locationId: string): Obj {
  const data: Obj = { ...base, item_id: itemId, name: d.name, user_data: d.marker }
  if (d.pricing.type === 'FIXED') {
    data.pricing_type = 'FIXED_PRICING'
    data.price_money = usd(d.pricing.cents)
  } else {
    data.pricing_type = 'VARIABLE_PRICING'
    delete data.price_money
  }
  // a price of its own at our location would not be Oasis's price: cleared (anything else staff set there, such as inventory, stays)
  const overrides = ((data.location_overrides as Obj[] | undefined) ?? []).flatMap((o) => {
    if (o.location_id !== locationId) return [o]
    const rest: Obj = { ...o }
    delete rest.price_money
    delete rest.pricing_type
    return Object.keys(rest).some((k) => k !== 'location_id') ? [rest] : []
  })
  if (overrides.length) data.location_overrides = overrides
  else delete data.location_overrides
  return data
}

const presence = (present: boolean, locationId: string): Obj => ({ present_at_all_locations: false, present_at_location_ids: present ? [locationId] : [] })

function withPresence(o: Obj, present: boolean, locationId: string): Obj {
  const out: Obj = { ...o, ...presence(present, locationId) }
  delete out.absent_at_location_ids
  return out
}

function categoryList(refs: ItemRefs, current: WireItemData['categories']): Obj[] {
  const want = [refs.categoryId, refs.oasisCategoryId].filter((x): x is string => !!x)
  return want.map((id) => {
    const keep = current?.find((c) => c.id === id)
    return keep ? { ...keep } : { id }
  })
}

/** The body of a new item: every present variation, temp ids, REGULAR (product_type can never change later). */
export function newItemBody(item: DesiredItem, ctx: MergeContext): Obj {
  const itemId = tempItemId(item.serviceId)
  return {
    type: 'ITEM',
    id: itemId,
    ...presence(true, ctx.locationId),
    item_data: {
      name: item.name,
      ...(item.buyerFacingName ? { buyer_facing_name: item.buyerFacingName } : {}),
      product_type: 'REGULAR',
      is_taxable: true,
      tax_ids: ctx.refs.taxId ? [ctx.refs.taxId] : [],
      categories: categoryList(ctx.refs, null),
      ...(ctx.refs.categoryId ? { reporting_category: { id: ctx.refs.categoryId } } : {}),
      is_archived: item.archived,
      variations: item.variations
        .filter((v) => v.present)
        .map((v) => ({
          type: 'ITEM_VARIATION',
          id: tempVariationId(item.serviceId, v.classKey),
          ...presence(true, ctx.locationId),
          item_variation_data: variationData({}, v, itemId, ctx.locationId),
        })),
    },
  }
}

/**
 * The update of an existing item: Oasis's fields over Square's copy. Oasis's variations come first in Oasis's order (linked ones
 * keep their id and version; a size that is off is hidden, never left out); the variations staff added follow, untouched.
 */
export function mergeItemBody(item: DesiredItem, remote: WireCatalogObject, ctx: MergeContext): Obj {
  const rd = (remote.item_data ?? {}) as WireItemData
  const remoteVars = (rd.variations ?? []).filter((v) => !v.is_deleted)
  const used = new Set<string>()
  const ours: Obj[] = []
  for (const d of item.variations) {
    const rv = remoteVariationFor(remoteVars, item.serviceId, d.classKey, ctx.linkedVariations)
    if (rv && !used.has(rv.id)) {
      used.add(rv.id)
      ours.push(withPresence({ ...rv, item_variation_data: variationData({ ...(rv.item_variation_data ?? {}) }, d, remote.id, ctx.locationId) }, d.present, ctx.locationId))
    } else if (d.present)
      ours.push({
        type: 'ITEM_VARIATION',
        id: tempVariationId(item.serviceId, d.classKey),
        ...presence(true, ctx.locationId),
        item_variation_data: variationData({}, d, remote.id, ctx.locationId),
      })
  }
  // Oasis's variations of a size that no longer exists: kept, hidden
  for (const rv of remoteVars) {
    if (used.has(rv.id) || !isOurs(rv, item.serviceId, ctx.linkedVariations)) continue
    used.add(rv.id)
    ours.push(withPresence({ ...rv }, false, ctx.locationId))
  }
  const staff = remoteVars.filter((v) => !used.has(v.id)).map((v) => ({ ...v }) as Obj)
  const data: Obj = {
    ...rd,
    name: item.name,
    is_taxable: true,
    tax_ids: ctx.refs.taxId ? [ctx.refs.taxId] : [],
    categories: categoryList(ctx.refs, rd.categories),
    is_archived: item.archived,
    variations: [...ours, ...staff],
  }
  if (item.buyerFacingName) data.buyer_facing_name = item.buyerFacingName
  else delete data.buyer_facing_name
  if (ctx.refs.categoryId) data.reporting_category = rd.reporting_category?.id === ctx.refs.categoryId ? { ...rd.reporting_category } : { id: ctx.refs.categoryId }
  else delete data.reporting_category
  const out = withPresence({ ...remote, item_data: data }, true, ctx.locationId)
  delete out.updated_at
  delete out.created_at
  delete out.is_deleted
  return out
}

const money = (c: number | null | undefined): string => (c === null || c === undefined ? 'no price' : c % 100 === 0 ? `$${c / 100}` : `$${(c / 100).toFixed(2)}`)
const presentHere = (o: { present_at_all_locations?: boolean | null; present_at_location_ids?: readonly string[] | null; absent_at_location_ids?: readonly string[] | null }, loc: string): boolean =>
  o.present_at_all_locations !== false ? !(o.absent_at_location_ids ?? []).includes(loc) : (o.present_at_location_ids ?? []).includes(loc)
const onlyHere = (o: { present_at_all_locations?: boolean | null; present_at_location_ids?: readonly string[] | null }, loc: string): boolean =>
  o.present_at_all_locations === false && (o.present_at_location_ids ?? []).length === 1 && o.present_at_location_ids![0] === loc
const nowhere = (o: { present_at_all_locations?: boolean | null; present_at_location_ids?: readonly string[] | null }): boolean =>
  o.present_at_all_locations === false && (o.present_at_location_ids ?? []).length === 0

/**
 * Where Square's copy of an item differs from what Oasis wants, in plain words ("Signature Hand Wash · Large SUV was $45"); empty when
 * it is in step. The same comparison decides whether an update is needed after a read-back.
 */
export function ownedDiff(item: DesiredItem, remote: WireCatalogObject, ctx: MergeContext): string[] {
  const out: string[] = []
  const rd = (remote.item_data ?? {}) as WireItemData
  const name = item.name
  if (remote.is_deleted) return [`${name} was deleted in Square`]
  if (rd.name !== item.name) out.push(`${name} was named “${rd.name ?? ''}” in Square`)
  if ((rd.buyer_facing_name ?? null) !== item.buyerFacingName) out.push(`${name} had another customer-facing name in Square`)
  if ((rd.is_archived ?? false) !== item.archived) out.push(item.archived ? `${name} was put back on sale in Square` : `${name} was archived in Square`)
  if (!onlyHere(remote, ctx.locationId)) out.push(`${name} was set to show at other locations`)
  const wantTax = ctx.refs.taxId ? [ctx.refs.taxId] : []
  if (JSON.stringify(rd.tax_ids ?? []) !== JSON.stringify(wantTax) || rd.is_taxable === false) out.push(`${name} had another tax in Square`)
  const wantCats = [ctx.refs.categoryId, ctx.refs.oasisCategoryId].filter(Boolean)
  if (JSON.stringify((rd.categories ?? []).map((c) => c.id)) !== JSON.stringify(wantCats) || (ctx.refs.categoryId && rd.reporting_category?.id !== ctx.refs.categoryId))
    out.push(`${name} was moved to another category in Square`)
  const remoteVars = (rd.variations ?? []).filter((v) => !v.is_deleted)
  const order: string[] = []
  for (const d of item.variations) {
    const rv = remoteVariationFor(remoteVars, item.serviceId, d.classKey, ctx.linkedVariations)
    const label = `${name} · ${d.name}`
    if (!rv) {
      if (d.present) out.push(`${label} is missing in Square`)
      continue
    }
    order.push(rv.id)
    const vd = rv.item_variation_data ?? {}
    if (vd.name !== d.name) out.push(`${name} · “${vd.name ?? ''}” was renamed in Square (Oasis calls it ${d.name})`)
    if (d.pricing.type === 'FIXED') {
      if (vd.pricing_type !== 'FIXED_PRICING' || vd.price_money?.amount !== d.pricing.cents)
        out.push(`${label} was ${vd.pricing_type === 'VARIABLE_PRICING' ? 'priced when sold' : money(vd.price_money?.amount)} in Square; Oasis charges ${money(d.pricing.cents)}`)
    } else if (vd.pricing_type !== 'VARIABLE_PRICING') out.push(`${label} had a fixed price in Square (${money(vd.price_money?.amount)})`)
    if (d.present ? !onlyHere(rv, ctx.locationId) : !nowhere(rv)) out.push(d.present ? `${label} was hidden or moved in Square` : `${label} was shown again in Square`)
    if (vd.user_data !== d.marker) out.push(`${label} lost its Oasis marker`)
    const override = (vd.location_overrides ?? []).find((o) => o.location_id === ctx.locationId && (o.price_money || o.pricing_type))
    if (override) out.push(`${label} had its own price at the shop (${money(override.price_money?.amount)})`)
  }
  // Oasis variations of sizes that no longer exist must be hidden
  for (const rv of remoteVars)
    if (!order.includes(rv.id) && isOurs(rv, item.serviceId, ctx.linkedVariations) && presentHere(rv, ctx.locationId))
      out.push(`${name} · ${rv.item_variation_data?.name ?? 'a size'} is still on sale in Square`)
  // Oasis's own variations come first, in Oasis's order
  const ourIds = remoteVars.filter((v) => order.includes(v.id) || isOurs(v, item.serviceId, ctx.linkedVariations)).map((v) => v.id)
  const firstIds = remoteVars.slice(0, order.length).map((v) => v.id)
  if (order.length && JSON.stringify(firstIds) !== JSON.stringify(order) && ourIds.length) out.push(`${name}: the sizes were reordered in Square`)
  return out
}
