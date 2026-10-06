// Keyset pagination: ?limit= (default 100, max 500) and an opaque ?cursor= carrying the last row's sort key.
import { sql, type RawBuilder } from 'kysely'
import { z } from 'zod/v4'
import { AppError } from './errors.js'

export const DEFAULT_LIMIT = 100
export const MAX_LIMIT = 500

export const paginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  cursor: z.string().min(1).max(1024).optional(),
})
export type PaginationQuery = z.infer<typeof paginationQuery>

export interface Page<T> {
  items: T[]
  nextCursor: string | null
}

export type CursorKey = ReadonlyArray<string | number | null>

export function encodeCursor(key: CursorKey): string {
  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64url')
}

/** Decodes a cursor; `arity` is the number of sort-key columns the caller expects. */
export function decodeCursor(cursor: string, arity: number): Array<string | number | null> {
  try {
    const v: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (
      Array.isArray(v) &&
      v.length === arity &&
      v.every((x) => x === null || typeof x === 'string' || typeof x === 'number')
    ) {
      return v as Array<string | number | null>
    }
  } catch {
    // fall through to the problem below
  }
  throw new AppError('INVALID_CURSOR')
}

/**
 * Pass rows fetched with `LIMIT limit + 1`; returns at most `limit` items and a cursor built from the last
 * returned item when more rows exist.
 */
export function toPage<T>(rows: T[], limit: number, keyOf: (row: T) => CursorKey): Page<T> {
  if (rows.length <= limit) return { items: rows, nextCursor: null }
  const items = rows.slice(0, limit)
  return { items, nextCursor: encodeCursor(keyOf(items[items.length - 1] as T)) }
}

/**
 * Row-value comparison for a keyset page: `(a, b) < ($1, $2)` for descending sorts, `>` for ascending.
 * All columns must share one direction (use e.g. `occurred_at desc, id desc`). Use as `.where(keysetCondition(...))`.
 */
export function keysetCondition(
  columns: readonly string[],
  values: ReadonlyArray<string | number | null>,
  direction: 'asc' | 'desc',
): RawBuilder<boolean> {
  if (columns.length !== values.length || columns.length === 0) throw new Error('keyset arity mismatch')
  const cols = sql.join(columns.map((c) => sql.ref(c)))
  const vals = sql.join(values.map((v) => sql`${v}`))
  return direction === 'desc' ? sql<boolean>`(${cols}) < (${vals})` : sql<boolean>`(${cols}) > (${vals})`
}
