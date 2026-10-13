// The sender of the Square item library sync (ADR 0172 section 3), without a database: it plans (plan.ts), builds the bodies
// (merge.ts) and talks to Square one call at a time, keeping the links in a LinkStore (the database in sync.ts, memory in the
// property tests and the sandbox checks). Every create goes through the outbox: the link row gets the request's key and exact body
// BEFORE the call, so a run that dies after Square made the item sends the same request again and gets the same item back (Square
// answers a repeated key with its first answer). Creates are one UpsertCatalogObject per service (an item with its variations is
// one object, all or nothing): a BatchUpsert that fails answers 400 while keeping its other batches (sandbox 2026-10-13, SQR-17),
// which would leave items Oasis never heard of. Updates are read-modify-write with the versions just read; a VERSION_MISMATCH
// (Square changed a field Oasis changes) is read and merged again once in the same run, then left failed for the next run.
// Nothing is deleted at Square; only link ids and temp ids are written.
import { SquareApiError, SquareWritesDisabled } from '../../../integrations/square/errors.js'
import { assertSquareKey, sqKey } from '../../../integrations/square/keys.js'
import type { SquareApi } from '../../../integrations/ports/square.js'
import type { WireCatalogObject } from '../../../integrations/square/wire.js'
import { maskText } from '../../../platform/logging.js'
import { hashOf, itemHash, OASIS_CATEGORY_KEY, parseMarker, type DesiredItem, type DesiredLibrary } from './desired.js'
import { mergeItemBody, newItemBody, ownedDiff } from './merge.js'
import {
  categoryHash,
  mergeContextFor,
  planItems,
  planSetup,
  type ItemAction,
  type LinkRow,
  type RemoteView,
  type SetupAction,
} from './plan.js'
import { OASIS_TAX_NAME, presentAt, squarePercentDbp, type TaxCheck } from './tax.js'

type Obj = Record<string, unknown>

/** Where the links live. `all()` is the current set (writes show at once). */
export interface LinkStore {
  all(): readonly LinkRow[]
  put(row: LinkRow): Promise<void>
  remove(id: string): Promise<void>
}

/** A LinkStore in memory (property tests, sandbox checks). */
export function memoryLinkStore(rows: LinkRow[] = []): LinkStore & { rows: LinkRow[] } {
  const self = {
    rows,
    all: () => self.rows,
    put: async (row: LinkRow) => {
      const i = self.rows.findIndex((r) => r.id === row.id)
      if (i >= 0) self.rows[i] = { ...row }
      else self.rows.push({ ...row })
    },
    remove: async (id: string) => {
      self.rows = self.rows.filter((r) => r.id !== id)
    },
  }
  return self
}

export interface EngineInput {
  api: SquareApi
  /** sim | sandbox | production: part of every key, so environments never share an answer. */
  environment: string
  /** The Square location Oasis sells at. */
  locationId: string
  lib: DesiredLibrary
  tax: TaxCheck
  store: LinkStore
  newId: () => string
  now: Date
  remote?: RemoteView
}

export interface EngineResult {
  status: 'blocked' | 'done'
  blocked: string | null
  taxCreated: number
  taxUpdated: number
  categoriesCreated: number
  categoriesAdopted: number
  categoriesRenamed: number
  created: number
  updated: number
  archived: number
  recreated: number
  adopted: number
  /** Square-side edits Oasis put back. */
  restored: number
  failed: number
  /** Plain words, one per failure ("Signature Hand Wash: Square did not answer"). */
  failures: string[]
  /** Plain words: what was changed in Square and put back, and what is only reported. */
  changedInSquare: string[]
  reported: string[]
  /** Square calls that changed something (for the audit and the watermark). */
  writes: number
}

const emptyResult = (): EngineResult => ({
  status: 'done',
  blocked: null,
  taxCreated: 0,
  taxUpdated: 0,
  categoriesCreated: 0,
  categoriesAdopted: 0,
  categoriesRenamed: 0,
  created: 0,
  updated: 0,
  archived: 0,
  recreated: 0,
  adopted: 0,
  restored: 0,
  failed: 0,
  failures: [],
  changedInSquare: [],
  reported: [],
  writes: 0,
})

/** A failure in words for the link and the managers (Square's own detail, masked; never a token). */
export function failureText(e: unknown): string {
  if (e instanceof SquareWritesDisabled) return 'Square is in watch-only mode'
  if (e instanceof SquareApiError && e.retryable) return 'Square did not answer'
  if (e instanceof SquareApiError)
    return maskText(`Square refused it: ${e.errors.map((x) => x.detail ?? x.code ?? '').filter(Boolean).join('; ') || e.status}`).slice(0, 300)
  return 'Square did not answer'
}

