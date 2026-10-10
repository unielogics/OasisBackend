// Service keys for the website (ADR 0150): the catalog has ids (UUIDs) and names; the site needs a stable, readable key it can
// keep in its configuration ("signature-hand-wash"). The key is the slug of the service name; when two live services slug alike
// the later one (by catalog order) carries the first six characters of its id, so keys are unique within a catalog listing.
import type { CatalogService } from '../catalog/service.js'

export const slugOf = (name: string): string =>
  name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\+/g, ' plus ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

export interface KeyedService extends CatalogService {
  key: string
}

/** Assigns keys in catalog order (the order listCatalog returns), unique within the list. */
export function keyServices<T extends CatalogService>(services: readonly T[]): (T & { key: string })[] {
  const seen = new Set<string>()
  return services.map((s) => {
    let key = slugOf(s.name) || 'service'
    if (seen.has(key)) key = `${key}-${s.id.replace(/-/g, '').slice(0, 6)}`
    seen.add(key)
    return { ...s, key }
  })
}

export const findByKey = <T extends { key: string }>(items: readonly T[], key: string): T | undefined =>
  items.find((s) => s.key === key)
