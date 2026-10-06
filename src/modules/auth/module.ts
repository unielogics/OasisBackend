// Route-module entry points for auth and people, and how they find the Identity.
import type { AppDeps } from '../../app.js'
import type { ApiModule } from '../../http/modules.js'
import { createIdGenerator } from '../../platform/ids.js'
import { ensureLocation, getDefaultLocation } from '../../platform/locations.js'
import { registerPeopleRoutes } from '../people/routes.js'
import { createIdentity, type Identity, type IdentityAuthorizer } from './identity.js'
import { registerAuthRoutes, type IdentityProvider } from './routes.js'

const fallbacks = new WeakMap<object, Promise<Identity>>()

/**
 * The Identity behind the app's authorizer (server.ts builds it at boot). When the app was built with another authorizer
 * (a test double, or the inert one used by `pnpm openapi`), a private Identity over the app's own database and clock is
 * created on first use, so no database access happens while routes are being registered.
 */
export function identityProvider(deps: AppDeps): IdentityProvider {
  const given = (deps.authorizer as Partial<IdentityAuthorizer>).identity
  if (given) return async () => given
  return () => {
    let p = fallbacks.get(deps.authorizer)
    if (!p) {
      p = (async () => {
        const newId = deps.newId ?? createIdGenerator(deps.clock)
        const loc =
          (await getDefaultLocation(deps.db)) ??
          (await ensureLocation(deps.db, newId, { timezone: deps.env.BUSINESS_TZ }))
        return createIdentity({ db: deps.db, clock: deps.clock, env: deps.env, newId, locationId: loc.id })
          .identity
      })()
      fallbacks.set(deps.authorizer, p)
    }
    return p
  }
}

export const authModule: ApiModule = (app, deps) => registerAuthRoutes(app, identityProvider(deps))
export const peopleModule: ApiModule = (app, deps) => registerPeopleRoutes(app, identityProvider(deps))
