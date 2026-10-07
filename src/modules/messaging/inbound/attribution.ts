export type AppointmentStatus =
  'booked' | 'confirmed' | 'arrived' | 'cleaning' | 'completed' | 'canceled' | 'noshow'

export interface AppointmentRef {
  id: string
  status: AppointmentStatus
  start: Date
  completedAt?: Date | null
}

export type AttributionBasis = 'in_progress' | 'upcoming' | 'recent_completed'

export interface Attribution {
  appointmentId: string
  basis: AttributionBasis
}

export interface AttributionConfig {
  /** Upcoming appointments count when they start within this horizon. Default 72 h. */
  upcomingWithinMs: number
  /** Completed appointments count when they finished within this window. Default 14 days. */
  completedWithinMs: number
  /** A booked/confirmed appointment that started this recently still counts as "upcoming" (a late customer replying). */
  lateGraceMs: number
}

export const DEFAULT_ATTRIBUTION: AttributionConfig = {
  upcomingWithinMs: 72 * 3600_000,
  completedWithinMs: 14 * 24 * 3600_000,
  lateGraceMs: 2 * 3600_000,
}

/**
 * Picks the appointment an inbound message is about: a job in progress, else the nearest upcoming one within 72 h, else the
 * last completed one within 14 days. Cancelled and no-show appointments never attract replies.
 */
export function attributeInbound(
  appointments: readonly AppointmentRef[],
  now: Date,
  cfg: AttributionConfig = DEFAULT_ATTRIBUTION,
): Attribution | null {
  const t = now.getTime()

  const inProgress = appointments
    .filter((a) => a.status === 'arrived' || a.status === 'cleaning')
    .sort((a, b) => b.start.getTime() - a.start.getTime())[0]
  if (inProgress) return { appointmentId: inProgress.id, basis: 'in_progress' }

  const upcoming = appointments
    .filter((a) => a.status === 'booked' || a.status === 'confirmed')
    .filter((a) => a.start.getTime() >= t - cfg.lateGraceMs && a.start.getTime() - t <= cfg.upcomingWithinMs)
    .sort((a, b) => Math.abs(a.start.getTime() - t) - Math.abs(b.start.getTime() - t))[0]
  if (upcoming) return { appointmentId: upcoming.id, basis: 'upcoming' }

  const completed = appointments
    .filter((a) => a.status === 'completed')
    .map((a) => ({ a, at: (a.completedAt ?? a.start).getTime() }))
    .filter((x) => x.at <= t && t - x.at <= cfg.completedWithinMs)
    .sort((x, y) => y.at - x.at)[0]
  if (completed) return { appointmentId: completed.a.id, basis: 'recent_completed' }

  return null
}

/** The next booked-but-unconfirmed appointment that has not started yet. */
export function nextUnconfirmed(appointments: readonly AppointmentRef[], now: Date): AppointmentRef | null {
  return (
    appointments
      .filter((a) => a.status === 'booked' && a.start.getTime() >= now.getTime())
      .sort((a, b) => a.start.getTime() - b.start.getTime())[0] ?? null
  )
}
