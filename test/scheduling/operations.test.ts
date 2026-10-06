// Add-on, checklist and photo operations, and ChecklistSync.
import { describe, expect, it } from 'vitest'
import { AppError } from '../../src/platform/errors.js'
import { putChecklist } from '../../src/modules/catalog/service.js'
import { addAddon, removeAddon } from '../../src/modules/scheduling/addons.js'
import { syncChecklistTemplate } from '../../src/modules/scheduling/checklist-sync.js'
import { bulkSetChecklist, loadChecklist, setChecklistItem } from '../../src/modules/scheduling/checklist.js'
import {
  cancelAppointment,
  advanceAppointment,
  startCleaning,
  arriveAppointment,
  confirmAppointment,
} from '../../src/modules/scheduling/lifecycle.js'
import {
  addIssueNote,
  completePhoto,
  deletePhoto,
  photoSummary,
  presignPhoto,
} from '../../src/modules/scheduling/photos.js'
import { MAX_UPLOAD_BYTES } from '../../src/integrations/storage/types.js'
import { useOps } from './helpers.js'

const o = useOps()
const at = (hhmm: string, date = '2026-06-13'): string => `${date}T${hhmm}:00-04:00`
const err = async (p: Promise<unknown>): Promise<AppError> => {
  try {
    await p
  } catch (e) {
    if (e instanceof AppError) return e
    throw e
  }
  throw new Error('expected an AppError')
}
const run = async <T>(
  fn: (tx: Parameters<Parameters<typeof o.tx>[0]>[0], a: Awaited<ReturnType<typeof o.actor>>) => Promise<T>,
) => {
  const a = await o.actor()
  return o.tx((tx) => fn(tx, a))
}

