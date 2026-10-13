// The simulator's item library (ADR 0172, sandbox 2026-10-13): what UpsertCatalogObject, BatchUpsertCatalogObjects,
// RetrieveCatalogObject, BatchRetrieveCatalogObjects, SearchCatalogObjects and DeleteCatalogObject do with ITEM, ITEM_VARIATION,
// CATEGORY, TAX and the subscription plans, the way the sandbox answered (docs/integrations/square.md section 14):
//   - an ITEM carries its variations nested in item_data.variations; they are stored as their own objects, their temp ids resolved,
//     their item_id set; a variation left out of an item upsert is DELETED (RetrieveCatalogObject answers 404 NOT_FOUND, a batch
//     retrieve with include_deleted_objects shows it is_deleted);
//   - versions are checked like Square: an existing object without a version is VERSION_MISMATCH; a version that is not the latest
//     is accepted only when no field the request changes was changed since that version (per field, three-way), on nested variations
//     too; an upsert that changes nothing keeps the version; one batch writes one new version;
//   - presence: present_at_all_locations (default true) or a list of location ids (empty = present nowhere: a hidden variation); a
//     CATEGORY cannot be scoped to locations (INVALID_VALUE "Unexpected unit-overridden attribute");
//   - FIXED_PRICING needs price_money; VARIABLE_PRICING has none; item_data.is_archived is kept; category ordinals are Square's own;
//   - BatchUpsert: each batch all or nothing, but a failing batch fails the whole answer (400) while the other batches are KEPT.
import { randomBytes } from 'node:crypto'

type Obj = Record<string, unknown>
type Money = { amount: number; currency: string }

export class SimCatalogError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail: string,
    readonly field?: string,
  ) {
    super(detail)
  }
}

const B32 = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
function rid(n: number): string {
  const b = randomBytes(n)
  let s = ''
  for (let i = 0; i < n; i++) s += B32[b[i]! % 32]
  return s
}
const clone = <T>(v: T): T => structuredClone(v)
const isTemp = (id: unknown): id is string => typeof id === 'string' && id.startsWith('#')
const META = new Set(['id', 'type', 'version', 'updated_at', 'created_at', 'is_deleted'])
const KNOWN_TYPES = new Set(['ITEM', 'ITEM_VARIATION', 'CATEGORY', 'TAX', 'SUBSCRIPTION_PLAN', 'SUBSCRIPTION_PLAN_VARIATION'])

const invalid = (detail: string, field?: string): SimCatalogError => new SimCatalogError(400, 'INVALID_VALUE', detail, field)
const mismatch = (detail = 'Object version does not match latest database version.'): SimCatalogError =>
  new SimCatalogError(400, 'VERSION_MISMATCH', detail)

/**
 * The fields of an object, the way Square's per-field version check sees them: the top-level fields and each field of its *_data
 * (an item's nested variations are objects of their own and are left out).
 */
export function fieldsOf(o: Obj): Map<string, string> {
  const out = new Map<string, string>()
  for (const [k, v] of Object.entries(o)) {
    if (META.has(k) || v === undefined) continue
    if (k.endsWith('_data') && v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [k2, v2] of Object.entries(v as Obj)) {
        if (v2 === undefined || (k === 'item_data' && k2 === 'variations')) continue
        out.set(`${k}.${k2}`, JSON.stringify(v2))
      }
    } else out.set(k, JSON.stringify(v))
  }
  return out
}

/** The field paths whose values differ between two objects. */
function changedFields(a: Obj, b: Obj): Set<string> {
  const fa = fieldsOf(a)
  const fb = fieldsOf(b)
  const out = new Set<string>()
  for (const k of new Set([...fa.keys(), ...fb.keys()])) if (fa.get(k) !== fb.get(k)) out.add(k)
  return out
}

/** Applies the given field paths of `from` onto a copy of `to` (Square keeps the latest value of every field the request left alone). */
function applyFields(to: Obj, from: Obj, fields: Set<string>): Obj {
  const out = clone(to)
  for (const f of fields) {
    const [k, k2] = f.split('.') as [string, string | undefined]
    if (k2 === undefined) {
      if (from[k] === undefined) delete out[k]
      else out[k] = clone(from[k])
      continue
    }
    const src = (from[k] ?? {}) as Obj
    const dst = ((out[k] as Obj | undefined) ?? {}) as Obj
    if (src[k2] === undefined) delete dst[k2]
    else dst[k2] = clone(src[k2])
    out[k] = dst
  }
  return out
}

