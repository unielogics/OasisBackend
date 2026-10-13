// The planner of the Square item library sync (ADR 0172 section 3), pure: what Square must change so the item library matches the
// desired library. Two passes, run by the sender one after the other so the items can name a tax or category made in the same run:
//   planSetup  1 blocked (the tax check failed: nothing else is planned, nothing is written)
//              2 create_tax / update_tax (only a tax Oasis made) / adopt_tax (recorded, never written)
//              3 create_category / rename_category (only one Oasis made) / retire_category (no longer used: left in Square)
//   planItems  4 resend_pending (a create in flight: the outbox, re-sent unchanged)
//              5 adopt_orphan (Oasis's marker found at Square with no link: after a crash or a restore; never a second item)
//              6 create_item (a sold service without an item)
//              7 update_item (reason changed: Oasis's fields changed; failed: the last try failed; drift: Square's copy was edited)
//              8 recreate (the item was deleted at Square while Oasis still sells it)
//              9 drift (report only: a second item with Oasis's marker, an adopted category renamed at Square)
// Nothing is ever deleted at Square; only ids from the links (or temp ids) are written.
import type { WireCatalogObject } from '../../../integrations/square/wire.js'
import { hashOf, itemHash, OASIS_CATEGORY_KEY, parseMarker, type DesiredCategory, type DesiredItem, type DesiredLibrary, type ItemRefs } from './desired.js'
import { ownedDiff, type MergeContext } from './merge.js'
import type { CatalogLinkKind, CatalogLinkState } from './schema.js'
import type { TaxCheck } from './tax.js'

export interface LinkRow {
  id: string
  kind: CatalogLinkKind
  serviceId: string | null
  classKey: string | null
  categoryKey: string | null
  objectId: string | null
  itemId: string | null
  version: number | null
  desiredHash: string | null
  contentHash: string | null
  state: CatalogLinkState
  adopted: boolean
  error: string | null
  pendingKey: string | null
  pendingBody: Record<string, unknown> | null
  pendingAt: Date | null
}

/** What was read back from Square (the 5-minute run: what changed since the watermark; the nightly drift run: everything linked). */
export interface RemoteView {
  /** Items read back, by id (with their nested variations). */
  items: ReadonlyMap<string, WireCatalogObject>
  /** Linked object ids Square no longer has (deleted, or absent from a full read). */
  gone: ReadonlySet<string>
  categories: ReadonlyMap<string, WireCatalogObject>
  /** Items carrying an Oasis marker (the nightly drift run searches every item). */
  marked?: readonly WireCatalogObject[]
}

export type SetupAction =
  | { kind: 'blocked'; detail: string }
  | { kind: 'create_tax'; percentage: string }
  | { kind: 'update_tax'; linkId: string; objectId: string; percentage: string }
  | { kind: 'adopt_tax'; objectId: string; name: string | null }
  | { kind: 'create_category'; key: string; name: string }
  | { kind: 'rename_category'; linkId: string; key: string; objectId: string; name: string }
  | { kind: 'retire_category'; linkId: string; key: string }
  | { kind: 'drift'; detail: string }

export type ItemAction =
  | { kind: 'resend_pending'; serviceId: string; linkId: string }
  | { kind: 'adopt_orphan'; serviceId: string; itemId: string; name: string }
  | { kind: 'create_item'; serviceId: string; hash: string }
  | { kind: 'update_item'; serviceId: string; itemId: string; hash: string; reason: 'changed' | 'failed' | 'drift'; detail: string[] }
  | { kind: 'recreate'; serviceId: string; itemId: string; hash: string; detail: string }
  | { kind: 'forget'; serviceId: string; itemId: string }
  | { kind: 'drift'; detail: string }

export const categoryHash = (c: DesiredCategory): string => hashOf({ name: c.name })

const linksOf = (links: readonly LinkRow[], kind: CatalogLinkKind) => links.filter((l) => l.kind === kind)