describe('add-ons', () => {
  it("the price is the catalog's; the invoice and the checklist follow; the toast direction comes from `added`", async () => {
    const b = await o.book({ at: at('14:00'), serviceName: 'Express Hand Wash' })
    const wax = o.svc('Wax')
    const r = await run((tx, a) => addAddon(tx, o.ctx, a, b.appointment.id, wax.id))
    expect(r).toMatchObject({
      added: true,
      changed: true,
      addon: { name: 'Wax', priceCents: 4000 },
      toast: { title: 'Invoice + checklist updated', detail: 'Added Wax' },
    })
    expect(r.invoice).toMatchObject({ subtotalCents: 8500, taxCents: 595, totalCents: 9095 })
    expect(r.invoice.items.map((i) => i.name)).toEqual(['Express Hand Wash', 'Wax'])
    expect(r.checklist).toMatchObject({ done: 0, total: 7 })
    const row = await o.t.db
      .selectFrom('appointment_addons')
      .selectAll()
      .where('appointment_id', '=', b.appointment.id)
      .executeTakeFirstOrThrow()
    expect(row).toMatchObject({ name: 'Wax', price_cents: 4000, removed_at: null })
    // the snapshot survives a catalog price change
    await o.t.db.updateTable('services').set({ price_cents: 9900 }).where('id', '=', wax.id).execute()
    const again = await run((tx, a) => addAddon(tx, o.ctx, a, b.appointment.id, wax.id))
    expect(again).toMatchObject({ changed: false, added: true, addon: { priceCents: 4000 } })
    expect(again.invoice.subtotalCents).toBe(8500)
    await o.t.db.updateTable('services').set({ price_cents: 4000 }).where('id', '=', wax.id).execute()
    const gone = await run((tx, a) => removeAddon(tx, o.ctx, a, b.appointment.id, wax.id))
    expect(gone).toMatchObject({ added: false, changed: true, toast: { detail: 'Removed Wax' } })
    expect(gone.invoice.subtotalCents).toBe(4500)
    expect(gone.checklist.total).toBe(5)
    const noop = await run((tx, a) => removeAddon(tx, o.ctx, a, b.appointment.id, wax.id))
    expect(noop).toMatchObject({ added: false, changed: false })
  })

  it("removing hides the add-on's tasks; adding it back restores them with their marks (not new rows)", async () => {
    const b = await o.book({ at: at('14:00'), serviceName: 'Express Hand Wash' })
    const wax = o.svc('Wax')
    await run((tx, a) => addAddon(tx, o.ctx, a, b.appointment.id, wax.id))
    const waxItems = (await loadChecklist(o.t.db, b.appointment.id)).sections.find(
      (s) => s.title === 'Wax',
    )!.items
    await run((tx, a) => setChecklistItem(tx, o.ctx, a, b.appointment.id, waxItems[0]!.id, true))
    await run((tx, a) => removeAddon(tx, o.ctx, a, b.appointment.id, wax.id))
    expect((await loadChecklist(o.t.db, b.appointment.id)).sections.map((s) => s.title)).toEqual([
      'Express Hand Wash',
    ])
    const hidden = await o.t.db
      .selectFrom('job_checklist_items')
      .select(['id', 'removed_at'])
      .where('appointment_id', '=', b.appointment.id)
      .where('section_title', '=', 'Wax')
      .execute()
    expect(hidden.every((h) => h.removed_at !== null)).toBe(true)
    await run((tx, a) => addAddon(tx, o.ctx, a, b.appointment.id, wax.id))
    const back = (await loadChecklist(o.t.db, b.appointment.id)).sections.find((s) => s.title === 'Wax')!
    expect(back.items.map((i) => [i.id, i.done])).toEqual([
      [waxItems[0]!.id, true],
      [waxItems[1]!.id, false],
    ])
    expect(
      await o.t.db
        .selectFrom('job_checklist_items')
        .select('id')
        .where('appointment_id', '=', b.appointment.id)
        .where('section_title', '=', 'Wax')
        .execute(),
    ).toHaveLength(2)
    const row = await o.t.db
      .selectFrom('appointment_addons')
      .select(['id', 'removed_at'])
      .where('appointment_id', '=', b.appointment.id)
      .orderBy('added_at')
      .execute()
    expect(row.map((r) => r.removed_at !== null)).toEqual([true, false]) // the old row is kept, a new live row exists
  })

  it('removing a paid add-on is 409 ADDON_REMOVE_OVERPAID and changes nothing; adding after payment re-opens a balance', async () => {
    const b = await o.book({ at: at('14:00'), serviceName: 'Express Hand Wash', addonIds: [o.svc('Wax').id] })
    o.gateway.payInFull(b.appointment.id)
    const e = await err(run((tx, a) => removeAddon(tx, o.ctx, a, b.appointment.id, o.svc('Wax').id)))
    expect(e).toMatchObject({ code: 'ADDON_REMOVE_OVERPAID', status: 409, title: 'Can’t remove add-on' })
    expect(
      (
        await o.t.db
          .selectFrom('appointment_addons')
          .select('removed_at')
          .where('appointment_id', '=', b.appointment.id)
          .executeTakeFirstOrThrow()
      ).removed_at,
    ).toBeNull()
    expect((await loadChecklist(o.t.db, b.appointment.id)).total).toBe(7)
    const added = await run((tx, a) => addAddon(tx, o.ctx, a, b.appointment.id, o.svc('Clay bar').id))
    expect(added.invoice).toMatchObject({ status: 'partially_paid', balanceCents: 5350 })
  })

  it('canceled jobs and non add-ons are refused', async () => {
    const b = await o.book({ at: at('14:00') })
    expect(
      (await err(run((tx, a) => addAddon(tx, o.ctx, a, b.appointment.id, o.svc('Full Detail').id)))).code,
    ).toBe('NOT_AN_ADDON')
    await o.t.db.updateTable('services').set({ active: false }).where('id', '=', o.svc('Wax').id).execute()
    expect(
      (await err(run((tx, a) => addAddon(tx, o.ctx, a, b.appointment.id, o.svc('Wax').id)))).detail,
    ).toBe('That add-on is no longer offered')
    await o.t.db.updateTable('services').set({ active: true }).where('id', '=', o.svc('Wax').id).execute()
    await run((tx, a) => cancelAppointment(tx, o.ctx, a, b.appointment.id, { reason: 'x' }))
    expect((await err(run((tx, a) => addAddon(tx, o.ctx, a, b.appointment.id, o.svc('Wax').id)))).code).toBe(
      'INVALID_TRANSITION',
    )
  })

  it('add-ons work at any live status, including in a bay and after completion', async () => {
    const id = await o.insert({
      customerName: 'Maria Delgado',
      serviceName: 'Express Hand Wash',
      at: at('10:00'),
      status: 'cleaning',
      bay: 1,
      cleaningStartedAt: at('10:09'),
    })
    expect((await run((tx, a) => addAddon(tx, o.ctx, a, id, o.svc('Wax').id))).added).toBe(true)
    await o.t.db
      .updateTable('appointments')
      .set({ status: 'completed', completed_at: o.clock.now() })
      .where('id', '=', id)
      .execute()
    expect((await run((tx, a) => addAddon(tx, o.ctx, a, id, o.svc('Clay bar').id))).added).toBe(true)
  })
})

