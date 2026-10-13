// The routes a kiosk may call (ADR 0180, design section 3.4). FAIL-CLOSED: a kiosk request to any route not listed here gets 403
// KIOSK_FORBIDDEN, even when the kiosk's permission set would allow it and even by direct URL; the account routes of a signed-in
// person answer 403 KIOSK_SESSION instead (the dashboard then loads the kiosk's own /kiosk/me).
//   'none'  : no acting employee needed (reads, locking the kiosk, a price preview, marking a thread read). On a write an
//             X-Oasis-Employee header is still bound and recorded when sent.
//   'actor' : a write that records who did it: X-Oasis-Employee is required (428 KIOSK_EMPLOYEE_REQUIRED without it).
// At boot (src/http/hooks.ts installRouteRegistry, whenever the kiosk module is mounted) every entry must name a registered route
// whose permissions KIOSK_PERMISSIONS satisfies; the API contract marks each listed operation `x-oasis-kiosk: none|actor`, and the
// dashboard generates its own copy from that.
//
// Deliberately left out though the kiosk holds the permission: saved-card "Not charged (checked Square)" and fee charge/waive; the
// Square apply/ignore/POS intents and the POS callback; Squarespace order matching and confirm-processor; deleting a photo (photos are
// damage evidence); the outbox and inbox; every Settings, catalog, standing and membership route.
import type { RouteRecord } from '../../http/access.js'
import { AppError } from '../../platform/errors.js'
import { KIOSK_PERMISSIONS } from '../rbac/catalog.js'
import '../auth/problems.js'
import './problems.js'

export type KioskRouteMode = 'none' | 'actor'
/** "METHOD /api/v1/path" (Fastify's :param form) -> mode. */
export type KioskAllowlist = Readonly<Record<string, KioskRouteMode>>

const A = '/api/v1'

export const KIOSK_ROUTES: KioskAllowlist = {
  // reads
  [`GET ${A}/kiosk/me`]: 'none',
  [`GET ${A}/kiosk/staff`]: 'none',
  [`GET ${A}/auth/csrf`]: 'none',
  [`GET ${A}/events`]: 'none',
  [`GET ${A}/ops/snapshot`]: 'none',
  [`GET ${A}/ops/kpis`]: 'none',
  [`GET ${A}/ops/alerts`]: 'none',
  [`GET ${A}/calendar/summary`]: 'none',
  [`GET ${A}/calendar/day`]: 'none',
  [`GET ${A}/availability`]: 'none',
  [`GET ${A}/bays`]: 'none',
  [`GET ${A}/staff`]: 'none',
  [`GET ${A}/appointments`]: 'none',
  [`GET ${A}/appointments/:id`]: 'none',
  [`GET ${A}/appointments/:id/messages`]: 'none',
  [`GET ${A}/appointments/:id/fee-charges`]: 'none',
  [`GET ${A}/customers`]: 'none',
  [`GET ${A}/customers/:id/messages`]: 'none',
  [`GET ${A}/customers/:id/membership`]: 'none',
  [`GET ${A}/customers/:id/identity`]: 'none',
  [`GET ${A}/customers/:id/cards`]: 'none',
  [`GET ${A}/customers/:id/sms-consent`]: 'none',
  [`GET ${A}/messages/templates`]: 'none',
  [`GET ${A}/membership-plans`]: 'none',
  [`GET ${A}/services`]: 'none',
  [`GET ${A}/catalog/vehicle-classes`]: 'none',
  [`GET ${A}/invoices/:id/card-charges`]: 'none',
  // writes with no acting employee
  [`POST ${A}/kiosk/lock`]: 'none',
  [`POST ${A}/appointments/quote`]: 'none',
  [`POST ${A}/customers/:id/messages/read`]: 'none',
  // writes that record who did it
  [`POST ${A}/appointments`]: 'actor',
  [`POST ${A}/customers`]: 'actor',
  [`PATCH ${A}/appointments/:id`]: 'actor',
  [`PUT ${A}/appointments/:id/vehicle-class`]: 'actor',
  [`POST ${A}/appointments/:id/confirm`]: 'actor',
  [`POST ${A}/appointments/:id/arrive`]: 'actor',
  [`POST ${A}/appointments/:id/start`]: 'actor',
  [`POST ${A}/appointments/:id/assign-bay`]: 'actor',
  [`POST ${A}/appointments/:id/complete`]: 'actor',
  [`POST ${A}/appointments/:id/advance`]: 'actor',
  [`POST ${A}/appointments/:id/prep-bay`]: 'actor',
  [`POST ${A}/appointments/:id/pickup`]: 'actor',
  [`POST ${A}/appointments/:id/notify-ready`]: 'actor',
  [`POST ${A}/appointments/:id/reschedule`]: 'actor',
  [`POST ${A}/appointments/:id/arrival-link`]: 'actor',
  [`POST ${A}/appointments/:id/messages`]: 'actor',
  [`PUT ${A}/appointments/:id/addons/:serviceId`]: 'actor',
  [`DELETE ${A}/appointments/:id/addons/:serviceId`]: 'actor',
  [`PUT ${A}/appointments/:id/checklist/items/:itemId`]: 'actor',
  [`POST ${A}/appointments/:id/checklist/bulk`]: 'actor',
  [`POST ${A}/appointments/:id/photos/presign`]: 'actor',
  [`POST ${A}/appointments/:id/photos/:photoId/complete`]: 'actor',
  [`POST ${A}/appointments/:id/photos/note`]: 'actor',
  [`POST ${A}/invoices/:id/payments`]: 'actor',
  [`POST ${A}/invoices/:id/credit-applications`]: 'actor',
  [`POST ${A}/invoices/:id/receipt`]: 'actor',
  [`POST ${A}/invoices/:id/payment-links`]: 'actor',
  [`POST ${A}/invoices/:id/card-charges`]: 'actor',
  [`PUT ${A}/invoices/:id/tip`]: 'actor',
}