/** The tax and category changes. A tax check that is not ok (or create) blocks everything. */
export function planSetup(lib: DesiredLibrary, links: readonly LinkRow[], tax: TaxCheck, remote?: RemoteView): SetupAction[] {
  if (tax.status === 'blocked' || tax.status === 'error') return [{ kind: 'blocked', detail: tax.detail }]
  const out: SetupAction[] = []
  const taxLink = linksOf(links, 'tax')[0]
  if (tax.status === 'create') out.push({ kind: 'create_tax', percentage: tax.wantPercentage })
  else if (tax.own) {
    if (tax.percentage !== tax.wantPercentage && taxLink?.objectId)
      out.push({ kind: 'update_tax', linkId: taxLink.id, objectId: taxLink.objectId, percentage: tax.wantPercentage })
  } else if (tax.taxId && (!taxLink || taxLink.objectId !== tax.taxId || !taxLink.adopted)) out.push({ kind: 'adopt_tax', objectId: tax.taxId, name: tax.taxName })
  const catLinks = linksOf(links, 'category')
  for (const c of lib.categories) {
    const l = catLinks.find((x) => x.categoryKey === c.key)
    const r = l?.objectId ? remote?.categories.get(l.objectId) : undefined
    const goneAtSquare = !!l?.objectId && (remote?.gone.has(l.objectId) || r?.is_deleted === true)
    if (!l || !l.objectId || goneAtSquare) out.push({ kind: 'create_category', key: c.key, name: c.name })
    else if (l.adopted) {
      if (r && (r.category_data?.name ?? '').toLowerCase() !== c.name.toLowerCase())
        out.push({ kind: 'drift', detail: `The Square category “${r.category_data?.name ?? ''}” used for ${c.name} was renamed in Square` })
    } else if (l.contentHash !== categoryHash(c) || l.state === 'gone' || l.state === 'failed' || (r && r.category_data?.name !== c.name))
      out.push({ kind: 'rename_category', linkId: l.id, key: c.key, objectId: l.objectId, name: c.name })
  }
  for (const l of catLinks)
    if (l.state !== 'gone' && !lib.categories.some((c) => c.key === l.categoryKey)) out.push({ kind: 'retire_category', linkId: l.id, key: l.categoryKey! })
  return out
}

/** The ids an item points at, from the links (null while the tax or the category is not made yet). */
export function refsFor(item: DesiredItem, links: readonly LinkRow[]): ItemRefs {
  const tax = linksOf(links, 'tax')[0]
  const cat = (key: string) => linksOf(links, 'category').find((x) => x.categoryKey === key)?.objectId ?? null
  return { taxId: tax?.objectId ?? null, categoryId: cat(item.categoryKey), oasisCategoryId: cat(OASIS_CATEGORY_KEY) }
}

export const sizeKey = (classKey: string | null): string => classKey ?? ''

/** The variation ids linked for a service, by size key. */
export function linkedVariationsOf(serviceId: string, links: readonly LinkRow[]): Map<string, string> {
  return new Map(
    links.filter((l) => l.kind === 'variation' && l.serviceId === serviceId && l.objectId).map((l) => [sizeKey(l.classKey), l.objectId!]),
  )
}

export interface ItemPlanContext {
  locationId: string
  links: readonly LinkRow[]
  remote?: RemoteView
}

export function mergeContextFor(item: DesiredItem, ctx: Pick<ItemPlanContext, 'locationId' | 'links'>): MergeContext {
  return { locationId: ctx.locationId, refs: refsFor(item, ctx.links), linkedVariations: linkedVariationsOf(item.serviceId, ctx.links) }
}