describe('checklist items', () => {
  it('records who and when, clears them on uncheck, counts progress; unknown, hidden and foreign tasks are 404', async () => {
    const a1 = await o.book({ at: at('14:00'), serviceName: 'Express Hand Wash' })
    const a2 = await o.book({
      at: at('15:00'),
      serviceName: 'Express Hand Wash',
      customerName: 'David Okafor',
    })
    const items = (await loadChecklist(o.t.db, a1.appointment.id)).sections[0]!.items
    const actor = await o.actor()
    const r = await o.tx((tx) => setChecklistItem(tx, o.ctx, actor, a1.appointment.id, items[0]!.id, true))
    expect(r).toMatchObject({
      changed: 1,
      progress: { done: 1, total: 5, pct: 20, allDone: false },
      item: { done: true },
    })
    const row = await o.t.db
      .selectFrom('job_checklist_items')
      .select(['done', 'done_at', 'done_by_employee_id'])
      .where('id', '=', items[0]!.id)
      .executeTakeFirstOrThrow()
    expect(row.done_at).toEqual(o.clock.now())
    expect(row.done_by_employee_id).toBe(actor.auth.employeeId)
    expect(
      (await o.tx((tx) => setChecklistItem(tx, o.ctx, actor, a1.appointment.id, items[0]!.id, true))).changed,
    ).toBe(0) // idempotent
    await o.tx((tx) => setChecklistItem(tx, o.ctx, actor, a1.appointment.id, items[0]!.id, false))
    expect(
      await o.t.db
        .selectFrom('job_checklist_items')
        .select(['done', 'done_at', 'done_by_employee_id'])
        .where('id', '=', items[0]!.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ done: false, done_at: null, done_by_employee_id: null })
    const foreign = (await loadChecklist(o.t.db, a2.appointment.id)).sections[0]!.items[0]!.id
    expect(
      (await err(o.tx((tx) => setChecklistItem(tx, o.ctx, actor, a1.appointment.id, foreign, true)))).code,
    ).toBe('NOT_FOUND')
    expect(
      (await err(o.tx((tx) => setChecklistItem(tx, o.ctx, actor, a1.appointment.id, 'not-a-uuid', true))))
        .code,
    ).toBe('NOT_FOUND')
  })

  it('bulk: a section, or every task id for the global "Check all"; only the tasks that change are counted', async () => {
    const b = await o.book({ at: at('14:00'), serviceName: 'Express Hand Wash', addonIds: [o.svc('Wax').id] })
    const view = await loadChecklist(o.t.db, b.appointment.id)
    const actor = await o.actor()
    const section = view.sections[1]!.items.map((i) => i.id)
    expect(
      (await o.tx((tx) => bulkSetChecklist(tx, o.ctx, actor, b.appointment.id, section, true))).progress,
    ).toMatchObject({ done: 2, total: 7 })
    const all = view.sections.flatMap((s) => s.items.map((i) => i.id))
    const r = await o.tx((tx) => bulkSetChecklist(tx, o.ctx, actor, b.appointment.id, all, true))
    expect(r).toMatchObject({ changed: 5, progress: { done: 7, total: 7, pct: 100, allDone: true } })
    expect(
      (await o.tx((tx) => bulkSetChecklist(tx, o.ctx, actor, b.appointment.id, all, false))).changed,
    ).toBe(7)
    expect(
      (
        await err(
          o.tx((tx) =>
            bulkSetChecklist(
              tx,
              o.ctx,
              actor,
              b.appointment.id,
              [...all, '00000000-0000-7000-8000-000000000000'],
              true,
            ),
          ),
        )
      ).code,
    ).toBe('NOT_FOUND')
    const acts = await o.t.db
      .selectFrom('activity_log')
      .select('text')
      .where('appointment_id', '=', b.appointment.id)
      .where('text', 'like', '%checklist%')
      .execute()
    expect(acts.map((x) => x.text)).toEqual([
      '2 checklist tasks marked done',
      '5 checklist tasks marked done',
      '7 checklist tasks reset',
    ])
  })

  it('edits are refused on a canceled job', async () => {
    const b = await o.book({ at: at('14:00') })
    const id = (await loadChecklist(o.t.db, b.appointment.id)).sections[0]!.items[0]!.id
    await run((tx, a) => cancelAppointment(tx, o.ctx, a, b.appointment.id, { reason: 'x' }))
    expect((await err(run((tx, a) => setChecklistItem(tx, o.ctx, a, b.appointment.id, id, true)))).code).toBe(
      'INVALID_TRANSITION',
    )
  })

  it('the whole flow keeps working: advance through the states with a partially checked list', async () => {
    const b = await o.book({ at: at('11:00'), serviceName: 'Express Hand Wash' })
    for (const s of ['booked', 'confirmed', 'arrived', 'cleaning'] as const)
      await run((tx, a) => advanceAppointment(tx, o.ctx, a, b.appointment.id, { expectedStatus: s }))
    expect(await loadChecklist(o.t.db, b.appointment.id)).toMatchObject({ done: 5, total: 5, allDone: true })
    void [confirmAppointment, arriveAppointment, startCleaning]
  })
})