const sameContent = (a: Obj, b: Obj): boolean => changedFields(a, b).size === 0

/** The percentage of a tax as Square takes it: a decimal string from 0 to 100. */
const PERCENT = /^(100(\.0+)?|\d{1,2}(\.\d{1,8})?)$/

export interface SimCatalogHost {
  locationId: string
  now(): Date
  /** Ids of plan variations a subscription uses (Square refuses to delete those). */
  inUse(variationIds: readonly string[]): boolean
}

export class SimCatalog {
  /** Live objects by id; an ITEM is kept without its nested variations (see variationIds). */
  readonly objects = new Map<string, Obj>()
  /** Deleted objects (their last content, is_deleted true): found by a batch retrieve or a search with include_deleted_objects. */
  readonly deleted = new Map<string, Obj>()
  /** item id -> its variations' ids, in order. */
  private readonly variationIds = new Map<string, string[]>()
  /** id -> version -> content: what Square's per-field version check compares with. */
  private readonly history = new Map<string, Map<number, Obj>>()
  private lastVersion = 0

  constructor(private readonly host: SimCatalogHost) {}

  private nextVersion(): number {
    this.lastVersion = Math.max(this.lastVersion + 1, this.host.now().getTime())
    return this.lastVersion
  }

  private iso(): string {
    return this.host.now().toISOString()
  }

  /** An object as Square answers it: an ITEM with its variations nested. */
  view(id: string): Obj | undefined {
    const o = this.objects.get(id)
    if (!o) return undefined
    if (o.type !== 'ITEM') return clone(o)
    const out = clone(o)
    const data = (out.item_data ?? {}) as Obj
    data.variations = (this.variationIds.get(id) ?? []).flatMap((v) => {
      const vo = this.objects.get(v)
      return vo ? [clone(vo)] : []
    })
    out.item_data = data
    return out
  }

  private remember(o: Obj): void {
    let h = this.history.get(String(o.id))
    if (!h) this.history.set(String(o.id), (h = new Map()))
    h.set(Number(o.version), clone(o))
    if (h.size > 50) h.delete(h.keys().next().value!)
  }

  /** Every batch is applied on its own (all or nothing); the first failure is thrown after the others were kept. */
  upsert(batches: Obj[][]): { objects: Obj[]; id_mappings: Obj[] } {
    const objects: Obj[] = []
    const mappings: Obj[] = []
    let failure: SimCatalogError | undefined
    for (const batch of batches) {
      try {
        const r = this.applyBatch(batch)
        objects.push(...r.objects)
        mappings.push(...r.mappings)
      } catch (e) {
        if (!(e instanceof SimCatalogError)) throw e
        failure ??= e
      }
    }
    if (failure) throw failure
    return { objects, id_mappings: mappings }
  }

