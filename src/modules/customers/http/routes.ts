// The customer routes the booking panel needs: search and create-or-find by phone. (The rest of the customer API
// belongs to the customers vertical.)
import { access } from '../../../http/access.js'
import { auditContextOf } from '../../../http/authorizer.js'
import { z } from '../../../http/zod.js'
import type { AppInstance } from '../../../http/types.js'
import * as audit from '../../../platform/audit.js'
import { transaction } from '../../../platform/db.js'
import { canSeeContact } from '../../people/redact.js'
import {
  isVipCustomer,
  listVehicles,
  searchCustomers,
  upsertCustomerByPhone,
  upsertVehicleByPlate,
  type VehicleRecord,
} from '../service.js'

const Vehicle = z.object({
  id: z.string(),
  year: z.number().int().nullable(),
  make: z.string().nullable(),
  model: z.string().nullable(),
  color: z.string().nullable(),
  plate: z.string().nullable(),
})

const CustomerHit = z.object({
  id: z.string(),
  fullName: z.string(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  vip: z.boolean(),
  needsDetails: z.boolean(),
  vehicles: z.array(Vehicle),
})

const vehicleOut = (v: VehicleRecord) => ({
  id: v.id,
  year: v.year,
  make: v.make,
  model: v.model,
  color: v.color,
  plate: v.plate,
})

export function registerCustomerBookingRoutes(app: AppInstance): void {
  app.get(
    '/customers',
    {
      config: { access: access.perm('cli.view') },
      schema: {
        tags: ['customers'],
        summary: 'Search customers by name, vehicle, plate (and phone or email with cli.contact)',
        description:
          'Every whitespace-separated token must match. Without cli.contact a phone or email token cannot match, so a number typed into the box never reveals who owns it, and the contact fields come back null.',
        querystring: z.object({
          q: z.string().max(100),
          limit: z.coerce.number().int().min(1).max(50).default(20),
        }),
        response: { 200: z.object({ items: z.array(CustomerHit) }) },
      },
    },
    async (req) => {
      const canContact = canSeeContact(req.auth!)
      const hits = await searchCustomers(app.db, {
        locationId: req.auth!.locationId,
        q: req.query.q,
        canContact,
        limit: req.query.limit,
      })
      return {
        items: hits.map((h) => ({
          id: h.id,
          fullName: h.fullName,
          phone: h.phoneDisplay,
          email: h.email,
          vip: h.vip,
          needsDetails: h.needsDetails,
          vehicles: h.vehicles.map(vehicleOut),
        })),
      }
    },
  )

  app.post(
    '/customers',
    {
      config: { access: access.perm('sched.edit') },
      schema: {
        tags: ['customers'],
        summary: 'Find the customer by phone or create one (and the vehicle by plate)',
        description:
          'The phone is normalised to E.164 and is the identity: an existing live customer is returned with `created: false` and only missing details are filled. Contact fields come back null without cli.contact.',
        body: z
          .object({
            name: z.string().trim().max(120).nullish(),
            phone: z.string().trim().min(1).max(40),
            email: z.string().trim().max(254).nullish(),
            smsOptIn: z.boolean().optional(),
            vehicle: z
              .object({
                year: z.number().int().min(1900).max(2100).nullish(),
                make: z.string().trim().max(60).nullish(),
                model: z.string().trim().max(60).nullish(),
                color: z.string().trim().max(40).nullish(),
                plate: z.string().trim().max(20).nullish(),
              })
              .strict()
              .nullish(),
          })
          .strict(),
        response: { 201: z.object({ customer: CustomerHit, created: z.boolean() }) },
      },
    },
    async (req, reply) => {
      const canContact = canSeeContact(req.auth!)
      const out = await transaction(app.db, async (tx) => {
        const now = app.clock.now()
        const r = await upsertCustomerByPhone(tx, {
          newId: app.newId,
          now,
          fullName: req.body.name,
          phone: req.body.phone,
          email: req.body.email,
          source: 'dashboard',
          smsOptIn: req.body.smsOptIn ? 'dashboard' : null,
        })
        const v = req.body.vehicle
        if (
          v &&
          [v.make, v.model, v.plate, v.color, v.year].some((x) => x !== undefined && x !== null && x !== '')
        )
          await upsertVehicleByPlate(tx, { newId: app.newId, customerId: r.customer.id, ...v })
        if (r.created)
          await audit.record(tx, {
            locationId: req.auth!.locationId,
            action: 'customer.create',
            entityType: 'customer',
            entityId: r.customer.id,
            ctx: auditContextOf(req),
          })
        return {
          created: r.created,
          customer: r.customer,
          vehicles: await listVehicles(tx, r.customer.id),
          vip: await isVipCustomer(tx, req.auth!.locationId, r.customer.id),
        }
      })
      return reply.status(201).send({
        created: out.created,
        customer: {
          id: out.customer.id,
          fullName: out.customer.fullName,
          phone: canContact ? out.customer.phoneDisplay : null,
          email: canContact ? out.customer.email : null,
          vip: out.vip,
          needsDetails: out.customer.needsDetails,
          vehicles: out.vehicles.map(vehicleOut),
        },
      })
    },
  )
}