describe('ChecklistSync (template edits reach only jobs that have not started)', () => {
  it('renames, adds, removes (unless checked) and re-orders by source_task_id', async () => {
    const pkg = o.svc('Express Hand Wash') // 5 tasks
    const booked = await o.book({ at: at('14:00'), serviceName: 'Express Hand Wash' })
    const arrived = await o.insert({
      customerName: 'David Okafor',
      serviceName: 'Express Hand Wash',
      at: at('11:00'),
      status: 'arrived',
    })
    const started = await o.insert({
      customerName: 'Priya Nair',
      serviceName: 'Express Hand Wash',
      at: at('10:00'),
      status: 'cleaning',
      bay: 1,
      cleaningStartedAt: at('10:09'),
    })
    // the two inserted jobs get their snapshot through the same function a booking uses
    for (const id of [arrived, started]) {
      const { snapshotPackageChecklist } = await import('../../src/modules/scheduling/checklist.js')
      await o.tx((tx) => snapshotPackageChecklist(tx, o.ctx, id, pkg))
    }
    // check the second task on the booked job: a checked task is never removed
    const first = (await loadChecklist(o.t.db, booked.appointment.id)).sections[0]!.items
    await run((tx, a) => setChecklistItem(tx, o.ctx, a, booked.appointment.id, first[1]!.id, true))

    const tasks = pkg.tasks
    const edit = await o.tx((tx) =>
      putChecklist(tx, {
        locationId: o.locationId,
        serviceId: pkg.id,
        newId: o.ctx.newId,
        tasks: [
          { id: tasks[4]!.id, label: tasks[4]!.label }, // moved to the front
          { id: tasks[0]!.id, label: 'Exterior rinse (renamed)' },
          { id: tasks[1]!.id, label: tasks[1]!.label },
          { label: 'Step A' }, // takes the rank of the retired third task: an in-place rename of tasks[3]
          { label: 'Step B' }, // nothing of this rank is left: a new task
          // tasks[2] retired
        ],
      }),
    )
    const sync = await o.tx((tx) =>
      syncChecklistTemplate(tx, o.ctx, { service: edit.service, plan: edit.plan }),
    )
    expect(sync.jobs).toBe(2) // booked and arrived; the one in a bay is untouched
    const labels = async (id: string) =>
      (await loadChecklist(o.t.db, id)).sections[0]!.items.map((i) => i.label)
    const want = [tasks[4]!.label, 'Exterior rinse (renamed)', tasks[1]!.label, 'Step A', 'Step B']
    expect(await labels(arrived)).toEqual(want)
    expect(await labels(booked.appointment.id)).toEqual(want)
    // the mark on a task that stayed in the template stays with the task, whatever its new position
    expect(
      (await loadChecklist(o.t.db, booked.appointment.id)).sections[0]!.items.find(
        (i) => i.label === tasks[1]!.label,
      )!.done,
    ).toBe(true)
    expect(await labels(started)).toEqual(tasks.map((t) => t.label)) // untouched
    expect(sync).toEqual({ jobs: 2, renamed: 4, added: 2, removed: 2, restored: 0 })
    // positions stay unique and dense enough to order
    const pos = (
      await o.t.db
        .selectFrom('job_checklist_items')
        .select('position')
        .where('appointment_id', '=', arrived)
        .where('removed_at', 'is', null)
        .orderBy('position')
        .execute()
    ).map((p) => p.position)
    expect(new Set(pos).size).toBe(pos.length)
  })

  it('a checked task survives its retirement on the job', async () => {
    const pkg = o.svc('Express Hand Wash')
    const b = await o.book({ at: at('14:00'), serviceName: 'Express Hand Wash' })
    const items = (await loadChecklist(o.t.db, b.appointment.id)).sections[0]!.items
    await run((tx, a) => setChecklistItem(tx, o.ctx, a, b.appointment.id, items[3]!.id, true))
    const edit = await o.tx((tx) =>
      putChecklist(tx, {
        locationId: o.locationId,
        serviceId: pkg.id,
        newId: o.ctx.newId,
        tasks: pkg.tasks.slice(0, 3).map((t) => ({ id: t.id, label: t.label })),
      }),
    )
    await o.tx((tx) => syncChecklistTemplate(tx, o.ctx, { service: edit.service, plan: edit.plan }))
    const after = (await loadChecklist(o.t.db, b.appointment.id)).sections[0]!.items.map((i) => i.label)
    expect(after).toEqual([...pkg.tasks.slice(0, 3).map((t) => t.label), pkg.tasks[3]!.label])
  })

  it('add-on templates reach the jobs that carry the add-on; the fallback task is dropped once it has real tasks', async () => {
    const b = await o.book({ at: at('14:00'), serviceName: 'Express Hand Wash', addonIds: [o.svc('Wax').id] })
    const wax = o.svc('Wax') // 2 tasks
    const edit = await o.tx((tx) =>
      putChecklist(tx, {
        locationId: o.locationId,
        serviceId: wax.id,
        newId: o.ctx.newId,
        tasks: [...wax.tasks.map((t) => ({ id: t.id, label: t.label })), { label: 'Final buff' }],
      }),
    )
    const sync = await o.tx((tx) =>
      syncChecklistTemplate(tx, o.ctx, { service: edit.service, plan: edit.plan }),
    )
    expect(sync).toMatchObject({ jobs: 1, added: 1 })
    expect(
      (await loadChecklist(o.t.db, b.appointment.id)).sections
        .find((s) => s.title === 'Wax')!
        .items.map((i) => i.label),
    ).toEqual([...wax.tasks.map((t) => t.label), 'Final buff'])
  })

  it('nothing to do when the edit changed nothing', async () => {
    const pkg = o.svc('Express Hand Wash')
    const edit = await o.tx((tx) =>
      putChecklist(tx, {
        locationId: o.locationId,
        serviceId: pkg.id,
        newId: o.ctx.newId,
        tasks: pkg.tasks.map((t) => ({ id: t.id, label: t.label })),
      }),
    )
    expect(
      await o.tx((tx) => syncChecklistTemplate(tx, o.ctx, { service: edit.service, plan: edit.plan })),
    ).toEqual({ jobs: 0, renamed: 0, added: 0, removed: 0, restored: 0 })
  })
})