/** The item changes (after the setup pass ran, so the tax and the categories have their ids). */
export function planItems(lib: DesiredLibrary, ctx: ItemPlanContext): ItemAction[] {
  const out: ItemAction[] = []
  const itemLinks = new Map(linksOf(ctx.links, 'item').map((l) => [l.serviceId!, l]))
  const linkedItemIds = new Set([...itemLinks.values()].map((l) => l.objectId).filter((x): x is string => !!x))
  // items with Oasis's marker that no link names (read only by the nightly run): adopted, the oldest first; a second one is reported
  const orphans = new Map<string, WireCatalogObject>()
  for (const o of ctx.remote?.marked ?? []) {
    if (o.is_deleted || linkedItemIds.has(o.id)) continue
    const svc = (o.item_data?.variations ?? []).map((v) => parseMarker(v.item_variation_data?.user_data)?.serviceId).find(Boolean)
    if (!svc) continue
    const known = orphans.get(svc)
    if (!known) orphans.set(svc, o)
    else out.push({ kind: 'drift', detail: `Square has a second item for ${o.item_data?.name ?? 'an Oasis service'} with Oasis’s marker: archive the extra one in Square` })
  }
  for (const item of [...lib.items].sort((a, b) => a.rank - b.rank)) {
    const link = itemLinks.get(item.serviceId)
    const orphan = orphans.get(item.serviceId)
    if (link?.pendingKey) {
      // a create in flight: the same request again (Square answers the same item); found by its marker meanwhile: adopted
      if (orphan) out.push({ kind: 'adopt_orphan', serviceId: item.serviceId, itemId: orphan.id, name: item.name })
      else out.push({ kind: 'resend_pending', serviceId: item.serviceId, linkId: link.id })
      continue
    }
    if (!link?.objectId) {
      if (orphan) out.push({ kind: 'adopt_orphan', serviceId: item.serviceId, itemId: orphan.id, name: item.name })
      else if (!item.archived) out.push({ kind: 'create_item', serviceId: item.serviceId, hash: itemHash(item, refsFor(item, ctx.links)) })
      continue
    }
    if (orphan && orphan.id !== link.objectId)
      out.push({ kind: 'drift', detail: `Square has a second item for ${item.name} with Oasis’s marker: archive the extra one in Square` })
    const gone = ctx.remote?.gone.has(link.objectId) || ctx.remote?.items.get(link.objectId)?.is_deleted === true
    if (gone) {
      if (item.archived) out.push({ kind: 'forget', serviceId: item.serviceId, itemId: link.objectId })
      else
        out.push({
          kind: 'recreate',
          serviceId: item.serviceId,
          itemId: link.objectId,
          hash: itemHash(item, refsFor(item, ctx.links)),
          detail: `${item.name} was deleted in Square: Oasis made it again`,
        })
      continue
    }
    const hash = itemHash(item, refsFor(item, ctx.links))
    if (link.contentHash !== hash || link.state === 'pending') {
      out.push({ kind: 'update_item', serviceId: item.serviceId, itemId: link.objectId, hash, reason: 'changed', detail: [] })
      continue
    }
    if (link.state === 'failed') {
      out.push({ kind: 'update_item', serviceId: item.serviceId, itemId: link.objectId, hash, reason: 'failed', detail: [] })
      continue
    }
    const r = ctx.remote?.items.get(link.objectId)
    if (r) {
      const diff = ownedDiff(item, r, mergeContextFor(item, ctx))
      if (diff.length) out.push({ kind: 'update_item', serviceId: item.serviceId, itemId: link.objectId, hash, reason: 'drift', detail: diff })
    }
  }
  return out
}

/** What a preview says: how many items the sync would create (with how many prices), update and archive. */
export interface PreviewCounts {
  create: number
  createPrices: number
  update: number
  archive: number
  unchanged: number
  /** Services not sent at all: off, quote-only or without a price, and never made. */
  skipped: number
}

export function previewCounts(lib: DesiredLibrary, actions: readonly ItemAction[]): PreviewCounts {
  const byService = new Map(lib.items.map((i) => [i.serviceId, i]))
  const c: PreviewCounts = { create: 0, createPrices: 0, update: 0, archive: 0, unchanged: 0, skipped: 0 }
  const touched = new Set<string>()
  for (const a of actions) {
    if (a.kind === 'drift') continue
    touched.add(a.serviceId)
    const item = byService.get(a.serviceId)
    if (a.kind === 'create_item' || a.kind === 'recreate' || a.kind === 'resend_pending') {
      c.create++
      c.createPrices += item?.variations.filter((v) => v.present).length ?? 0
    } else if (a.kind === 'update_item') {
      if (item?.archived) c.archive++
      else c.update++
    }
  }
  for (const i of lib.items) {
    if (touched.has(i.serviceId)) continue
    if (i.archived) c.skipped++
    else c.unchanged++
  }
  return c
}