/** The request may have reached Square: the outbox keeps it for the same key next run (a 4xx means nothing was made). */
const maybeMade = (e: unknown): boolean => !(e instanceof SquareApiError) || e.retryable

const isMismatch = (e: unknown): boolean => e instanceof SquareApiError && e.hasCode('VERSION_MISMATCH')
const isNotFound = (e: unknown): boolean => e instanceof SquareApiError && (e.status === 404 || e.hasCode('NOT_FOUND'))

const newLink = (id: string, o: Partial<LinkRow> & Pick<LinkRow, 'kind'>): LinkRow => ({
  id,
  serviceId: null,
  classKey: null,
  categoryKey: null,
  objectId: null,
  itemId: null,
  version: null,
  desiredHash: null,
  contentHash: null,
  state: 'pending',
  adopted: false,
  error: null,
  pendingKey: null,
  pendingBody: null,
  pendingAt: null,
  ...o,
})

export async function runEngine(i: EngineInput): Promise<EngineResult> {
  const r = emptyResult()
  const setup = planSetup(i.lib, i.store.all(), i.tax, i.remote)
  const blocked = setup.find((a) => a.kind === 'blocked')
  if (blocked && blocked.kind === 'blocked') return { ...r, status: 'blocked', blocked: blocked.detail }
  let shopCategories: WireCatalogObject[] | undefined
  for (const a of setup) await runSetup(i, a, r, async () => (shopCategories ??= await listCategories(i.api)))
  // never an item without the sales tax: if the tax could not be made, the items wait for the next run
  if (!i.store.all().find((l) => l.kind === 'tax')?.objectId) {
    if (!r.failures.length) r.failures.push('The sales tax is not set up at Square yet: the items wait for it')
    return r
  }
  const items = planItems(i.lib, { locationId: i.locationId, links: i.store.all(), remote: i.remote })
  const byService = new Map(i.lib.items.map((x) => [x.serviceId, x]))
  for (const a of items) {
    if (a.kind === 'drift') {
      r.reported.push(a.detail)
      continue
    }
    const item = byService.get(a.serviceId)
    if (item) await runItem(i, a, item, r)
  }
  return r
}

async function listCategories(api: SquareApi): Promise<WireCatalogObject[]> {
  const all: WireCatalogObject[] = []
  let cursor: string | undefined
  for (let n = 0; n < 50; n++) {
    const page = await api.catalog.search({ object_types: ['CATEGORY'], cursor, include_deleted_objects: false })
    all.push(...page.items)
    cursor = page.cursor
    if (!cursor) break
  }
  return all.filter((c) => !c.is_deleted)
}

const linkOf = (i: EngineInput, pred: (l: LinkRow) => boolean): LinkRow | undefined => i.store.all().find(pred)

