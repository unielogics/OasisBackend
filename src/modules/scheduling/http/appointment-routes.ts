// /appointments*: booking, the file, the lifecycle commands, add-ons, checklist and photos.
import { access } from '../../../http/access.js'
import { idempotentHandler } from '../../../http/idempotent.js'
import { z } from '../../../http/zod.js'
import type { AppInstance } from '../../../http/types.js'
import { transaction, type Tx } from '../../../platform/db.js'
import { paginationQuery } from '../../../platform/pagination.js'
import { canSeeContact } from '../../people/redact.js'
import { addAddon, removeAddon } from '../addons.js'
import { createAppointment } from '../booking.js'
import { bulkSetChecklist, setChecklistItem } from '../checklist.js'
import { loadAppointmentFile } from '../file.js'
import {
  advanceAppointment,
  arriveAppointment,
  assignToBay,
  cancelAppointment,
  completeAppointment,
  confirmAppointment,
  markNoShow,
  notifyReady,
  prepBay,
  reopenAppointment,
  rescheduleAppointment,
  setPickup,
  startCleaning,
  updateDetails,
} from '../lifecycle.js'
import { listAppointments } from '../list.js'
import { addIssueNote, completePhoto, deletePhoto, presignPhoto } from '../photos.js'
import type { SchedulingPorts } from '../ports.js'
import { thumbnailJobName } from '../photo-jobs.js'
import {
  AddonChange,
  AppointmentFile,
  BookingResult,
  ChecklistChange,
  CommandResult,
  OpsCard,
  OverrideBody,
  Status,
  BizDate,
  Uuid,
} from './schemas.js'
import { actorOf, ctxOf, instant } from './shared.js'

const TAGS = ['appointments']
const IdParams = z.object({ id: Uuid })
const IsoStart = z.iso.datetime({ offset: true })

const CustomerInput = z
  .object({
    id: Uuid.optional(),
    name: z.string().trim().max(120).nullish(),
    phone: z.string().trim().max(40).nullish(),
    email: z.string().trim().max(254).nullish(),
    smsOptIn: z.boolean().optional(),
  })
  .strict()

const VehicleInput = z
  .object({
    year: z.number().int().min(1900).max(2100).nullish(),
    make: z.string().trim().max(60).nullish(),
    model: z.string().trim().max(60).nullish(),
    color: z.string().trim().max(40).nullish(),
    plate: z.string().trim().max(20).nullish(),
  })
  .strict()

const BookingBody = z
  .object({
    customer: CustomerInput,
    vehicle: VehicleInput.nullish(),
    serviceId: Uuid,
    addonIds: z.array(Uuid).max(20).optional(),
    start: IsoStart.optional(),
    walkIn: z.boolean().optional(),
    source: z.enum(['dashboard', 'walk_in', 'phone']).optional(),
    assignedEmployeeId: Uuid.nullish(),
    plannedBayId: Uuid.nullish(),
    notes: z.string().max(1000).nullish(),
    specialInstructions: z.string().max(1000).nullish(),
    override: OverrideBody.optional(),
  })
  .strict()

const DepositPolicy = z.enum(['keep', 'refund_card', 'refund_credit'])

/** idempotentHandler answers through reply.send, which the typed route handler cannot express; the runtime schema still applies. */
const idempotent = (h: ReturnType<typeof idempotentHandler>): never => h as never

