// GET /public/catalog: the live services and add-ons with their keys, durations and prices in cents, as the dashboard's catalog
// has them, and the two plans the website sells (labels over the dashboard's plans; the site keeps its own prices as content).
import type { Executor } from '../../platform/db.js'
import { loadPlans } from '../memberships/plans.js'
import { loadBoardServices } from './availability-loader.js'
import { PUBLIC_TIERS } from './tiers.js'

export interface PublicService {
  key: string
  name: string
  shortName: string
  durationMin: number
  priceCents: number
  tags: string[]
}

export interface PublicAddon {
  key: string
  name: string
  priceCents: number
  tags: string[]
}

export interface PublicPlan {
  key: 'gold' | 'vip'
  name: string
  planKey: string
  /** The dashboard plan's name, when the plans are set up. */
  planName: string | null
  perks: string[]
  /** The site shows its own prices; the dashboard's plans carry none. */
  priceCents: null
}

export interface PublicCatalog {
  generatedAt: string
  services: PublicService[]
  addons: PublicAddon[]
  plans: PublicPlan[]
}

export async function loadPublicCatalog(db: Executor, locationId: string, now: Date): Promise<PublicCatalog> {
  const [services, plans] = await Promise.all([loadBoardServices(db, locationId), loadPlans(db, locationId)])
  return {
    generatedAt: now.toISOString(),
    services: services.packages.map((s) => ({
      key: s.key,
      name: s.name,
      shortName: s.shortName,
      durationMin: s.durationMin,
      priceCents: s.priceCents,
      tags: s.tags,
    })),
    addons: services.addons.map((s) => ({ key: s.key, name: s.name, priceCents: s.priceCents, tags: s.tags })),
    plans: PUBLIC_TIERS.map((t) => {
      const plan = plans.find((p) => p.key === t.planKey)
      return {
        key: t.key,
        name: t.label,
        planKey: t.planKey,
        planName: plan?.name ?? null,
        perks: plan?.perks ?? [],
        priceCents: null,
      }
    }),
  }
}
