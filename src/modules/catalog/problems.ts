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