async function runSetup(i: EngineInput, a: SetupAction, r: EngineResult, shop: () => Promise<WireCatalogObject[]>): Promise<void> {
  const taxLink = () => linkOf(i, (l) => l.kind === 'tax')
  try {
    switch (a.kind) {
      case 'create_tax': {
        // a tax made again after Square lost Oasis's names the lost one in its key (the first key would answer the lost tax)
        const lost = taxLink()?.objectId
        const res = await i.api.catalog.upsert(sqKey('ct', `items:tax:${i.environment}:${i.locationId}:${a.percentage}${lost ? `:after:${lost}` : ''}`), {
          type: 'TAX',
          id: '#oasis-tax',
          present_at_all_locations: false,
          present_at_location_ids: [i.locationId],
          tax_data: {
            name: OASIS_TAX_NAME,
            calculation_phase: 'TAX_SUBTOTAL_PHASE',
            inclusion_type: 'ADDITIVE',
            percentage: a.percentage,
            applies_to_custom_amounts: false,
            enabled: true,
          },
        })
        r.writes++
        const prior = taxLink()
        await i.store.put({
          ...(prior ?? newLink(i.newId(), { kind: 'tax' })),
          objectId: res.object.id,
          version: res.object.version ?? null,
          adopted: false,
          state: 'synced',
          contentHash: hashOf({ percentage: a.percentage }),
          desiredHash: hashOf({ percentage: a.percentage }),
          error: null,
        })
        r.taxCreated++
        break
      }
      case 'update_tax': {
        // Oasis's own tax, as Oasis made it: its rate, enabled at our location, added to the price, on the subtotal, never on custom
        // amounts (read-modify-write: the name and anything else stay as they are)
        const cur = await i.api.catalog.retrieve(a.objectId)
        const d = cur.tax_data ?? {}
        const presence = presentAt(cur, i.locationId)
          ? {}
          : cur.present_at_all_locations !== false
            ? { absent_at_location_ids: (cur.absent_at_location_ids ?? []).filter((x) => x !== i.locationId) }
            : { present_at_location_ids: [...(cur.present_at_location_ids ?? []), i.locationId] }
        const res = await i.api.catalog.upsert(sqKey('ct', `items:tax:update:${a.objectId}:${cur.version ?? 0}:${a.percentage}`), {
          ...cur,
          ...presence,
          tax_data: { ...d, percentage: a.percentage, enabled: true, inclusion_type: 'ADDITIVE', calculation_phase: 'TAX_SUBTOTAL_PHASE', applies_to_custom_amounts: false },
        })
        r.writes++
        const link = taxLink()!
        // a percentage Oasis already wrote that Square now shows otherwise was changed by staff (an Oasis rate change is not reported)
        const was = squarePercentDbp(d.percentage)
        const changed = [...a.changed]
        if (link.contentHash === hashOf({ percentage: a.percentage }) && was !== squarePercentDbp(a.percentage))
          changed.push(`${d.percentage ?? '?'}%, not ${a.percentage}%`)
        await i.store.put({ ...link, version: res.object.version ?? null, state: 'synced', contentHash: hashOf({ percentage: a.percentage }), error: null })
        r.taxUpdated++
        if (changed.length) {
          r.restored++
          r.changedInSquare.push(`The sales tax “${d.name ?? OASIS_TAX_NAME}” (${changed.join('; ')})`)
        }
        break
      }
      case 'adopt_tax': {
        const prior = taxLink()
        await i.store.put({ ...(prior ?? newLink(i.newId(), { kind: 'tax' })), objectId: a.objectId, version: null, adopted: true, state: 'synced', contentHash: null, error: null })
        break
      }
      case 'create_category': {
        const prior = linkOf(i, (l) => l.kind === 'category' && l.categoryKey === a.key)
        // the shop's own category of the same name (exactly one, not already Oasis's): referenced, never written. The "Oasis" marker
        // category matches only by its exact name (a shop's "OASIS" is the shop's), and one found by name is referenced too, never
        // written: it may be the shop's own, and its name never changes anyway (K4 review items:ITEMS-P1)
        const mine = new Set(i.store.all().filter((l) => l.kind === 'category' && l.objectId).map((l) => l.objectId!))
        const named = (c: WireCatalogObject): boolean => {
          const n = (c.category_data?.name ?? '').trim()
          return a.key === OASIS_CATEGORY_KEY ? n === a.name : n.toLowerCase() === a.name.toLowerCase()
        }
        const same = (await shop()).filter((c) => !mine.has(c.id) && named(c))
        if (same.length === 1) {
          await i.store.put({
            ...(prior ?? newLink(i.newId(), { kind: 'category', categoryKey: a.key })),
            objectId: same[0]!.id,
            version: same[0]!.version ?? null,
            adopted: true,
            state: 'synced',
            contentHash: categoryHash({ key: a.key, name: a.name }),
            error: null,
          })
          r.categoriesAdopted++
          break
        }
        const res = await i.api.catalog.upsert(sqKey('ct', `items:category:${i.environment}:${i.locationId}:${a.key}:${a.name}${prior?.objectId ? `:after:${prior.objectId}` : ''}`), {
          type: 'CATEGORY',
          id: '#oasis-category',
          category_data: { name: a.name },
        })
        r.writes++
        await i.store.put({
          ...(prior ?? newLink(i.newId(), { kind: 'category', categoryKey: a.key })),
          objectId: res.object.id,
          version: res.object.version ?? null,
          adopted: false,
          state: 'synced',
          contentHash: categoryHash({ key: a.key, name: a.name }),
          desiredHash: categoryHash({ key: a.key, name: a.name }),
          error: null,
        })
        r.categoriesCreated++
        break
      }
      case 'rename_category': {
        const cur = await i.api.catalog.retrieve(a.objectId)
        let version = cur.version ?? null
        if (cur.category_data?.name !== a.name) {
          const res = await i.api.catalog.upsert(sqKey('ct', `items:category:update:${a.objectId}:${cur.version ?? 0}:${a.name}`), {
            ...cur,
            category_data: { ...(cur.category_data ?? {}), name: a.name },
          })
          r.writes++
          version = res.object.version ?? null
          r.categoriesRenamed++
        }
        const l = linkOf(i, (x) => x.id === a.linkId)!
        await i.store.put({ ...l, version, state: 'synced', contentHash: categoryHash({ key: a.key, name: a.name }), error: null })
        break
      }
      case 'retire_category': {
        const l = linkOf(i, (x) => x.id === a.linkId)!
        await i.store.put({ ...l, state: 'gone' })
        r.reported.push(`The Square category ${l.categoryKey === OASIS_CATEGORY_KEY ? '“Oasis”' : `of ${a.key}`} is no longer used by Oasis items; it stays in Square`)
        break
      }
      case 'drift':
        r.reported.push(a.detail)
        break
      case 'blocked':
        break
    }
  } catch (e) {
    r.failed++
    r.failures.push(`${a.kind === 'create_tax' || a.kind === 'update_tax' ? 'The sales tax' : 'A category'}: ${failureText(e)}`)
    if (a.kind === 'rename_category') {
      const l = linkOf(i, (x) => x.id === a.linkId)
      if (l) await i.store.put({ ...l, state: 'failed', error: failureText(e) })
    }
  }
}