export function registerAppointmentRoutes(app: AppInstance, ports: SchedulingPorts): void {
  const inTx = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => transaction(app.db, fn)

  // Reads ---------------------------------------------------------------------------------------------------------

  app.get(
    '/appointments',
    {
      config: { access: access.perm('sched.view') },
      schema: {
        tags: TAGS,
        summary: 'Appointments in a date range (cards), oldest first',
        description:
          'Keyset paged by (start, booking order). `q` searches name, vehicle and package, and the phone only with cli.contact.',
        querystring: paginationQuery.extend({
          from: BizDate.optional(),
          to: BizDate.optional(),
          status: Status.optional(),
          customerId: Uuid.optional(),
          q: z.string().max(100).optional(),
        }),
        response: { 200: z.object({ items: z.array(OpsCard), nextCursor: z.string().nullable() }) },
      },
    },
    async (req) =>
      listAppointments(app.db, await ctxOf(app, req, ports), {
        ...req.query,
        canContact: canSeeContact(req.auth!),
      }),
  )

  app.get(
    '/appointments/:id',
    {
      config: { access: access.perm('sched.view') },
      schema: {
        tags: TAGS,
        summary: 'The appointment file',
        description:
          'Overview, add-ons with the catalog, checklist sections, photo counts with presigned thumbnails (valid 10 minutes), activity, invoice summary, membership and history. Phone and email are masked without cli.contact.',
        params: IdParams,
        response: { 200: AppointmentFile },
      },
    },
    async (req) => loadAppointmentFile(app.db, await ctxOf(app, req, ports), req.auth!, req.params.id),
  )

  // Booking -------------------------------------------------------------------------------------------------------

  app.post(
    '/appointments',
    {
      config: { access: access.perm('sched.edit'), idempotency: 'required' },
      schema: {
        tags: TAGS,
        summary: 'Book an appointment or a walk-in',
        description:
          'Upserts the customer by phone and the vehicle by plate, validates the slot under a lock (409 SLOT_UNAVAILABLE "Would overbook a bay — override required", SLOT_VIP_HELD, SLOT_CLOSED, SLOT_OUTSIDE_HOURS, SLOT_PAST), plans a bay, snapshots the checklist, creates the invoice and queues the booking SMS. `override.reason` needs sched.override and records an appointment_overrides row. Send `start` or `walkIn: true` (the next slot on the grid).',
        body: BookingBody,
        response: { 201: BookingResult },
      },
    },
    idempotent(
      idempotentHandler(async (req, tx) => {
        const c = await ctxOf(app, req, ports)
        const b = req.body as z.infer<typeof BookingBody>
        const r = await createAppointment(tx, c, actorOf(req), {
          customer: b.customer,
          vehicle: b.vehicle,
          serviceId: b.serviceId,
          addonIds: b.addonIds,
          start: b.start ? instant(b.start) : undefined,
          walkIn: b.walkIn,
          source: b.source,
          assignedEmployeeId: b.assignedEmployeeId,
          plannedBayId: b.plannedBayId,
          notes: b.notes,
          specialInstructions: b.specialInstructions,
          override: b.override,
        })
        return { status: 201, body: r, headers: { Location: `/api/v1/appointments/${r.appointment.id}` } }
      }),
    ),
  )

  app.patch(
    '/appointments/:id',
    {
      config: { access: access.perm('sched.edit') },
      schema: {
        tags: TAGS,
        summary: 'Plan a bay without starting, assign staff, edit notes',
        params: IdParams,
        body: z
          .object({
            plannedBayId: Uuid.nullable().optional(),
            assignedEmployeeId: Uuid.nullable().optional(),
            notes: z.string().max(1000).nullable().optional(),
            specialInstructions: z.string().max(1000).nullable().optional(),
            version: z.number().int().optional(),
          })
          .strict(),
        response: { 200: CommandResult },
      },
    },
    async (req) => {
      const c = await ctxOf(app, req, ports)
      const { version, ...patch } = req.body
      return inTx((tx) => updateDetails(tx, c, actorOf(req), req.params.id, patch, version))
    },
  )

  // Lifecycle -----------------------------------------------------------------------------------------------------

  app.post(
    '/appointments/:id/confirm',
    {
      config: { access: access.anyPerm('sched.edit', 'jobs.status') },
      schema: {
        tags: TAGS,
        summary: 'booked to confirmed (queues the confirmation SMS)',
        params: IdParams,
        response: { 200: CommandResult },
      },
    },
    async (req) =>
      inTx(async (tx) => confirmAppointment(tx, await ctxOf(app, req, ports), actorOf(req), req.params.id)),
  )

  app.post(
    '/appointments/:id/arrive',
    {
      config: { access: access.anyPerm('jobs.status', 'sched.edit') },
      schema: {
        tags: TAGS,
        summary: 'booked or confirmed to arrived',
        description: '`source: geofence` also records the geofence check-in and queues the welcome SMS.',
        params: IdParams,
        body: z
          .object({ source: z.enum(['manual', 'geofence']).optional() })
          .strict()
          .optional(),
        response: { 200: CommandResult },
      },
    },
    async (req) =>
      inTx(async (tx) =>
        arriveAppointment(tx, await ctxOf(app, req, ports), actorOf(req), req.params.id, {
          source: req.body?.source,
        }),
      ),
  )

  app.post(
    '/appointments/:id/start',
    {
      config: { access: access.perm('jobs.status') },
      schema: {
        tags: TAGS,
        summary: 'arrived to cleaning in a bay',
        description:
          'Bay: the request `bayId`, else the planned bay, else the lowest-numbered free active bay. 409 BAY_BUSY ("Bay N is busy" / "Finish {First}’s vehicle first"), BAY_UNAVAILABLE, NO_BAY_FREE.',
        params: IdParams,
        body: z.object({ bayId: Uuid.optional() }).strict().optional(),
        response: { 200: CommandResult },
      },
    },
    async (req) =>
      inTx(async (tx) =>
        startCleaning(tx, await ctxOf(app, req, ports), actorOf(req), req.params.id, {
          bayId: req.body?.bayId,
        }),
      ),
  )

  app.post(
    '/appointments/:id/assign-bay',
    {
      config: { access: access.perm('jobs.status') },
      schema: {
        tags: TAGS,
        summary: 'Drag onto a bay: booked, confirmed or arrived jobs of today start cleaning',
        description:
          'Guards: ALREADY_IN_BAY ("Already in a bay" / "That vehicle is in Bay N"), NOT_TODAY, BAY_UNAVAILABLE, BAY_BUSY. A booked or confirmed job arrives implicitly (both steps are logged).',
        params: IdParams,
        body: z.object({ bayId: Uuid }).strict(),
        response: { 200: CommandResult },
      },
    },
    async (req) =>
      inTx(async (tx) =>
        assignToBay(tx, await ctxOf(app, req, ports), actorOf(req), req.params.id, { bayId: req.body.bayId }),
      ),
  )

  app.post(
    '/appointments/:id/complete',
    {
      config: { access: access.perm('jobs.status') },
      schema: {
        tags: TAGS,
        summary: 'cleaning to completed: checks the remaining tasks, queues the ready SMS, frees the bay',
        params: IdParams,
        response: { 200: CommandResult },
      },
    },
    async (req) =>
      inTx(async (tx) => completeAppointment(tx, await ctxOf(app, req, ports), actorOf(req), req.params.id)),
  )

  app.post(
    '/appointments/:id/advance',
    {
      config: { access: access.anyPerm('jobs.status', 'sched.edit') },
      schema: {
        tags: TAGS,
        summary: 'The next step of the status the screen showed',
        description:
          '`expectedStatus` is required: a stale screen gets 409 STALE_STATE with `meta.currentStatus`. confirm and arrive need sched.edit or jobs.status; start and complete need jobs.status. A completed job has no next step here: collect payment on the invoice.',
        params: IdParams,
        body: z.object({ expectedStatus: Status }).strict(),
        response: { 200: CommandResult },
      },
    },
    async (req) =>
      inTx(async (tx) =>
        advanceAppointment(tx, await ctxOf(app, req, ports), actorOf(req), req.params.id, {
          expectedStatus: req.body.expectedStatus,
        }),
      ),
  )

  app.post(
    '/appointments/:id/cancel',
    {
      config: { access: access.perm('sched.cancel'), idempotency: 'required' },
      schema: {
        tags: TAGS,
        summary: 'Cancel a booked or confirmed appointment',
        description:
          'Reason required; `notify` texts the client. The invoice is canceled through the payments gateway (a deposit stays on it: canceled_kept). `deposit` records the policy; refunding is a payments command.',
        params: IdParams,
        body: z
          .object({
            reason: z.string().trim().min(1).max(300),
            notify: z.boolean().optional(),
            deposit: DepositPolicy.optional(),
          })
          .strict(),
        response: { 200: CommandResult },
      },
    },
    idempotent(
      idempotentHandler(async (req, tx) => {
        const b = req.body as { reason: string; notify?: boolean; deposit?: z.infer<typeof DepositPolicy> }
        const r = await cancelAppointment(
          tx,
          await ctxOf(app, req, ports),
          actorOf(req),
          (req.params as { id: string }).id,
          b,
        )
        return { status: 200, body: r }
      }),
    ),
  )

  app.post(
    '/appointments/:id/no-show',
    {
      config: { access: access.perm('sched.cancel'), idempotency: 'required' },
      schema: {
        tags: TAGS,
        summary: 'Mark a no-show (only after the start plus the late grace); cancels the invoice',
        params: IdParams,
        response: { 200: CommandResult },
      },
    },
    idempotent(
      idempotentHandler(async (req, tx) => {
        const r = await markNoShow(
          tx,
          await ctxOf(app, req, ports),
          actorOf(req),
          (req.params as { id: string }).id,
        )
        return { status: 200, body: r }
      }),
    ),
  )

  app.post(
    '/appointments/:id/reopen',
    {
      config: { access: access.perm('sched.cancel') },
      schema: {
        tags: TAGS,
        summary: 'canceled or no-show back to booked (the slot is revalidated)',
        params: IdParams,
        body: z.object({ start: IsoStart.optional(), override: OverrideBody.optional() }).strict().optional(),
        response: { 200: CommandResult },
      },
    },
    async (req) =>
      inTx(async (tx) =>
        reopenAppointment(tx, await ctxOf(app, req, ports), actorOf(req), req.params.id, {
          start: req.body?.start ? instant(req.body.start) : undefined,
          override: req.body?.override,
        }),
      ),
  )

  app.post(
    '/appointments/:id/reschedule',
    {
      config: { access: access.perm('sched.edit') },
      schema: {
        tags: TAGS,
        summary: 'Move to a new start (capacity-checked, may cross days)',
        description:
          'CANT_MOVE_JOB ("Can’t move this job" / "It’s already in progress or done") for cleaning and completed jobs. `override.reason` needs sched.override.',
        params: IdParams,
        body: z.object({ start: IsoStart, override: OverrideBody.optional() }).strict(),
        response: { 200: CommandResult },
      },
    },
    async (req) =>
      inTx(async (tx) =>
        rescheduleAppointment(tx, await ctxOf(app, req, ports), actorOf(req), req.params.id, {
          start: instant(req.body.start),
          override: req.body.override,
        }),
      ),
  )

  app.post(
    '/appointments/:id/prep-bay',
    {
      config: { access: access.anyPerm('jobs.status', 'sched.edit') },
      schema: {
        tags: TAGS,
        summary: 'Mark the bay prepped for an arriving car (not reversible)',
        params: IdParams,
        response: { 200: CommandResult },
      },
    },
    async (req) => inTx(async (tx) => prepBay(tx, await ctxOf(app, req, ports), actorOf(req), req.params.id)),
  )

  app.post(
    '/appointments/:id/pickup',
    {
      config: { access: access.perm('jobs.status') },
      schema: {
        tags: TAGS,
        summary: 'Release the vehicle (collected) or reopen the pickup (pending)',
        description: 'Not gated on payment, as in the design. No message is sent.',
        params: IdParams,
        body: z.object({ state: z.enum(['collected', 'pending']) }).strict(),
        response: { 200: CommandResult },
      },
    },
    async (req) =>
      inTx(async (tx) =>
        setPickup(tx, await ctxOf(app, req, ports), actorOf(req), req.params.id, { state: req.body.state }),
      ),
  )

  app.post(
    '/appointments/:id/notify-ready',
    {
      config: { access: access.perm('msg.send') },
      schema: {
        tags: TAGS,
        summary: 'Re-send the ready-for-pickup SMS',
        params: IdParams,
        response: { 200: CommandResult },
      },
    },
    async (req) =>
      inTx(async (tx) => notifyReady(tx, await ctxOf(app, req, ports), actorOf(req), req.params.id)),
  )

  // Add-ons -------------------------------------------------------------------------------------------------------

  const AddonParams = z.object({ id: Uuid, serviceId: Uuid })

  app.put(
    '/appointments/:id/addons/:serviceId',
    {
      config: { access: access.perm('sched.edit') },
      schema: {
        tags: TAGS,
        summary: 'Add an add-on (price from the catalog; invoice and checklist follow)',
        params: AddonParams,
        response: { 200: AddonChange },
      },
    },
    async (req) =>
      inTx(async (tx) =>
        addAddon(tx, await ctxOf(app, req, ports), actorOf(req), req.params.id, req.params.serviceId),
      ),
  )

  app.delete(
    '/appointments/:id/addons/:serviceId',
    {
      config: { access: access.perm('sched.edit') },
      schema: {
        tags: TAGS,
        summary: 'Remove an add-on',
        description:
          '409 ADDON_REMOVE_OVERPAID when the invoice would be left overpaid: refund or adjust instead.',
        params: AddonParams,
        response: { 200: AddonChange },
      },
    },
    async (req) =>
      inTx(async (tx) =>
        removeAddon(tx, await ctxOf(app, req, ports), actorOf(req), req.params.id, req.params.serviceId),
      ),
  )

  // Checklist -----------------------------------------------------------------------------------------------------

  app.put(
    '/appointments/:id/checklist/items/:itemId',
    {
      config: { access: access.perm('jobs.checklist') },
      schema: {
        tags: TAGS,
        summary: 'Check or clear one task (records who and when)',
        params: z.object({ id: Uuid, itemId: Uuid }),
        body: z.object({ done: z.boolean() }).strict(),
        response: {
          200: ChecklistChange.extend({
            item: z.object({
              id: z.string(),
              label: z.string(),
              done: z.boolean(),
              position: z.number().int(),
            }),
          }),
        },
      },
    },
    async (req) =>
      inTx(async (tx) =>
        setChecklistItem(
          tx,
          await ctxOf(app, req, ports),
          actorOf(req),
          req.params.id,
          req.params.itemId,
          req.body.done,
        ),
      ),
  )

  app.post(
    '/appointments/:id/checklist/bulk',
    {
      config: { access: access.perm('jobs.checklist') },
      schema: {
        tags: TAGS,
        summary: 'Check or clear many tasks (a section, or every task id for "Check all")',
        params: IdParams,
        body: z.object({ itemIds: z.array(Uuid).max(200), done: z.boolean() }).strict(),
        response: { 200: ChecklistChange },
      },
    },
    async (req) =>
      inTx(async (tx) =>
        bulkSetChecklist(
          tx,
          await ctxOf(app, req, ports),
          actorOf(req),
          req.params.id,
          req.body.itemIds,
          req.body.done,
        ),
      ),
  )

  // Photos --------------------------------------------------------------------------------------------------------

  app.post(
    '/appointments/:id/photos/presign',
    {
      config: { access: access.perm('jobs.checklist') },
      schema: {
        tags: TAGS,
        summary: 'Start a photo upload: a presigned POST with a size policy',
        description:
          'JPEG, PNG or WebP up to 15 MB. HEIC is rejected (422): the dashboard converts on the device. Upload the file to `upload.url` with `upload.fields`, then call complete.',
        params: IdParams,
        body: z
          .object({
            category: z.enum(['arrival', 'before', 'after', 'issue']),
            contentType: z.string().min(1).max(100),
            bytes: z.number().int(),
            note: z.string().max(500).nullish(),
          })
          .strict(),
        response: {
          201: z.object({
            photoId: z.string(),
            upload: z.object({
              key: z.string(),
              url: z.string(),
              fields: z.record(z.string(), z.string()),
              expiresAt: z.string(),
            }),
          }),
        },
      },
    },
    async (req, reply) => {
      const c = await ctxOf(app, req, ports)
      const r = await inTx((tx) => presignPhoto(tx, c, actorOf(req), req.params.id, req.body))
      return reply
        .status(201)
        .send({ photoId: r.photoId, upload: { ...r.upload, expiresAt: r.upload.expiresAt.toISOString() } })
    },
  )

  app.post(
    '/appointments/:id/photos/:photoId/complete',
    {
      config: { access: access.perm('jobs.checklist') },
      schema: {
        tags: TAGS,
        summary: 'Verify the uploaded object (size and type) and mark the photo ready',
        params: z.object({ id: Uuid, photoId: Uuid }),
        response: {
          200: z.object({
            photo: z.object({ id: z.string(), category: z.string(), bytes: z.number().int() }),
          }),
        },
      },
    },
    async (req) => {
      const c = await ctxOf(app, req, ports)
      const r = await inTx((tx) => completePhoto(tx, c, actorOf(req), req.params.id, req.params.photoId))
      await app.jobs
        ?.enqueue(thumbnailJobName, { photoId: r.photo.id }, { singletonKey: r.photo.id })
        .catch(() => null)
      return { photo: { id: r.photo.id, category: r.photo.category, bytes: r.photo.bytes } }
    },
  )

  app.post(
    '/appointments/:id/photos/note',
    {
      config: { access: access.perm('jobs.checklist') },
      schema: {
        tags: TAGS,
        summary: 'Add a written issue note with no file',
        params: IdParams,
        body: z.object({ note: z.string().trim().min(1).max(500) }).strict(),
        response: { 201: z.object({ photoId: z.string() }) },
      },
    },
    async (req, reply) => {
      const c = await ctxOf(app, req, ports)
      const r = await inTx((tx) => addIssueNote(tx, c, actorOf(req), req.params.id, req.body.note))
      return reply.status(201).send(r)
    },
  )

  app.delete(
    '/appointments/:id/photos/:photoId',
    {
      config: { access: access.perm('jobs.checklist') },
      schema: {
        tags: TAGS,
        summary: 'Remove a photo (soft delete; the objects are deleted after commit)',
        params: z.object({ id: Uuid, photoId: Uuid }),
        response: { 200: z.object({ removed: z.boolean() }) },
      },
    },
    async (req) => {
      const c = await ctxOf(app, req, ports)
      const r = await inTx((tx) => deletePhoto(tx, c, actorOf(req), req.params.id, req.params.photoId))
      for (const key of r.keys) await ports.storage.delete(key).catch(() => undefined)
      return { removed: true }
    },
  )
}
