// Seed profile "geofence": placeholder shop coordinates so the arrival ping (ADR 0083) can be tried on a seeded database. Downtown
// Miami, NOT the shop: set the real ones with PUT /settings/location. Never overwrites coordinates that are already set.
import { sql } from 'kysely'
import type { SeedProfile } from './index.js'

export const PLACEHOLDER_SHOP = { lat: 25.7617, lng: -80.1918 } as const

export const geofenceProfile: SeedProfile = {
  description: 'Placeholder shop coordinates for the arrival geofence (only when none are set)',
  dependsOn: ['base'],
  async run(ctx) {
    const r = await sql`
      update locations set lat = ${PLACEHOLDER_SHOP.lat}, lng = ${PLACEHOLDER_SHOP.lng}
      where id = ${ctx.location.id} and lat is null and lng is null`.execute(ctx.tx)
    ctx.log(
      `geofence: ${Number(r.numAffectedRows ?? 0) === 1 ? 'placeholder coordinates set' : 'coordinates already set, left alone'}`,
    )
  },
}