  private applyBatch(batch: Obj[]): { objects: Obj[]; mappings: Obj[] } {
    if (batch.length === 0) throw new SimCatalogError(400, 'MISSING_REQUIRED_PARAMETER', 'A batch needs at least one object.')
    // 1. flatten the nested variations, give every temp id its real id
    const temp = new Map<string, string>()
    const flat: Obj[] = []
    const nestedOf = new Map<string, string[]>() // item ref (temp or real) -> its variation refs, in order (when the item lists them)
    for (const raw of batch) {
      const o = clone(raw)
      if (typeof o.id !== 'string' || !o.id) throw new SimCatalogError(400, 'MISSING_REQUIRED_PARAMETER', 'Every object needs an id.', 'id')
      if (isTemp(o.id) && !temp.has(o.id)) temp.set(o.id, rid(24))
      if (o.type === 'ITEM') {
        const data = (o.item_data ?? {}) as Obj
        const nested = data.variations as Obj[] | undefined
        delete data.variations
        o.item_data = data
        if (nested !== undefined) {
          const refs: string[] = []
          for (const v of nested) {
            const vv = clone(v)
            if (vv.type !== 'ITEM_VARIATION') throw invalid('item_data.variations holds ITEM_VARIATION objects only.')
            if (typeof vv.id !== 'string' || !vv.id) throw new SimCatalogError(400, 'MISSING_REQUIRED_PARAMETER', 'Every variation needs an id.')
            if (isTemp(vv.id) && !temp.has(vv.id)) temp.set(vv.id, rid(24))
            const d = (vv.item_variation_data ?? {}) as Obj
            d.item_id ??= o.id
            vv.item_variation_data = d
            refs.push(vv.id)
            flat.push(vv)
          }
          nestedOf.set(o.id, refs)
        }
      }
      flat.push(o)
    }
    const real = (v: unknown): unknown => (isTemp(v) ? (temp.get(v) ?? v) : v)
    const batchTypes = new Map(flat.map((o) => [String(real(o.id)), String(o.type)]))
    const typeOf = (id: unknown): string | undefined => batchTypes.get(String(id)) ?? (this.objects.get(String(id))?.type as string | undefined)
    // 2. resolve references and check each object against what is stored
    const version = this.nextVersion()
    const staged = new Map<string, Obj>()
    const order: string[] = []
    for (const o of flat) {
      const id = String(real(o.id))
      const type = String(o.type)
      if (!KNOWN_TYPES.has(type)) throw invalid(`The simulator does not keep catalog objects of type ${type}.`)
      const isNew = isTemp(o.id)
      const existing = isNew ? undefined : this.objects.get(id)
      if (!isNew && !existing) throw new SimCatalogError(404, 'NOT_FOUND', `Catalog object \`${id}\` not found.`)
      if (existing && existing.type !== type) throw invalid(`Object \`${id}\` is a ${String(existing.type)}, not a ${type}.`)
      const body: Obj = { ...o, id, type }
      this.resolveRefs(body, real)
      this.validate(body, existing, typeOf)
      let next: Obj = body
      if (existing) {
        if (body.version === undefined || body.version === null) throw mismatch()
        if (body.version !== existing.version) {
          const base = this.history.get(id)?.get(Number(body.version))
          if (!base) throw mismatch()
          const mine = changedFields(base, body)
          const theirs = changedFields(base, existing)
          const both = [...mine].filter((f) => theirs.has(f))
          if (both.length)
            throw mismatch(`Object version does not match latest database version. Field \`${both[0]!.split('.').pop()}\` was modified concurrently.`)
          next = applyFields(existing, body, mine)
        }
      }
      staged.set(id, this.normalize(next))
      order.push(id)
    }
    // 3. the variation lists of the items of this batch, and what they drop
    const newLists = new Map<string, string[]>()
    for (const [itemRef, refs] of nestedOf) newLists.set(String(real(itemRef)), refs.map((r) => String(real(r))))
    for (const [id, o] of staged) {
      if (o.type !== 'ITEM_VARIATION') continue
      const itemId = String((o.item_variation_data as Obj).item_id ?? '')
      const item = staged.get(itemId) ?? this.objects.get(itemId)
      if (!item || item.type !== 'ITEM') throw invalid(`item_id of variation \`${id}\` must name an ITEM.`, 'item_id')
      // a variation cannot be present where its item is not (sandbox 2026-10-13)
      if (item.present_at_all_locations === false) {
        if (o.present_at_all_locations !== false)
          throw invalid(`[object_id=${id}] Object \`${id}\` of type ITEM_VARIATION is enabled at all future locations, but the referenced object with token \`${itemId}\` of type ITEM is not.`)
        const at = new Set((item.present_at_location_ids as string[] | undefined) ?? [])
        const extra = ((o.present_at_location_ids as string[] | undefined) ?? []).find((l) => !at.has(l))
        if (extra)
          throw invalid(`[object_id=${id}] Object \`${id}\` of type ITEM_VARIATION is enabled at location ${extra}, but the referenced object with token \`${itemId}\` of type ITEM is not.`)
      }
      if (!newLists.has(itemId)) {
        // a variation upserted on its own joins its item's list
        const list = [...(this.variationIds.get(itemId) ?? [])]
        if (!list.includes(id)) list.push(id)
        newLists.set(itemId, list)
      }
    }
    for (const [itemId] of newLists) {
      const item = staged.get(itemId) ?? this.objects.get(itemId)
      if (!item) continue
      if ((newLists.get(itemId) ?? []).length === 0) throw invalid('An item needs at least one variation.', 'variations')
    }
    // 4. commit: unchanged objects keep their version; one new version for everything that changed
    const now = this.iso()
    const out: string[] = []
    const changedItems = new Set<string>()
    for (const id of order) {
      if (out.includes(id)) continue
      out.push(id)
      const o = staged.get(id)!
      const existing = this.objects.get(id)
      if (o.type === 'ITEM_VARIATION') {
        const itemId = String((o.item_variation_data as Obj).item_id)
        const list = newLists.get(itemId) ?? this.variationIds.get(itemId) ?? []
        ;(o.item_variation_data as Obj).ordinal = Math.max(0, list.indexOf(id))
      }
      if (existing && sameContent(existing, o)) continue
      const stored = { ...o, version, updated_at: now, created_at: existing?.created_at ?? now, is_deleted: false }
      this.objects.set(id, stored)
      this.remember(stored)
      if (o.type === 'ITEM_VARIATION') changedItems.add(String((o.item_variation_data as Obj).item_id))
    }
    for (const [itemId, list] of newLists) {
      const before = this.variationIds.get(itemId) ?? []
      for (const gone of before.filter((v) => !list.includes(v))) {
        this.tombstone(gone, version, now)
        changedItems.add(itemId)
      }
      if (before.join() !== list.join()) changedItems.add(itemId)
      this.variationIds.set(itemId, list)
      // ordinals follow the list
      list.forEach((v, i) => {
        const vo = this.objects.get(v)
        if (vo && (vo.item_variation_data as Obj).ordinal !== i) (vo.item_variation_data as Obj).ordinal = i
      })
    }
    // an item whose variations changed gets the new version too (sandbox: item and changed variations share it)
    for (const itemId of changedItems) {
      const item = this.objects.get(itemId)
      if (item && item.version !== version) {
        const stored = { ...item, version, updated_at: now }
        this.objects.set(itemId, stored)
        this.remember(stored)
      }
    }
    const mappings = [...temp.entries()].map(([client_object_id, object_id]) => ({ client_object_id, object_id }))
    const top = batch.map((o) => String(real(o.id))).filter((id, i, a) => a.indexOf(id) === i)
    return { objects: top.map((id) => this.view(id)!).filter(Boolean), mappings }
  }

