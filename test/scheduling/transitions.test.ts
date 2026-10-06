// The whole state machine as a table: every command against every status, with the resulting status or the guard error.
import { describe, expect, it } from 'vitest'
import { AppError } from '../../src/platform/errors.js'
import {
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
  type CommandResult,
} from '../../src/modules/scheduling/lifecycle.js'
import { useOps } from './helpers.js'

const o = useOps()
const at = (hhmm: string): string => `2026-06-13T${hhmm}:00-04:00`
const STATUSES = ['booked', 'confirmed', 'arrived', 'cleaning', 'completed', 'canceled', 'no_show'] as const
type Status = (typeof STATUSES)[number]
type Cmd =
  | 'confirm'
  | 'arrive'
  | 'start'
  | 'assign-bay'
  | 'complete'
  | 'cancel'
  | 'no-show'
  | 'reopen'
  | 'reschedule'
  | 'prep-bay'
  | 'pickup'
  | 'notify-ready'

/** status -> what the command does: the new status, or the error code. */
const TABLE: Record<Cmd, Record<Status, string>> = {
  confirm: {
    booked: 'confirmed',
    confirmed: 'INVALID_TRANSITION',
    arrived: 'INVALID_TRANSITION',
    cleaning: 'INVALID_TRANSITION',
    completed: 'INVALID_TRANSITION',
    canceled: 'INVALID_TRANSITION',
    no_show: 'INVALID_TRANSITION',
  },
  arrive: {
    booked: 'arrived',
    confirmed: 'arrived',
    arrived: 'INVALID_TRANSITION',
    cleaning: 'INVALID_TRANSITION',
    completed: 'INVALID_TRANSITION',
    canceled: 'INVALID_TRANSITION',
    no_show: 'INVALID_TRANSITION',
  },
  start: {
    booked: 'INVALID_TRANSITION',
    confirmed: 'INVALID_TRANSITION',
    arrived: 'cleaning',
    cleaning: 'ALREADY_IN_BAY',
    completed: 'INVALID_TRANSITION',
    canceled: 'INVALID_TRANSITION',
    no_show: 'INVALID_TRANSITION',
  },
  'assign-bay': {
    booked: 'cleaning',
    confirmed: 'cleaning',
    arrived: 'cleaning',
    cleaning: 'ALREADY_IN_BAY',
    completed: 'INVALID_TRANSITION',
    canceled: 'INVALID_TRANSITION',
    no_show: 'INVALID_TRANSITION',
  },
  complete: {
    booked: 'INVALID_TRANSITION',
    confirmed: 'INVALID_TRANSITION',
    arrived: 'INVALID_TRANSITION',
    cleaning: 'completed',
    completed: 'INVALID_TRANSITION',
    canceled: 'INVALID_TRANSITION',
    no_show: 'INVALID_TRANSITION',
  },
  cancel: {
    booked: 'canceled',
    confirmed: 'canceled',
    arrived: 'INVALID_TRANSITION',
    cleaning: 'INVALID_TRANSITION',
    completed: 'INVALID_TRANSITION',
    canceled: 'INVALID_TRANSITION',
    no_show: 'INVALID_TRANSITION',
  },
  'no-show': {
    booked: 'no_show',
    confirmed: 'no_show',
    arrived: 'INVALID_TRANSITION',
    cleaning: 'INVALID_TRANSITION',
    completed: 'INVALID_TRANSITION',
    canceled: 'INVALID_TRANSITION',
    no_show: 'INVALID_TRANSITION',
  },
  reopen: {
    booked: 'INVALID_TRANSITION',
    confirmed: 'INVALID_TRANSITION',
    arrived: 'INVALID_TRANSITION',
    cleaning: 'INVALID_TRANSITION',
    completed: 'INVALID_TRANSITION',
    canceled: 'booked',
    no_show: 'booked',
  },
  reschedule: {
    booked: 'booked',
    confirmed: 'confirmed',
    arrived: 'arrived',
    cleaning: 'CANT_MOVE_JOB',
    completed: 'CANT_MOVE_JOB',
    canceled: 'INVALID_TRANSITION',
    no_show: 'INVALID_TRANSITION',
  },
  'prep-bay': {
    booked: 'booked',
    confirmed: 'confirmed',
    arrived: 'arrived',
    cleaning: 'INVALID_TRANSITION',
    completed: 'INVALID_TRANSITION',
    canceled: 'INVALID_TRANSITION',
    no_show: 'INVALID_TRANSITION',
  },
  pickup: {
    booked: 'INVALID_TRANSITION',
    confirmed: 'INVALID_TRANSITION',
    arrived: 'INVALID_TRANSITION',
    cleaning: 'INVALID_TRANSITION',
    completed: 'completed',
    canceled: 'INVALID_TRANSITION',
    no_show: 'INVALID_TRANSITION',
  },
  'notify-ready': {
    booked: 'INVALID_TRANSITION',
    confirmed: 'INVALID_TRANSITION',
    arrived: 'INVALID_TRANSITION',
    cleaning: 'INVALID_TRANSITION',
    completed: 'completed',
    canceled: 'INVALID_TRANSITION',
    no_show: 'INVALID_TRANSITION',
  },
}