/** Records what Square answered for an item: the item link and one link per Oasis variation (by marker); stale ones go. */
async function recordItem(i: EngineInput, item: DesiredItem, answer: WireCatalogObject, hash: string): Promise<void> {
  const prior = linkOf(i, (l) => l.kind === 'item' && l.serviceId === item.serviceId)
  await i.store.put({
    ...(prior ?? newLink(i.newId(), { kind: 'item', serviceId: item.serviceId })),
    objectId: answer.id,
    version: answer.version ?? null,
    desiredHash: hash,
    contentHash: hash,
    state: item.archived ? 'archived' : 'synced',
    error: null,
    pendingKey: null,
    pendingBody: null,
    pendingAt: null,
  })
  const seen = new Set<string>()
  for (const v of answer.item_data?.variations ?? []) {
    const m = parseMarker(v.item_variation_data?.user_data)
    if (!m || m.serviceId !== item.serviceId || v.is_deleted) continue
    const key = m.classKey
    const l = linkOf(i, (x) => x.kind === 'variation' && x.serviceId === item.serviceId && x.classKey === key)
    const present = v.present_at_all_locations !== false || (v.present_at_location_ids ?? []).includes(i.locationId)
    const row = {
      ...(l ?? newLink(i.newId(), { kind: 'variation', serviceId: item.serviceId, classKey: key })),
      objectId: v.id,
      itemId: answer.id,
      version: v.version ?? null,
      state: present ? ('synced' as const) : ('hidden' as const),
      error: null,
    }
    seen.add(row.id)
    await i.store.put(row)
  }
  for (const l of i.store.all().filter((x) => x.kind === 'variation' && x.serviceId === item.serviceId && !seen.has(x.id))) await i.store.remove(l.id)
}

async function failItem(i: EngineInput, item: DesiredItem, e: unknown, r: EngineResult, o: { keepPending: boolean }): Promise<void> {
  const l = linkOf(i, (x) => x.kind === 'item' && x.serviceId === item.serviceId)
  const text = failureText(e)
  if (l)
    await i.store.put({
      ...l,
      state: 'failed',
      error: text,
      ...(o.keepPending ? {} : { pendingKey: null, pendingBody: null, pendingAt: null }),
    })
  r.failed++
  r.failures.push(`${item.name}: ${text}`)
}

/**
 * Makes a new item through the outbox. Every fresh create has a key of its own (a new id in it): a create that may have reached
 * Square is sent again only from the outbox, with the key kept there. A key made from the content alone would bring back, after an
 * item was deleted at Square and forgotten, Square's first answer for it: the deleted item (K4 review items:ITEMS-P3).
 * `replacing`: the id of the item Square deleted, named in the key for the logs.
 */
async function createItem(i: EngineInput, item: DesiredItem, hash: string, r: EngineResult, replacing?: string): Promise<boolean> {
  const body = newItemBody(item, mergeContextFor(item, { locationId: i.locationId, links: i.store.all() }))
  const key = sqKey('ct', `items:create:${i.environment}:${item.serviceId}:${hash}:${i.newId()}${replacing ? `:after:${replacing}` : ''}`)
  const prior = linkOf(i, (l) => l.kind === 'item' && l.serviceId === item.serviceId)
  // the outbox: the exact request is kept before it is sent
  await i.store.put({
    ...(prior ?? newLink(i.newId(), { kind: 'item', serviceId: item.serviceId })),
    objectId: null,
    version: null,
    desiredHash: hash,
    state: 'pending',
    pendingKey: key,
    pendingBody: body,
    pendingAt: i.now,
  })
  try {
    const res = await i.api.catalog.upsert(key, body)
    r.writes++
    await recordItem(i, item, res.object, hash)
    return true
  } catch (e) {
    await failItem(i, item, e, r, { keepPending: maybeMade(e) })
    return false
  }
}