  private resolveRefs(o: Obj, real: (v: unknown) => unknown): void {
    if (o.type === 'ITEM_VARIATION') {
      const d = (o.item_variation_data ?? {}) as Obj
      d.item_id = real(d.item_id)
      o.item_variation_data = d
    } else if (o.type === 'ITEM') {
      const d = (o.item_data ?? {}) as Obj
      if (Array.isArray(d.tax_ids)) d.tax_ids = (d.tax_ids as unknown[]).map(real)
      if (Array.isArray(d.categories)) d.categories = (d.categories as Obj[]).map((c) => ({ ...c, id: real(c.id) }))
      if (d.reporting_category && typeof d.reporting_category === 'object') d.reporting_category = { ...(d.reporting_category as Obj), id: real((d.reporting_category as Obj).id) }
      o.item_data = d
    } else if (o.type === 'SUBSCRIPTION_PLAN_VARIATION') {
      const d = (o.subscription_plan_variation_data ?? {}) as Obj
      d.subscription_plan_id = real(d.subscription_plan_id)
      o.subscription_plan_variation_data = d
    }
  }

  private validate(o: Obj, existing: Obj | undefined, typeOf: (id: unknown) => string | undefined): void {
    const loc = this.host.locationId
    const ids = o.present_at_location_ids as unknown[] | undefined
    if (ids?.some((x) => x !== loc)) throw invalid(`Location \`${String(ids.find((x) => x !== loc))}\` is not one of the merchant's locations.`, 'present_at_location_ids')
    switch (o.type) {
      case 'ITEM': {
        const d = (o.item_data ?? {}) as Obj
        if (typeof d.name !== 'string' || !d.name.trim()) throw new SimCatalogError(400, 'MISSING_REQUIRED_PARAMETER', 'item_data.name is required.', 'name')
        if (d.name.length > 512) throw invalid('item_data.name is longer than 512 characters.', 'name')
        const prior = (existing?.item_data as Obj | undefined)?.product_type
        if (prior && d.product_type && d.product_type !== prior) throw invalid('product_type cannot be changed.', 'product_type')
        for (const t of (d.tax_ids as unknown[] | undefined) ?? [])
          if (typeOf(t) !== 'TAX') throw invalid(`tax_ids: \`${String(t)}\` is not a TAX.`, 'tax_ids')
        for (const c of [...((d.categories as Obj[] | undefined) ?? []), ...(d.reporting_category ? [d.reporting_category as Obj] : [])])
          if (typeOf(c.id) !== 'CATEGORY') throw invalid(`categories: \`${String(c.id)}\` is not a CATEGORY.`, 'categories')
        break
      }
      case 'ITEM_VARIATION': {
        const d = (o.item_variation_data ?? {}) as Obj
        if (typeof d.name === 'string' && d.name.length > 255) throw invalid('item_variation_data.name is longer than 255 characters.', 'name')
        if ((d.pricing_type ?? 'FIXED_PRICING') === 'FIXED_PRICING') {
          if (!d.price_money) throw invalid(`[object_id=${String(o.id)}] Variation with FIXED_PRICING pricing type missing global price value.`, 'price')
          moneyOk(d.price_money)
        } else if (d.pricing_type === 'VARIABLE_PRICING') delete d.price_money
        else throw invalid(`pricing_type ${String(d.pricing_type)} is not supported.`, 'pricing_type')
        if (typeof d.user_data === 'string' && d.user_data.length > 255) throw invalid('user_data is longer than 255 characters.', 'user_data')
        break
      }
      case 'CATEGORY': {
        if (o.present_at_all_locations === false || o.present_at_location_ids !== undefined)
          throw invalid(`[object_id=${String(o.id)}] Unexpected unit-overridden attribute for definition present_at_all_locations at unit ${loc} on object ${String(o.id)} of type CATEGORY.`)
        const d = (o.category_data ?? {}) as Obj
        if (typeof d.name !== 'string' || !d.name.trim()) throw new SimCatalogError(400, 'MISSING_REQUIRED_PARAMETER', 'category_data.name is required.', 'name')
        break
      }
      case 'TAX': {
        const d = (o.tax_data ?? {}) as Obj
        if (typeof d.name !== 'string' || !d.name.trim()) throw new SimCatalogError(400, 'MISSING_REQUIRED_PARAMETER', 'tax_data.name is required.', 'name')
        if (d.percentage !== undefined && (typeof d.percentage !== 'string' || !PERCENT.test(d.percentage))) throw invalid('tax_data.percentage must be a decimal from 0 to 100.', 'percentage')
        break
      }
      case 'SUBSCRIPTION_PLAN_VARIATION': {
        const d = (o.subscription_plan_variation_data ?? {}) as Obj
        if (typeOf(d.subscription_plan_id) !== 'SUBSCRIPTION_PLAN') throw invalid('subscription_plan_id must name a SUBSCRIPTION_PLAN.')
        const phases = (d.phases as Obj[] | undefined) ?? []
        if (!phases.length) throw new SimCatalogError(400, 'MISSING_REQUIRED_PARAMETER', 'phases is required.')
        for (const ph of phases) {
          const pricing = (ph.pricing ?? {}) as Obj
          if (pricing.type === 'STATIC') {
            moneyOk(pricing.price_money)
            pricing.price = pricing.price_money
          }
          ph.uid ??= rid(22)
        }
        break
      }
    }
  }

