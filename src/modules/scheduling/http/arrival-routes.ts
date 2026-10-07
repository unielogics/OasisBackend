// Arrival: staff issue a per-appointment check-in link; the customer's page pings with it (no session); a dev control simulates
// an arrival. Permissions: issuing a link needs sched.edit; the ping is authenticated by the token alone and can only ever report
// on the one appointment the token was issued for.
import { access } from '../../../http/access.js'
import { auditContextOf } from '../../../http/authorizer.js'
import type { AppInstance } from '../../../http/types.js'
import { z } from '../../../http/zod.js'
import * as audit from '../../../platform/audit.js'
import { transaction } from '../../../platform/db.js'
import { issueArrivalLink, recordPing, resolveLink, simulateArrival } from '../arrival.js'
import { locationTimezone } from '../context.js'
import type { SchedulingPorts } from '../ports.js'
import { Uuid } from './schemas.js'
import { actorOf, ctxOf } from './shared.js'

const TAGS = ['arrivals']

const PingBody = z
  .object({
    token: z
      .string()
      .min(20)
      .max(80)
      .describe('The check-in link token the shop issued for this appointment'),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    accuracyM: z
      .number()
      .min(0)
      .max(100_000)
      .optional()
      .describe('The fix accuracy in metres; a fix wider than the check-in radius cannot prove arrival'),
    etaMinutes: z
      .number()
      .min(0)
      .optional()
      .describe('The phone’s own ETA; otherwise the distance at 25 km/h'),
    declared: z.boolean().optional().describe('The customer tapped "I’m here"'),
    pingId: z
      .string()
      .min(8)
      .max(64)
      .optional()
      .describe('Your id for this ping; a repeat returns the first answer'),
  })
  .strict()

const PingReply = z.object({
  state: z.enum(['outside', 'inconclusive', 'checked_in', 'confirm_needed', 'already_arrived', 'disabled']),
  distanceM: z.number().int().describe('Metres from the shop'),
  radiusM: z.number().int().describe('The check-in radius from the arrival settings'),
  etaMinutes: z.number().int().nullable(),
  message: z.string().describe('Plain text for the customer’s screen'),
})

const LocationView = z.object({
  lat: z.number().min(-90).max(90).nullable(),
  lng: z.number().min(-180).max(180).nullable(),
})