async function updateItem(i: EngineInput, item: DesiredItem, itemId: string, hash: string, r: EngineResult): Promise<'sent' | 'same' | 'gone' | 'failed'> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    let cur: WireCatalogObject
    try {
      cur = await i.api.catalog.retrieve(itemId)
    } catch (e) {
      if (isNotFound(e)) return 'gone'
      await failItem(i, item, e, r, { keepPending: false })
      return 'failed'
    }
    if (cur.is_deleted) return 'gone'
    const ctx = mergeContextFor(item, { locationId: i.locationId, links: i.store.all() })
    if (ownedDiff(item, cur, ctx).length === 0) {
      // Square already has it (a lost answer, or nothing Oasis owns differs): only the record is brought up to date
      await recordItem(i, item, cur, hash)
      return 'same'
    }
    const body = mergeItemBody(item, cur, ctx)
    try {
      const res = await i.api.catalog.upsert(sqKey('ct', `items:update:${itemId}:${cur.version ?? 0}:${hash}`), body)
      r.writes++
      await recordItem(i, item, res.object, hash)
      return 'sent'
    } catch (e) {
      if (isMismatch(e) && attempt === 1) continue
      if (isMismatch(e))
        return (
          await failItem(i, item, new Error('Square changed this item while Oasis was updating it; tried again next run'), r, { keepPending: false }),
          'failed'
        )
      if (isNotFound(e)) return 'gone'
      await failItem(i, item, e, r, { keepPending: false })
      return 'failed'
    }
  }
  return 'failed'
}

/** Forgets an item Square no longer has: its variation links go, the item link keeps its row without an id (made again if sold). */
async function forget(i: EngineInput, item: DesiredItem): Promise<void> {
  for (const l of i.store.all().filter((x) => x.kind === 'variation' && x.serviceId === item.serviceId)) await i.store.remove(l.id)
  const l = linkOf(i, (x) => x.kind === 'item' && x.serviceId === item.serviceId)
  if (l) await i.store.put({ ...l, objectId: null, version: null, contentHash: null, state: item.archived ? 'archived' : 'pending', pendingKey: null, pendingBody: null, pendingAt: null })
}

async function runItem(i: EngineInput, a: Exclude<ItemAction, { kind: 'drift' }>, item: DesiredItem, r: EngineResult): Promise<void> {
  switch (a.kind) {
    case 'resend_pending': {
      const l = linkOf(i, (x) => x.id === a.linkId)!
      try {
        const res = await i.api.catalog.upsert(assertSquareKey(l.pendingKey!), l.pendingBody as Obj)
        r.writes++
        await recordItem(i, item, res.object, l.desiredHash ?? '')
        r.created++
      } catch (e) {
        await failItem(i, item, e, r, { keepPending: maybeMade(e) })
      }
      return
    }
    case 'create_item':
      if (await createItem(i, item, a.hash, r)) r.created++
      return
    case 'adopt_orphan': {
      const prior = linkOf(i, (l) => l.kind === 'item' && l.serviceId === item.serviceId)
      await i.store.put({
        ...(prior ?? newLink(i.newId(), { kind: 'item', serviceId: item.serviceId })),
        objectId: a.itemId,
        contentHash: null,
        state: 'pending',
        pendingKey: null,
        pendingBody: null,
        pendingAt: null,
      })
      r.adopted++
      const hash = itemHash(item, mergeContextFor(item, { locationId: i.locationId, links: i.store.all() }).refs)
      const out = await updateItem(i, item, a.itemId, hash, r)
      if (out === 'gone') await forget(i, item)
      return
    }
    case 'update_item': {
      const out = await updateItem(i, item, a.itemId, a.hash, r)
      if (out === 'gone') {
        await forget(i, item)
        if (!item.archived && (await createItem(i, item, a.hash, r, a.itemId))) {
          r.recreated++
          r.changedInSquare.push(`${item.name} was deleted in Square: Oasis made it again`)
        }
        return
      }
      if (out === 'sent') {
        if (a.reason === 'drift') {
          r.restored++
          r.changedInSquare.push(...a.detail)
        } else if (item.archived) r.archived++
        else r.updated++
      }
      return
    }
    case 'recreate':
      await forget(i, item)
      if (await createItem(i, item, a.hash, r, a.itemId)) {
        r.recreated++
        r.changedInSquare.push(a.detail)
      }
      return
    case 'forget':
      await forget(i, item)
      return
  }
}