  /** Square's defaults and its own fields: presence, sellable/stockable, category ordinals. */
  private normalize(o: Obj): Obj {
    const out = clone(o)
    delete out.version
    delete out.updated_at
    delete out.created_at
    delete out.is_deleted
    if (out.type !== 'CATEGORY') {
      out.present_at_all_locations = out.present_at_all_locations ?? true
      if (Array.isArray(out.present_at_location_ids) && out.present_at_location_ids.length === 0) delete out.present_at_location_ids
      if (out.present_at_all_locations === true) delete out.present_at_location_ids
    } else out.present_at_all_locations = true
    if (out.type === 'ITEM_VARIATION') {
      const d = out.item_variation_data as Obj
      d.sellable ??= true
      d.stockable ??= true
    }
    if (out.type === 'ITEM') {
      const d = out.item_data as Obj
      // Square keeps its own ordinal within a category whatever the request says (sandbox: 3 became -2251799796908032)
      if (Array.isArray(d.categories)) d.categories = (d.categories as Obj[]).map((c, i) => ({ id: c.id, ordinal: -2251799796908032 + i }))
      if (d.reporting_category) d.reporting_category = { id: (d.reporting_category as Obj).id, ordinal: -2251799796908032 }
      d.is_archived ??= false
    }
    if (out.type === 'TAX') {
      const d = out.tax_data as Obj
      d.calculation_phase ??= 'TAX_SUBTOTAL_PHASE'
      d.inclusion_type ??= 'ADDITIVE'
      d.enabled ??= true
    }
    return out
  }

