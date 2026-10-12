// Problem copy of the catalog's Settings routes (categories; ADR 0160).
import { registerProblems } from '../../platform/errors.js'

registerProblems({
  CATEGORY_KEY_TAKEN: {
    status: 409,
    title: 'Already a category',
    detail: 'A category with that key already exists',
  },
  CATEGORY_BUILTIN: {
    status: 409,
    title: 'Built-in category',
    detail: 'The default categories cannot be deleted. Turn it off instead',
  },
  CATEGORY_IN_USE: {
    status: 409,
    title: 'Category in use',
    detail: 'Services still use this category. Move them to another one first',
  },
  CATEGORY_LIMIT: {
    status: 422,
    title: 'Too many categories',
    detail: 'The catalog can have at most 20 categories',
  },
})

// Vehicle sizes, prices by size and tiers (ADR 0170).
registerProblems({
  CLASS_KEY_TAKEN: {
    status: 409,
    title: 'Already a size',
    detail: 'A vehicle size with that key already exists',
  },
  CLASS_IN_USE: {
    status: 409,
    title: 'Size in use',
    detail: 'Prices, memberships, checkouts, vehicles or visits still use this size. Turn it off instead',
  },
  CLASS_LIMIT: {
    status: 422,
    title: 'Too many sizes',
    detail: 'The shop can have at most 12 vehicle sizes',
  },
  TIER_KEY_TAKEN: {
    status: 409,
    title: 'Already a tier',
    detail: 'A membership tier with that key already exists',
  },
  TIER_IN_USE: {
    status: 409,
    title: 'Tier in use',
    detail: 'This tier has been sold. Turn it off instead',
  },
  CATALOG_ROUTE_RETIRED: {
    status: 410,
    title: 'Route retired',
    detail: 'Prices are set per vehicle size now: use Settings → Prices by size and Memberships',
  },
})
