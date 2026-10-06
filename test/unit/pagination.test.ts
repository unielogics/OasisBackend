import { describe, expect, it } from 'vitest'
import { Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler, sql } from 'kysely'
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  decodeCursor,
  encodeCursor,
  keysetCondition,
  paginationQuery,
  toPage,
} from '../../src/platform/pagination.js'
import { AppError } from '../../src/platform/errors.js'

describe('cursor', () => {
  it('round-trips a sort key and is opaque url-safe base64', () => {
    const key = ['2026-06-13T14:36:00.000Z', '0197abc-def', 42, null]
    const c = encodeCursor(key)
    expect(c).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(decodeCursor(c, 4)).toEqual(key)
  })

  it('rejects tampered, wrong-arity and non-array cursors with INVALID_CURSOR', () => {
    for (const bad of [
      '!!!',
      encodeCursor(['a']),
      Buffer.from('{"a":1}').toString('base64url'),
      Buffer.from('[{"x":1}]').toString('base64url'),
    ]) {
      expect(() => decodeCursor(bad, 2)).toThrow(AppError)
      try {
        decodeCursor(bad, 2)
      } catch (e) {
        expect((e as AppError).code).toBe('INVALID_CURSOR')
        expect((e as AppError).status).toBe(400)
      }
    }
  })
})

describe('toPage', () => {
  const rows = Array.from({ length: 6 }, (_, i) => ({ id: i + 1 }))
  it('returns no cursor when everything fit', () => {
    expect(toPage(rows.slice(0, 5), 5, (r) => [r.id])).toEqual({ items: rows.slice(0, 5), nextCursor: null })
  })
  it('trims the lookahead row and points the cursor at the last returned item', () => {
    const page = toPage(rows, 5, (r) => [r.id])
    expect(page.items).toHaveLength(5)
    expect(decodeCursor(page.nextCursor!, 1)).toEqual([5])
  })
})

describe('paginationQuery', () => {
  it('defaults to 100 and caps at 500', () => {
    expect(paginationQuery.parse({}).limit).toBe(DEFAULT_LIMIT)
    expect(paginationQuery.parse({ limit: '25' }).limit).toBe(25)
    expect(paginationQuery.safeParse({ limit: String(MAX_LIMIT + 1) }).success).toBe(false)
    expect(paginationQuery.safeParse({ limit: '0' }).success).toBe(false)
  })
})

describe('keysetCondition', () => {
  const k = new Kysely<Record<string, never>>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => ({}) as never,
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  })
  it('builds a row-value comparison in the sort direction', () => {
    const desc = keysetCondition(['occurred_at', 'id'], ['2026-06-13', 'abc'], 'desc').compile(k)
    expect(desc.sql).toBe('("occurred_at", "id") < ($1, $2)')
    expect(desc.parameters).toEqual(['2026-06-13', 'abc'])
    expect(keysetCondition(['id'], [7], 'asc').compile(k).sql).toBe('("id") > ($1)')
    expect(sql`1`).toBeDefined()
  })
  it('rejects arity mismatches', () => {
    expect(() => keysetCondition(['a', 'b'], [1], 'asc')).toThrow(/arity/)
  })
})