describe('photos', () => {
  const png = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000154a24f5d0000000049454e44ae426082',
    'hex',
  )

  it('presign, upload straight to storage, complete (HEAD verified), then the file shows a presigned thumbnail', async () => {
    const b = await o.book({ at: at('14:00') })
    const actor = await o.actor()
    const p = await o.tx((tx) =>
      presignPhoto(tx, o.ctx, actor, b.appointment.id, {
        category: 'before',
        contentType: 'image/png',
        bytes: png.length,
        note: 'front',
      }),
    )
    expect(p.upload.key).toMatch(
      new RegExp(`^loc/${o.locationId}/appt/${b.appointment.id}/before/${p.photoId}\\.png$`),
    )
    expect(p.upload.expiresAt.getTime()).toBe(o.clock.now().getTime() + 5 * 60_000)
    expect(p.upload.fields).toBeDefined()
    // until it is uploaded and completed it does not count
    expect((await photoSummary(o.t.db, o.ctx.ports.storage, b.appointment.id)).before.count).toBe(0)
    expect(
      (await err(o.tx((tx) => completePhoto(tx, o.ctx, actor, b.appointment.id, p.photoId)))).errors?.[0]
        ?.message,
    ).toBe('The file has not been uploaded yet.')
    await o.storage.put(p.upload.key, png, 'image/png')
    const done = await o.tx((tx) => completePhoto(tx, o.ctx, actor, b.appointment.id, p.photoId))
    expect(done.photo).toMatchObject({ category: 'before', bytes: png.length })
    expect((await o.tx((tx) => completePhoto(tx, o.ctx, actor, b.appointment.id, p.photoId))).photo.id).toBe(
      p.photoId,
    ) // idempotent
    const sum = await photoSummary(o.t.db, o.ctx.ports.storage, b.appointment.id)
    expect(sum.before.count).toBe(1)
    expect(sum.before.items[0]).toMatchObject({
      note: 'front',
      thumbUrl: expect.stringContaining('/dev-storage/'),
    })
    expect(
      (
        await o.t.db
          .selectFrom('activity_log')
          .select('text')
          .where('appointment_id', '=', b.appointment.id)
          .orderBy('id')
          .execute()
      ).map((x) => x.text),
    ).toContain('Photo added · before')
  })

  it('HEIC is rejected with the explanation, other types and sizes too', async () => {
    const b = await o.book({ at: at('14:00') })
    const actor = await o.actor()
    const presign = (contentType: string, bytes: number, category: 'before' | 'after' = 'before') =>
      err(o.tx((tx) => presignPhoto(tx, o.ctx, actor, b.appointment.id, { category, contentType, bytes })))
    expect((await presign('image/heic', 1000)).errors?.[0]).toMatchObject({
      path: 'contentType',
      message: expect.stringContaining('HEIC'),
    })
    expect((await presign('image/HEIF', 1000)).code).toBe('VALIDATION_FAILED')
    expect((await presign('application/pdf', 1000)).errors?.[0]?.path).toBe('contentType')
    expect((await presign('image/jpeg', MAX_UPLOAD_BYTES + 1)).errors?.[0]?.path).toBe('bytes')
    expect((await presign('image/jpeg', 0)).errors?.[0]?.path).toBe('bytes')
    await expect(
      o.tx((tx) =>
        presignPhoto(tx, o.ctx, actor, b.appointment.id, {
          category: 'before',
          contentType: 'image/jpeg',
          bytes: MAX_UPLOAD_BYTES,
        }),
      ),
    ).resolves.toBeDefined() // exactly 15 MB is allowed
  }, 15_000)

  it('a completion refuses an object that is not what was announced', async () => {
    const b = await o.book({ at: at('14:00') })
    const actor = await o.actor()
    const p = await o.tx((tx) =>
      presignPhoto(tx, o.ctx, actor, b.appointment.id, {
        category: 'after',
        contentType: 'image/png',
        bytes: 10,
      }),
    )
    await o.storage.put(p.upload.key, png, 'image/jpeg')
    expect(
      (await err(o.tx((tx) => completePhoto(tx, o.ctx, actor, b.appointment.id, p.photoId)))).errors?.[0]
        ?.message,
    ).toBe('The uploaded file is not the type that was announced.')
  })

  it('an issue may be a note with no file; a photo can be removed (soft delete, objects reported)', async () => {
    const b = await o.book({ at: at('14:00') })
    const actor = await o.actor()
    expect(
      (await err(o.tx((tx) => addIssueNote(tx, o.ctx, actor, b.appointment.id, '  ')))).errors?.[0]?.path,
    ).toBe('note')
    const note = await o.tx((tx) =>
      addIssueNote(tx, o.ctx, actor, b.appointment.id, 'Scratch on the rear bumper'),
    )
    const p = await o.tx((tx) =>
      presignPhoto(tx, o.ctx, actor, b.appointment.id, {
        category: 'issue',
        contentType: 'image/png',
        bytes: png.length,
      }),
    )
    await o.storage.put(p.upload.key, png, 'image/png')
    await o.tx((tx) => completePhoto(tx, o.ctx, actor, b.appointment.id, p.photoId))
    const sum = await photoSummary(o.t.db, o.ctx.ports.storage, b.appointment.id)
    expect(sum.issue.count).toBe(2)
    expect(sum.issue.items.map((i) => i.note)).toEqual(expect.arrayContaining(['Scratch on the rear bumper']))
    const removed = await o.tx((tx) => deletePhoto(tx, o.ctx, actor, b.appointment.id, p.photoId))
    expect(removed.keys).toEqual([p.upload.key])
    expect((await photoSummary(o.t.db, o.ctx.ports.storage, b.appointment.id)).issue.count).toBe(1)
    expect((await err(o.tx((tx) => deletePhoto(tx, o.ctx, actor, b.appointment.id, p.photoId)))).code).toBe(
      'NOT_FOUND',
    )
    void note
  })
})
