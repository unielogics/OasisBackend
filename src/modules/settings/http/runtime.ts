// What the Settings routes need from the outside: injectable ports (notifier fan-out, side effects, counters) and the
// per-request context. server.ts configures the ports once at boot; tests pass their own through createSettingsModule.
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { AppDeps } from '../../../app.js'
import { auditContextOf } from '../../../http/authorizer.js'
import { idempotentHandler } from '../../../http/idempotent.js'
import type { AppInstance } from '../../../http/types.js'
import type { Clock } from '../../../platform/clock.js'
import type { Db, Executor, Tx } from '../../../platform/db.js'
import { AppError } from '../../../platform/errors.js'
import type * as audit from '../../../platform/audit.js'
import type { NewId } from '../../../platform/ids.js'
import { getLocation } from '../../../platform/locations.js'
import { DEFAULT_TZ } from '../../../platform/time.js'
import { parseIfMatch } from '../../people/routes.js'
import { createEmergencyEffects } from '../db-adapters/effects.js'
import { ActivityClosureNotifier, ActivityEmergencyNotifier } from '../db-adapters/notifiers.js'
import { dbHoursWarningHooks } from '../db-adapters/schedule-conflicts.js'
import { sqlAffectedCounter } from '../affected.js'
import type { AffectedCounter, ClosureNotifier, EmergencyEffects, EmergencyNotifier } from '../ports.js'
import type { HoursWarningHooks } from '../hours.js'

export interface ChecklistChange {
  locationId: string
  serviceId: string
  /** Task ids created, renamed, moved or retired by this save. */
  created: string[]
  renamed: string[]
  retired: string[]
}

export interface SettingsPorts {
  counter: AffectedCounter
  closureNotifier(locationId: string): ClosureNotifier
  emergencyNotifier: EmergencyNotifier
  emergencyEffects(o: { clock: Clock; newId: NewId; tz: string }): EmergencyEffects
  hoursHooks: HoursWarningHooks
  /**
   * Propagates a template change to jobs that have not started (design 4.9, ChecklistSync). The scheduling vertical
   * provides it; the default does nothing.
   */
  checklistSync(tx: Tx, change: ChecklistChange): Promise<void>
}

export const defaultSettingsPorts: SettingsPorts = {
  counter: sqlAffectedCounter,
  closureNotifier: (locationId) => new ActivityClosureNotifier(locationId),
  emergencyNotifier: new ActivityEmergencyNotifier(),
  emergencyEffects: (o) => createEmergencyEffects(o),
  hoursHooks: dbHoursWarningHooks,
  checklistSync: async () => undefined,
}

let configured: Partial<SettingsPorts> = {}

/** Boot-time wiring (src/server.ts). Later calls merge over earlier ones. */
export function configureSettings(p: Partial<SettingsPorts>): void {
  configured = { ...configured, ...p }
}

export interface SettingsRuntime {
  app: AppInstance
  deps: AppDeps
  ports(): SettingsPorts
}

export function createRuntime(
  app: AppInstance,
  deps: AppDeps,
  overrides: Partial<SettingsPorts> | undefined,
): SettingsRuntime {
  return {
    app,
    deps,
    ports: () => ({ ...defaultSettingsPorts, ...configured, ...overrides }),
  }
}

export interface RequestContext {
  locationId: string
  userId: string
  actorName: string | null
  audit: audit.AuditContext
}

export function requestContext(req: FastifyRequest): RequestContext {
  const a = req.auth
  if (!a) throw new AppError('UNAUTHENTICATED')
  return {
    locationId: a.locationId,
    userId: a.realUserId ?? a.userId,
    actorName: a.actorName ?? null,
    audit: auditContextOf(req),
  }
}

/** The user id to store in created_by / updated_by columns, or null when the caller has no users row (dev bypass). */
export async function storedUserId(db: Executor, userId: string): Promise<string | null> {
  const r = await db.selectFrom('users').select('id').where('id', '=', userId).executeTakeFirst()
  return r?.id ?? null
}

export async function businessTzOf(db: Executor, locationId: string, fallback?: string): Promise<string> {
  const loc = await getLocation(db, locationId).catch(() => undefined)
  return loc?.timezone ?? fallback ?? DEFAULT_TZ
}

/** `version` in the body wins over If-Match; undefined when neither is sent. */
export function expectedVersion(req: FastifyRequest, bodyVersion: number | undefined): number | undefined {
  if (bodyVersion !== undefined) return bodyVersion
  return req.headers['if-match'] ? parseIfMatch(req) : undefined
}

/** The version a dirty-tracked save must carry: 428 when the client sent none. */
export function requiredVersion(req: FastifyRequest, bodyVersion: number | undefined): number {
  const v = expectedVersion(req, bodyVersion)
  if (v === undefined) throw new AppError('PRECONDITION_REQUIRED')
  return v
}

export const etag = (reply: FastifyReply, version: number): void => void reply.header('ETag', `"${version}"`)

export const inTx = <T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> => db.transaction().execute(fn)

/**
 * idempotentHandler() answers through reply.send, so its type does not fit a route that declares a typed response schema.
 * The cast keeps the marker function the boot-time check looks for.
 */
export const idem = (fn: Parameters<typeof idempotentHandler>[0]): never => idempotentHandler(fn) as never
