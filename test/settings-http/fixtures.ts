// The design's Saturday: six appointments still to come (Marcus Webb 10:15 through Elena Volkov 3:00 PM) and three
// vehicles on site, at the frozen clock 2026-06-13 10:36 America/New_York.
import {
  edt,
  makeAppointment,
  makeBay,
  makeCustomer,
  makeService,
  makeVehicle,
  type Fixture,
} from '../domain-schema/helpers.js'
import type { Db } from '../../src/platform/db.js'
import type { AppointmentStatus } from '../../src/modules/customers/schema.js'

export const REMAINING = [
  ['10:15', 'Marcus Webb', 'Jeep', 'Wrangler'],
  ['10:45', 'Liam Chen', 'BMW', 'M340i'],
  ['11:00', 'Grace Adeyemi', 'Lexus', 'RX 350'],
  ['12:00', 'Aisha Rahman', 'Land Rover', 'Range Rover Sport'],
  ['13:30', 'Tom Bradley', 'Honda', 'Civic'],
  ['15:00', 'Elena Volkov', 'Lamborghini', 'Urus'],
] as const

let bayNumber = 0

export interface Booked {
  id: string
  customerId: string
  name: string
}

export async function bookCustomer(
  db: Db,
  fx: Fixture,
  o: {
    name: string
    date: string
    time: string
    status?: AppointmentStatus
    make?: string
    model?: string
    customer?: Parameters<typeof makeCustomer>[2]
    pickupState?: 'pending' | 'collected' | null
  },
): Promise<Booked> {
  const customerId = await makeCustomer(db, fx, { name: o.name, ...o.customer })
  const vehicleId = await makeVehicle(db, fx, customerId, { make: o.make ?? 'Honda', model: o.model ?? 'Civic' })
  const serviceId = await makeService(db, fx, { name: `Wash for ${o.name}` })
  // a job in a bay needs the bay (check constraint: cleaning implies bay_id)
  const bayId = o.status === 'cleaning' ? await makeBay(db, fx, (bayNumber += 1)) : null
  const id = await makeAppointment(db, fx, {
    customerId,
    serviceId,
    vehicleId,
    start: edt(o.date, o.time),
    status: o.status ?? 'booked',
    bayId,
    pickupState: o.pickupState,
  })
  return { id, customerId, name: o.name }
}

export async function seedDesignDay(db: Db, fx: Fixture): Promise<Booked[]> {
  const out: Booked[] = []
  for (const [time, name, make, model] of REMAINING)
    out.push(await bookCustomer(db, fx, { name, date: '2026-06-13', time, make, model }))
  await bookCustomer(db, fx, { name: 'On Site One', date: '2026-06-13', time: '08:30', status: 'arrived' })
  await bookCustomer(db, fx, { name: 'On Site Two', date: '2026-06-13', time: '09:00', status: 'cleaning' })
  await bookCustomer(db, fx, {
    name: 'Waiting Pickup',
    date: '2026-06-13',
    time: '08:00',
    status: 'completed',
    pickupState: 'pending',
  })
  await bookCustomer(db, fx, { name: 'Canceled Early', date: '2026-06-13', time: '09:30', status: 'canceled' })
  return out
}
