// Interfaces the Settings services call out through. Real implementations arrive with Messaging, Memberships and the
// notification vertical; the in-memory ones here keep the services testable and make every effect observable.
import type { Executor, Tx } from '../../platform/db.js'
import type { ClosureType, NotificationState } from './schema.js'

export interface AffectedAppointment {
  appointmentId: string
  customerId: string
  customerName: string
  firstName: string
  /** "Jeep Wrangler" (make and model, as the design lists it). */
  vehicle: string | null
  vehicleYear: number | null
  startsAt: Date
  /** Business date of the start, YYYY-MM-DD (a multi-day list needs it, B50). */
  bizDate: string
  /** "10:15 AM". */
  time: string
  status: string
  phoneE164: string | null
  email: string | null
  /** True when the customer opted out of SMS (STOP). */
  smsOptedOut: boolean
}

export interface ClosureWindow {
  locationId: string
  date: string
  type: ClosureType
  /** The open window of a reduced day, minutes from midnight. */
  openMin?: number | null
  closeMin?: number | null
}

/** Real counts over appointments, behind an interface so Settings never depends on the scheduling module. */
export interface AffectedCounter {
  /** closed: non-canceled appointments that day; reduced: those starting outside the open window. */
  count(db: Executor, window: ClosureWindow, tz: string): Promise<number>
  list(db: Executor, window: ClosureWindow, tz: string): Promise<AffectedAppointment[]>
}

export interface ClosureNotice {
  closureId: string
  date: string
  name: string
  type: ClosureType
}

/** Messages the customers of a newly added closure (only when its notify flag is on). Deleting a closure sends nothing. */
export interface ClosureNotifier {
  notify(tx: Tx, notice: ClosureNotice, affected: AffectedAppointment[]): Promise<{ notified: number }>
}

export interface EmergencyNotifyRequest {
  locationId: string
  emergencyClosureId: string
  appointment: AffectedAppointment
  channel: 'sms' | 'email'
  /** The rendered message ({link} already substituted or its sentence removed). */
  message: string
  rescheduleLinkId: string | null
  rescheduleCode: string | null
  /** SMS dispatcher lane; emergency notices are priority 0 (throttled, reserved lane). */
  priority: 0
}

export interface EmergencyNotifyResult {
  state: NotificationState
  messageId?: string | null
}

/** Fan-out of the emergency message. May refine the state (for example skip a number the SMS policy refuses). */
export interface EmergencyNotifier {
  send(tx: Tx, req: EmergencyNotifyRequest): Promise<EmergencyNotifyResult>
}

/** Optional side effects of an emergency that other verticals own. */
export interface EmergencyEffects {
  /** "Protect member credits": restore credits reserved by these appointments. */
  protectCredits?(tx: Tx, ctx: { emergencyClosureId: string; appointmentIds: string[] }): Promise<void>
  /** "Alert on-shift crew": notifications for employees whose schedule includes now. */
  alertCrew?(tx: Tx, ctx: { emergencyClosureId: string; locationId: string; summary: string }): Promise<void>
}

/** Queues everything without sending: the default until the messaging vertical is wired. */
export const queueOnlyNotifier: EmergencyNotifier = {
  send: async () => ({ state: 'queued' }),
}

export const noopClosureNotifier: ClosureNotifier = {
  notify: async (_tx, _notice, affected) => ({ notified: affected.length }),
}

/** Records every call; tests assert on `sent`. */
export class RecordingEmergencyNotifier implements EmergencyNotifier {
  readonly sent: EmergencyNotifyRequest[] = []
  constructor(
    private readonly respond: (req: EmergencyNotifyRequest) => EmergencyNotifyResult = () => ({
      state: 'queued',
    }),
  ) {}
  async send(_tx: Tx, req: EmergencyNotifyRequest): Promise<EmergencyNotifyResult> {
    this.sent.push(req)
    return this.respond(req)
  }
}

export class RecordingClosureNotifier implements ClosureNotifier {
  readonly notices: { notice: ClosureNotice; affected: AffectedAppointment[] }[] = []
  async notify(
    _tx: Tx,
    notice: ClosureNotice,
    affected: AffectedAppointment[],
  ): Promise<{ notified: number }> {
    this.notices.push({ notice, affected })
    return { notified: affected.length }
  }
}
