// Holidays and closures: list with real affected counts, preview, create/patch/delete with the design's strings.
import { access } from '../../../http/access.js'
import { z } from '../../../http/zod.js'
import { AppError } from '../../../platform/errors.js'
import { isValidBizDate, bizWeekday, tryParseT, toBizDate, fmtT } from '../../../platform/time.js'
import {
  closureSubLine,
  closureTypeLabel,
  createClosure,
  deleteClosure,
  listClosureViews,
  previewClosure,
  updateClosure,
  type ClosureRecord,
  type ClosureView,
} from '../closures.js'
import type { ClosureType } from '../schema.js'
import { businessTzOf, idem, inTx, requestContext, storedUserId, type SettingsRuntime } from './runtime.js'

const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'] as const
const DOW = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const

export const ClosureItem = z.object({
  id: z.string(),
  date: z.string(),
  mon: z.string(),
  day: z.string(),
  dow: z.string(),
  name: z.string(),
  type: z.enum(['closed', 'reduced']),
  from: z.string().nullable(),
  to: z.string().nullable(),
  fromMin: z.number().int().nullable(),
  toMin: z.number().int().nullable(),
  notify: z.boolean(),
  source: z.enum(['manual', 'federal', 'emergency']),
  emergency: z.boolean(),
  federalKey: z.string().nullable(),
  typeLabel: z.string().describe('"Emergency", "Closed all day" or "Reduced · 10:00 AM – 2:00 PM"'),
  past: z.boolean(),
  affectedCount: z.number().int().nullable().describe('Real count of customers booked; null for past rows'),
  subLine: z.string().nullable(),
})
export type ClosureItem = z.infer<typeof ClosureItem>

export const ClosureList = z.object({
  federalAuto: z.boolean(),
  upcoming: z.array(ClosureItem),
  past: z.array(ClosureItem),
})

export function closureItem(
  c: Pick<
    ClosureRecord,
    'id' | 'date' | 'name' | 'type' | 'openMin' | 'closeMin' | 'notify' | 'source' | 'federalKey'
  >,
  o: { past: boolean; affectedCount: number | null },
): ClosureItem {
  const month = Number(c.date.slice(5, 7))
  return {
    id: c.id,
    date: c.date,
    mon: MON[month - 1]!,
    day: String(Number(c.date.slice(8, 10))),
    dow: DOW[bizWeekday(c.date)]!,
    name: c.name,
    type: c.type,
    from: c.type === 'reduced' && c.openMin !== null ? fmtT(c.openMin) : null,
    to: c.type === 'reduced' && c.closeMin !== null ? fmtT(c.closeMin) : null,
    fromMin: c.type === 'reduced' ? c.openMin : null,
    toMin: c.type === 'reduced' ? c.closeMin : null,
    notify: c.notify,
    source: c.source,
    emergency: c.source === 'emergency',
    federalKey: c.federalKey,
    typeLabel: closureTypeLabel(c),
    past: o.past,
    affectedCount: o.affectedCount,
    subLine: o.affectedCount === null ? null : closureSubLine(c.type, o.affectedCount),
  }
}

export const closureListView = (
  l: Awaited<ReturnType<typeof listClosureViews>>,
): z.infer<typeof ClosureList> => ({
  federalAuto: l.federalAuto,
  upcoming: l.upcoming.map((c: ClosureView) =>
    closureItem(c, { past: false, affectedCount: c.affectedCount }),
  ),
  past: l.past.map((c: ClosureView) => closureItem(c, { past: true, affectedCount: null })),
})

const TimeText = z.string().max(12)
const WindowIn = {
  from: TimeText.optional(),
  to: TimeText.optional(),
  fromMin: z.number().int().optional(),
  toMin: z.number().int().optional(),
}

function timeOf(text: string | undefined, min: number | undefined, path: string): number | undefined {
  if (min !== undefined) return min
  if (text === undefined) return undefined
  const v = tryParseT(text)
  if (v === null)
    throw new AppError('VALIDATION_FAILED', {
      detail: 'Use a time like 10:00 AM.',
      errors: [{ path, message: 'Use a time like 10:00 AM.' }],
    })
  return v
}

const windowOf = (b: { from?: string; to?: string; fromMin?: number; toMin?: number }) => ({
  openMin: timeOf(b.from, b.fromMin, 'from'),
  closeMin: timeOf(b.to, b.toMin, 'to'),
})

const dateQuery = z
  .string()
  .refine((s) => isValidBizDate(s), 'Use a date like 2026-06-13')
  .optional()