/** The signed-in person's own account routes: a kiosk gets 403 KIOSK_SESSION (the dashboard then loads /kiosk/me). */
export const KIOSK_SESSION_ROUTES: ReadonlySet<string> = new Set([
  `GET ${A}/me`,
  `PUT ${A}/me/preferences`,
  `POST ${A}/me/view-as`,
  `POST ${A}/auth/logout`,
  `POST ${A}/auth/password/change`,
])

export const kioskRouteKey = (method: string, url: string): string =>
  `${method === 'HEAD' ? 'GET' : method} ${url}`

/** The route's kiosk mode, or the 403 a kiosk gets for it (KIOSK_SESSION for the account routes, else KIOSK_FORBIDDEN). */
export function kioskRouteMode(list: KioskAllowlist, method: string, url: string | undefined): KioskRouteMode {
  const key = kioskRouteKey(method, url ?? '')
  const mode = Object.hasOwn(list, key) ? list[key] : undefined
  if (mode) return mode
  if (KIOSK_SESSION_ROUTES.has(key)) throw new AppError('KIOSK_SESSION')
  throw new AppError('KIOSK_FORBIDDEN')
}

/**
 * The boot check: every entry names a registered route, which is neither public nor a webhook, and whose permissions the kiosk's
 * permission set satisfies; every account route exists and is not listed. Throws an Error naming every bad entry.
 */
export function checkKioskAllowlist(records: readonly RouteRecord[], list: KioskAllowlist = KIOSK_ROUTES): void {
  const byKey = new Map(records.map((r) => [`${r.method} ${r.url}`, r]))
  const problems: string[] = []
  for (const [key, mode] of Object.entries(list)) {
    if (mode !== 'none' && mode !== 'actor') problems.push(`${key}: unknown mode ${String(mode)}`)
    const r = byKey.get(key)
    if (!r) {
      problems.push(`${key}: no such route`)
      continue
    }
    const a = r.access
    if (a.kind === 'public' || a.kind === 'webhook') problems.push(`${key}: ${a.kind} routes are not kiosk routes`)
    if (a.kind === 'permission') {
      const ok = a.mode === 'all' ? a.perms.every((p) => KIOSK_PERMISSIONS.has(p)) : a.perms.some((p) => KIOSK_PERMISSIONS.has(p))
      if (!ok) problems.push(`${key}: the kiosk cannot satisfy ${a.perms.join(a.mode === 'all' ? ' + ' : ' | ')}`)
    }
    if (mode === 'actor' && key.startsWith('GET ')) problems.push(`${key}: a read never needs an acting employee`)
  }
  for (const key of KIOSK_SESSION_ROUTES) {
    if (!byKey.has(key)) problems.push(`${key}: account route not registered`)
    if (Object.hasOwn(list, key)) problems.push(`${key}: an account route cannot be a kiosk route`)
  }
  if (problems.length) throw new Error(`Kiosk route list (src/modules/kiosk/allowlist.ts):\n  ${problems.join('\n  ')}`)
}
