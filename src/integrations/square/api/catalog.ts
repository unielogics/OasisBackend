import type { SquareApi } from '../../ports/square.js'
import type { SquareClient } from '../client.js'
import { wire } from '../wire.js'
import { enc } from './locations.js'

/** Square takes at most this many ids per BatchRetrieveCatalogObjects. */
export const CATALOG_BATCH_RETRIEVE_MAX = 1000

/**
 * UpsertCatalogObject and BatchUpsertCatalogObjects (keyed), RetrieveCatalogObject, BatchRetrieveCatalogObjects and
 * SearchCatalogObjects (reads), DeleteCatalogObject.
 */
export const catalogApi = (c: SquareClient): SquareApi['catalog'] => ({
  upsert: async (key, object) => {
    const r = await c.request({
      method: 'POST',
      path: '/v2/catalog/object',
      body: { idempotency_key: key, object },
      idempotencyKey: key,
      schema: wire.catalogObject,
    })
    return { object: r.catalog_object, idMappings: r.id_mappings ?? [] }
  },
  batchUpsert: async (key, batches) => {
    const r = await c.request({
      method: 'POST',
      path: '/v2/catalog/batch-upsert',
      body: { idempotency_key: key, batches: batches.map((objects) => ({ objects })) },
      idempotencyKey: key,
      schema: wire.catalogBatch,
    })
    return { objects: r.objects, idMappings: r.id_mappings ?? [] }
  },
  retrieve: async (id) =>
    (await c.request({ method: 'GET', path: `/v2/catalog/object/${enc(id)}`, schema: wire.catalogRetrieve })).object,
  batchRetrieve: async (ids, o = {}) => {
    const objects = []
    const related = []
    for (let i = 0; i < ids.length; i += CATALOG_BATCH_RETRIEVE_MAX) {
      const r = await c.request({
        method: 'POST',
        path: '/v2/catalog/batch-retrieve',
        body: { object_ids: ids.slice(i, i + CATALOG_BATCH_RETRIEVE_MAX), ...o },
        readOnly: true,
        schema: wire.catalogBatchRetrieve,
      })
      objects.push(...r.objects)
      related.push(...(r.related_objects ?? []))
    }
    return { objects, related }
  },
  search: async (q) => {
    const r = await c.request({ method: 'POST', path: '/v2/catalog/search', body: { ...q }, readOnly: true, schema: wire.catalogSearch })
    return { items: r.objects, cursor: r.cursor ?? undefined, ...(r.related_objects ? { related: r.related_objects } : {}) }
  },
  delete: async (id) =>
    (await c.request({ method: 'DELETE', path: `/v2/catalog/object/${enc(id)}`, schema: wire.catalogDelete, alreadyDone: ['NOT_FOUND'] }))
      ?.deleted_object_ids ?? [],
})