export function registerArrivalRoutes(app: AppInstance, ports: SchedulingPorts): void {
  app.get(
    '/settings/location',
    {
      config: { access: access.authenticated() },
      schema: {
        tags: TAGS,
        summary: 'The shop’s coordinates, the centre of the check-in geofence',
        description:
          'null until the shop sets them; arrival pings answer 409 ARRIVAL_NOT_CONFIGURED without them.',
        response: { 200: LocationView },
      },
    },
    async (req) => {
      const r = await app.db
        .selectFrom('locations')
        .select(['lat', 'lng'])
        .where('id', '=', req.auth!.locationId)
        .executeTakeFirstOrThrow()
      return { lat: r.lat === null ? null : Number(r.lat), lng: r.lng === null ? null : Number(r.lng) }
    },
  )

  app.put(
    '/settings/location',
    {
      config: { access: access.perm('set.hours') },
      schema: {
        tags: TAGS,
        summary: 'Set the shop’s coordinates (the centre of the check-in geofence)',
        body: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).strict(),
        response: { 200: LocationView },
      },
    },
    async (req) => {
      await transaction(app.db, async (tx) => {
        await tx
          .updateTable('locations')
          .set({ lat: req.body.lat, lng: req.body.lng })
          .where('id', '=', req.auth!.locationId)
          .execute()
        await audit.record(tx, {
          locationId: req.auth!.locationId,
          action: 'settings.location.update',
          entityType: 'location',
          entityId: req.auth!.locationId,
          after: req.body,
          ctx: auditContextOf(req),
        })
      })
      return { lat: req.body.lat, lng: req.body.lng }
    },
  )

  app.post(
    '/appointments/:id/arrival-link',
    {
      config: { access: access.perm('sched.edit') },
      schema: {
        tags: TAGS,
        summary: 'Issue the customer’s check-in link for an appointment (rotates any earlier one)',
        description:
          'Returns the token once; only its SHA-256 is stored. The link works until two hours after the booked end and dies when the job is canceled or marked no-show. `url` points at the customer app’s `/a/:token` page (PUBLIC_API_URL until that page exists); the customer page posts the token to POST /arrivals/ping.',
        params: z.object({ id: Uuid }),
        response: {
          201: z.object({ token: z.string(), path: z.string(), url: z.string(), expiresAt: z.string() }),
        },
      },
    },
    async (req, reply) => {
      const out = await transaction(app.db, async (tx) =>
        issueArrivalLink(tx, await ctxOf(app, req, ports), actorOf(req), req.params.id),
      )
      reply.status(201)
      return {
        token: out.token,
        path: out.path,
        url: `${app.env.PUBLIC_API_URL.replace(/\/$/, '')}${out.path}`,
        expiresAt: out.expiresAt.toISOString(),
      }
    },
  )

  app.post(
    '/arrivals/ping',
    {
      config: {
        access: access.public(
          'The customer’s phone has no session; the per-appointment link token authenticates it',
        ),
        // one bucket per address, and a per-appointment spacing in the service
        rateLimit: { max: 60, timeWindow: '1 minute' },
      },
      schema: {
        tags: TAGS,
        summary: 'The customer reports their position (geofence check-in and ETA)',
        description:
          'Authenticated by the link token alone. Inside the check-in radius the job is checked in (auto check-in on) or flagged for staff to confirm (`confirm_needed`); outside it the ETA is stored and the crew is alerted once when it first reaches the prep time. Idempotent per `pingId`; a job that has arrived answers `already_arrived`. 401 ARRIVAL_LINK_INVALID, 410 ARRIVAL_LINK_EXPIRED, 409 ARRIVAL_NOT_CONFIGURED (the shop has no coordinates), 429 ARRIVAL_PING_TOO_FAST (Retry-After) or RATE_LIMITED. A browser page on another origin must be listed in ALLOWED_ORIGINS.',
        body: PingBody,
        response: { 200: PingReply },
      },
    },
    async (req) => {
      const { token, ...input } = req.body
      return transaction(app.db, async (tx) => {
        const link = await resolveLink(tx, token)
        const c = {
          clock: app.clock,
          newId: app.newId,
          locationId: link.locationId,
          tz: await locationTimezone(app.db, link.locationId),
          ports,
        }
        return recordPing(tx, c, link, input)
      })
    },
  )

  if (app.env.ALLOW_DEV_ENDPOINTS) {
    app.post(
      '/dev/appointments/:id/simulate-arrival',
      {
        config: { access: access.perm('jobs.status') },
        schema: {
          tags: TAGS,
          summary:
            'Dev only: behave as a geofence ping for this appointment (the design’s "Simulate arrival")',
          description:
            'Mounted only with ALLOW_DEV_ENDPOINTS. `arrive` pings from the shop door (auto check-in or confirm-needed, per the arrival settings); `eta` pings from `etaMinutes` away. Needs the shop’s coordinates.',
          params: z.object({ id: Uuid }),
          body: z
            .object({
              mode: z.enum(['arrive', 'eta']).default('arrive'),
              etaMinutes: z.number().int().min(0).max(600).optional(),
            })
            .strict()
            .optional(),
          response: { 200: PingReply },
        },
      },
      async (req) =>
        transaction(app.db, async (tx) =>
          simulateArrival(tx, await ctxOf(app, req, ports), req.params.id, {
            mode: req.body?.mode ?? 'arrive',
            etaMinutes: req.body?.etaMinutes,
          }),
        ),
    )
  }
}
