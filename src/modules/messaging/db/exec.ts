import { sql } from 'kysely'
import type { Executor, Tx } from '../../../platform/db.js'
import '../schema.js'
import '../../customers/schema.js'

/** Runs fn inside the caller's transaction, or opens a short one when given a plain connection. */
export function inTx<T>(exec: Executor, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return exec.isTransaction ? fn(exec as Tx) : exec.transaction().execute(fn)
}

/** The database clock twin (oasis.now when a synthetic clock is mirrored, else the wall clock). */
export const dbNow = sql<Date>`app_now()`

export const isUniqueViolation = (e: unknown): boolean => (e as { code?: string } | null)?.code === '23505'
