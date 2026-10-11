// Kysely types of the columns migration 20261012020000_assistant_tools.sql adds (ADR 0160, wave W3b), by module augmentation:
// customers.archived_at (the welcome flow's 30-day archive of nameless, never-booked provisional clients) and vehicles.vehicle_type
// (set_my_vehicle: the tint price class).
import '../../customers/schema.js'

export type VehicleType = 'sedan_coupe' | 'suv_crossover' | 'truck_van'
export const VEHICLE_TYPES: readonly VehicleType[] = ['sedan_coupe', 'suv_crossover', 'truck_van']

declare module '../../customers/schema.js' {
  interface CustomersTable {
    /** Set with deleted_at when the welcome flow archived a nameless, never-booked provisional client; cleared on restore. */
    archived_at: Date | null
  }
  interface VehiclesTable {
    /** The tint price class (catalog.tint_matrix vehicle type key), when known. */
    vehicle_type: VehicleType | null
  }
}
