import type { SquareApi } from '../../ports/square.js'
import type { SquareClient } from '../client.js'
import { wire } from '../wire.js'
import { enc } from './locations.js'

/** UpsertCatalogObject and BatchUpsertCatalogObjects (keyed), RetrieveCatalogObject, SearchCatalogObjects (read), DeleteCatalogObject. */
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
  batchUpsert: async (key, objects) => {
    const r = await c.request({
      method: 'POST',
      path: '/v2/catalog/batch-upsert',
      body: { idempotency_key: key, batches: [{ objects }] },
      idempotencyKey: key,
      schema: wire.catalogBatch,
    })
    return { objects: r.objects, idMappings: r.id_mappings ?? [] }
  },
  retrieve: async (id) =>
    (await c.request({ method: 'GET', path: `/v2/catalog/object/${enc(id)}`, schema: wire.catalogRetrieve })).object,
  search: async (q) => {
    const r = await c.request({ method: 'POST', path: '/v2/catalog/search', body: { ...q }, readOnly: true, schema: wire.catalogSearch })
    return { items: r.objects, cursor: r.cursor ?? undefined }
  },
  delete: async (id) =>
    (await c.request({ method: 'DELETE', path: `/v2/catalog/object/${enc(id)}`, schema: wire.catalogDelete, alreadyDone: ['NOT_FOUND'] }))
      ?.deleted_object_ids ?? [],
})
