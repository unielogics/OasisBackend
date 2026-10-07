import { sql } from 'kysely'
import type { Executor } from '../../../platform/db.js'
import type { AppointmentRef, AppointmentStatus } from '../inbound/attribution.js'
import type { CustomerDirectory } from '../inbound/repositories.js'
import '../schema.js'
import '../../customers/schema.js'

const STATUS: Record<string, AppointmentStatus> = {
  booked: 'booked',
  confirmed: 'confirmed',
  arrived: 'arrived',
  cleaning: 'cleaning',
  completed: 'completed',
  canceled: 'canceled',
  no_show: 'noshow',
}

/** Resolves a texting number to a live customer and lists the appointments an inbound text can be about. */
export class PgCustomerDirectory implements CustomerDirectory {
  constructor(
    private readonly exec: Executor,
    private readonly locationId: string,
  ) {}

  async findByPhone(phone: string): Promise<{ id: string; firstName?: string } | null> {
    const r = await this.exec
      .selectFrom('customers')
      .select(['id', 'full_name'])
      .where('phone_e164', '=', phone)
      .where('merged_into', 'is', null)
      .where('deleted_at', 'is', null)
      .executeTakeFirst()
    return r ? { id: r.id, firstName: r.full_name.trim().split(/\s+/)[0] } : null
  }

  /** The 14-day completed window and the 72-hour upcoming window both fit inside 30 days either side of now. */
  async listAppointments(customerId: string): Promise<AppointmentRef[]> {
    const rows = await this.exec
      .selectFrom('appointments')
      .select(['id', 'status', 'scheduled_start', 'completed_at'])
      .where('customer_id', '=', customerId)
      .where('location_id', '=', this.locationId)
      .where('scheduled_start', '>=', sql<Date>`app_now() - interval '30 days'`)
      .where('scheduled_start', '<=', sql<Date>`app_now() + interval '30 days'`)
      .orderBy('scheduled_start', 'desc')
      .limit(100)
      .execute()
    return rows.map((r) => ({ id: r.id, status: STATUS[r.status] ?? 'booked', start: r.scheduled_start, completedAt: r.completed_at }))
  }
}