  private tombstone(id: string, version: number, now: string): void {
    const o = this.objects.get(id)
    if (!o) return
    this.objects.delete(id)
    this.deleted.set(id, { ...o, version, updated_at: now, is_deleted: true })
    if (o.type === 'ITEM') {
      for (const v of this.variationIds.get(id) ?? []) this.tombstone(v, version, now)
      this.variationIds.delete(id)
    }
  }

  retrieve(id: string): Obj {
    const v = this.view(id)
    if (!v) throw new SimCatalogError(404, 'NOT_FOUND', `Catalog object with ID \`${id}\` not found.`)
    return v
  }

  batchRetrieve(ids: string[], o: { include_related_objects?: boolean; include_deleted_objects?: boolean } = {}): { objects: Obj[]; related_objects?: Obj[] } {
    if (ids.length > 1000) throw invalid('object_ids holds at most 1000 ids.', 'object_ids')
    const objects: Obj[] = []
    for (const id of ids) {
      const v = this.view(id) ?? (o.include_deleted_objects ? clone(this.deleted.get(id)) : undefined)
      if (v) objects.push(v)
    }
    if (!o.include_related_objects) return { objects }
    const related = new Map<string, Obj>()
    for (const x of objects) {
      if (x.type !== 'ITEM') continue
      const d = x.item_data as Obj
      const refs = [...((d.tax_ids as string[] | undefined) ?? []), ...((d.categories as Obj[] | undefined) ?? []).map((c) => String(c.id))]
      for (const r of refs) {
        const ro = this.view(r)
        if (ro) related.set(r, ro)
      }
    }
    return { objects, related_objects: [...related.values()] }
  }

  search(q: { object_types?: string[]; include_deleted_objects?: boolean; begin_time?: string }): Obj[] {
    const types = q.object_types ?? []
    const since = q.begin_time ? Date.parse(q.begin_time) : undefined
    const pick = (o: Obj) =>
      (!types.length || types.includes(String(o.type))) && (since === undefined || Date.parse(String(o.updated_at)) > since)
    const live = [...this.objects.values()].filter(pick).map((o) => this.view(String(o.id))!)
    const gone = q.include_deleted_objects ? [...this.deleted.values()].filter(pick).map(clone) : []
    return [...live, ...gone]
  }

  delete(id: string): string[] {
    const o = this.objects.get(id)
    if (!o) throw new SimCatalogError(404, 'NOT_FOUND', `Catalog object \`${id}\` not found.`)
    const planVariations =
      o.type === 'SUBSCRIPTION_PLAN'
        ? [...this.objects.values()].filter((v) => (v.subscription_plan_variation_data as Obj | undefined)?.subscription_plan_id === id).map((v) => String(v.id))
        : [id]
    if (this.host.inUse(planVariations)) throw new SimCatalogError(400, 'BAD_REQUEST', `Catalog Object cannot be deleted for token(s) ${id}`)
    const version = this.nextVersion()
    const now = this.iso()
    const gone =
      o.type === 'SUBSCRIPTION_PLAN' ? [id, ...planVariations] : o.type === 'ITEM' ? [id, ...(this.variationIds.get(id) ?? [])] : [id]
    if (o.type === 'ITEM_VARIATION') {
      const itemId = String((o.item_variation_data as Obj).item_id)
      this.variationIds.set(itemId, (this.variationIds.get(itemId) ?? []).filter((v) => v !== id))
    }
    for (const g of gone) this.tombstone(g, version, now)
    return gone
  }
}

function moneyOk(m: unknown): void {
  const v = m as Money | undefined
  if (!v || typeof v.amount !== 'number' || !Number.isInteger(v.amount) || v.amount < 0) throw invalid('price_money.amount must be a non-negative integer.', 'price_money')
  if (v.currency !== 'USD') throw new SimCatalogError(400, 'UNSUPPORTED_CURRENCY', 'price_money.currency must be USD.', 'price_money')
}