async function seedStatus(status: Status): Promise<string> {
  const base = { customerName: 'Maria Delgado', serviceName: 'Express Hand Wash', at: at('10:00') } // 36 minutes ago
  if (status === 'cleaning') return o.insert({ ...base, status, bay: 2, cleaningStartedAt: at('10:09') })
  if (status === 'completed') return o.insert({ ...base, status, completedAt: at('10:30') })
  return o.insert({ ...base, status })
}

async function run(cmd: Cmd, id: string): Promise<CommandResult> {
  const actor = await o.actor()
  return o.tx((tx) => {
    switch (cmd) {
      case 'confirm':
        return confirmAppointment(tx, o.ctx, actor, id)
      case 'arrive':
        return arriveAppointment(tx, o.ctx, actor, id)
      case 'start':
        return startCleaning(tx, o.ctx, actor, id, { bayId: o.bay(1) })
      case 'assign-bay':
        return assignToBay(tx, o.ctx, actor, id, { bayId: o.bay(1) })
      case 'complete':
        return completeAppointment(tx, o.ctx, actor, id)
      case 'cancel':
        return cancelAppointment(tx, o.ctx, actor, id, { reason: 'table test' })
      case 'no-show':
        return markNoShow(tx, o.ctx, actor, id)
      case 'reopen':
        return reopenAppointment(tx, o.ctx, actor, id)
      case 'reschedule':
        return rescheduleAppointment(tx, o.ctx, actor, id, { start: new Date(at('16:00')) })
      case 'prep-bay':
        return prepBay(tx, o.ctx, actor, id)
      case 'pickup':
        return setPickup(tx, o.ctx, actor, id, { state: 'collected' })
      case 'notify-ready':
        return notifyReady(tx, o.ctx, actor, id)
    }
  })
}

const cases = (Object.keys(TABLE) as Cmd[]).flatMap((cmd) =>
  STATUSES.map((status) => [cmd, status, TABLE[cmd][status]] as const),
)

describe('every command against every status', () => {
  it.each(cases)('%s from %s: %s', async (cmd, status, expected) => {
    const id = await seedStatus(status)
    const before = await o.t.db
      .selectFrom('appointments')
      .select(['status', 'version'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
    if (/^[A-Z_]+$/.test(expected)) {
      const e = await run(cmd, id).then(
        () => null,
        (x: unknown) => x as AppError,
      )
      expect(e, `${cmd} from ${status} should fail`).toBeInstanceOf(AppError)
      expect(e!.code).toBe(expected)
      expect(e!.status).toBe(409)
      // a refused command changes nothing
      const after = await o.t.db
        .selectFrom('appointments')
        .select(['status', 'version'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
      expect(after).toEqual(before)
    } else {
      const r = await run(cmd, id)
      expect(r.appointment.status).toBe(expected)
      const after = await o.t.db
        .selectFrom('appointments')
        .select(['status', 'version'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
      expect(after.status).toBe(expected)
      // pickup, prep-bay and a repeated notify are idempotent and may leave the version alone; the rest bump it
      if (!['pickup', 'prep-bay', 'notify-ready'].includes(cmd))
        expect(after.version).toBeGreaterThan(before.version)
    }
  })

  it('covers all 12 commands x 7 statuses', () => {
    expect(cases).toHaveLength(84)
  })
})