export function registerClosureRoutes(rt: SettingsRuntime): void {
  const { app } = rt

  app.get(
    '/closures',
    {
      config: { access: access.authenticated() },
      schema: {
        tags: ['settings'],
        operationId: 'listClosures',
        summary:
          'Closures and holidays: upcoming (date ascending) and past (newest first), plus the federal toggle',
        description:
          'Each upcoming row carries the real number of customers booked that day (for reduced days, those outside the open window). Past rows are history only. `from`/`to` filter by date (inclusive).',
        querystring: z.object({ from: dateQuery, to: dateQuery }),
        response: { 200: ClosureList },
      },
    },
    async (req) => {
      const c = requestContext(req)
      const tz = await businessTzOf(app.db, c.locationId, app.env.BUSINESS_TZ)
      const list = await listClosureViews(app.db, {
        locationId: c.locationId,
        today: toBizDate(app.clock.now(), tz),
        tz,
        counter: rt.ports().counter,
        from: req.query.from,
        to: req.query.to,
      })
      return closureListView(list)
    },
  )

  app.post(
    '/closures/preview',
    {
      config: { access: access.perm('set.hours') },
      schema: {
        tags: ['settings'],
        operationId: 'previewClosure',
        summary: 'How many customers a closure would touch (drives "N customers are booked that day")',
        body: z
          .object({
            date: z.string().max(10).optional(),
            type: z.enum(['closed', 'reduced']).default('closed'),
            ...WindowIn,
          })
          .strict(),
        response: { 200: z.object({ affected: z.number().int() }) },
      },
    },
    async (req) => {
      const c = requestContext(req)
      const tz = await businessTzOf(app.db, c.locationId, app.env.BUSINESS_TZ)
      return previewClosure(app.db, {
        locationId: c.locationId,
        date: req.body.date ?? '',
        type: req.body.type as ClosureType,
        ...windowOf(req.body),
        tz,
        counter: rt.ports().counter,
      })
    },
  )

  app.post(
    '/closures',
    {
      config: { access: access.perm('set.hours'), idempotency: 'optional' },
      schema: {
        tags: ['settings'],
        operationId: 'createClosure',
        summary: 'Add a closed day or reduced hours; messages the affected customers when notify is on',
        description:
          'Errors are 422 with the design strings: "Add a date and a name." and "There\'s already a closure on that date.". `notify` defaults to true (the design default). ' +
          'Idempotency-Key is optional. Publishes `settings.changed {section: "closures"}`.',
        body: z
          .object({
            date: z.string().max(10).optional(),
            name: z.string().max(200).optional(),
            type: z.enum(['closed', 'reduced']).default('closed'),
            notify: z.boolean().optional(),
            ...WindowIn,
          })
          .strict(),
        response: {
          201: z.object({
            closure: ClosureItem,
            affectedCount: z.number().int(),
            notified: z.number().int(),
          }),
        },
      },
    },
    idem(async (req, tx) => {
      const body = req.body as {
        date?: string
        name?: string
        type: ClosureType
        notify?: boolean
        from?: string
        to?: string
        fromMin?: number
        toMin?: number
      }
      const c = requestContext(req)
      const tz = await businessTzOf(tx, c.locationId, app.env.BUSINESS_TZ)
      const r = await createClosure(tx, {
        locationId: c.locationId,
        date: body.date ?? '',
        name: body.name ?? '',
        type: body.type,
        ...windowOf(body),
        notify: body.notify,
        createdBy: await storedUserId(tx, c.userId),
        tz,
        newId: app.newId,
        counter: rt.ports().counter,
        notifier: rt.ports().closureNotifier(c.locationId),
        audit: c.audit,
      })
      const today = toBizDate(app.clock.now(), tz)
      return {
        status: 201,
        body: {
          closure: closureItem(r.closure, { past: r.closure.date < today, affectedCount: r.affectedCount }),
          affectedCount: r.affectedCount,
          notified: r.notified,
        },
      }
    }),
  )

  app.patch(
    '/closures/:id',
    {
      config: { access: access.perm('set.hours') },
      schema: {
        tags: ['settings'],
        operationId: 'updateClosure',
        summary: 'Edit a closure: notify, name, or type and hours (how Labor Day becomes reduced)',
        description:
          'The notify switch only matters at creation: toggling it later stores the flag and sends nothing. The date is fixed. Emergency closures answer 409 CLOSURE_LOCKED.',
        params: z.object({ id: z.string().uuid() }),
        body: z
          .object({
            notify: z.boolean().optional(),
            name: z.string().max(200).optional(),
            type: z.enum(['closed', 'reduced']).optional(),
            ...WindowIn,
          })
          .strict(),
        response: { 200: ClosureItem },
      },
    },
    async (req) => {
      const c = requestContext(req)
      const tz = await businessTzOf(app.db, c.locationId, app.env.BUSINESS_TZ)
      const { notify, name, type } = req.body
      const win = windowOf(req.body)
      const updated = await inTx(app.db, (tx) =>
        updateClosure(tx, {
          locationId: c.locationId,
          id: req.params.id,
          patch: { notify, name, type: type as ClosureType | undefined, ...win },
          audit: c.audit,
        }),
      )
      const today = toBizDate(app.clock.now(), tz)
      const past = updated.date < today
      const affectedCount = past
        ? null
        : await rt.ports().counter.count(
            app.db,
            {
              locationId: c.locationId,
              date: updated.date,
              type: updated.type,
              openMin: updated.openMin,
              closeMin: updated.closeMin,
            },
            tz,
          )
      return closureItem(updated, { past, affectedCount })
    },
  )

  app.delete(
    '/closures/:id',
    {
      config: { access: access.perm('set.hours') },
      schema: {
        tags: ['settings'],
        operationId: 'deleteClosure',
        summary:
          'Remove a closure (soft delete; sends nothing; a removed federal holiday is never regenerated)',
        params: z.object({ id: z.string().uuid() }),
        response: {
          200: z.object({ id: z.string(), name: z.string(), date: z.string(), removed: z.literal(true) }),
        },
      },
    },
    async (req) => {
      const c = requestContext(req)
      const gone = await inTx(app.db, (tx) =>
        deleteClosure(tx, { locationId: c.locationId, id: req.params.id, audit: c.audit }),
      )
      return { id: gone.id, name: gone.name, date: gone.date, removed: true as const }
    },
  )
}
