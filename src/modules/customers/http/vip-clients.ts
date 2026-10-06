// VIP client list: GET/POST/DELETE /vip/clients. Clients resolve by customer id; a typed name is added only when exactly
// one customer matches it exactly, otherwise the caller gets 409 with the candidates to pick from (review B37).
import { access } from '../../../http/access.js'
import { hasPermission } from '../../../http/authorizer.js'
import { z } from '../../../http/zod.js'
import { AppError } from '../../../platform/errors.js'
import { inTx, requestContext, storedUserId, type SettingsRuntime } from '../../settings/http/runtime.js'
import '../../settings/http/problems.js'
import {
  addVipByName,
  addVipClient,
  listVipClients,
  removeVipClient,
  type VipClient,
} from '../../settings/vip.js'

const ClientView = z.object({ customerId: z.string(), fullName: z.string(), addedAt: z.string() })

export const clientView = (c: VipClient): z.infer<typeof ClientView> => ({
  customerId: c.customerId,
  fullName: c.fullName,
  addedAt: c.addedAt.toISOString(),
})

export function registerVipClientRoutes(rt: SettingsRuntime): void {
  const { app } = rt

  app.get(
    '/vip/clients',
    {
      config: { access: access.perm('cli.member') },
      schema: {
        tags: ['settings'],
        operationId: 'listVipClients',
        summary: 'VIP clients, oldest first',
        response: { 200: z.object({ items: z.array(ClientView), count: z.number().int() }) },
      },
    },
    async (req) => {
      const items = (await listVipClients(app.db, requestContext(req).locationId)).map(clientView)
      return { items, count: items.length }
    },
  )

  app.post(
    '/vip/clients',
    {
      config: { access: access.perm('cli.member') },
      schema: {
        tags: ['settings'],
        operationId: 'addVipClient',
        summary: 'Make a customer VIP, by customer id or by typed name',
        description:
          'Send `customerId`, or `name` (the design\'s "Client name" box). A name is resolved case-insensitively: exactly one match is added (201, toast "{name} is now VIP"); several matches, or only partial matches, answer 409 VIP_CLIENT_AMBIGUOUS with `meta.candidates` (id, name, last-four phone hint only with cli.contact, vehicles, alreadyVip) so the caller re-sends with a customerId; no match answers 404 VIP_CLIENT_NOT_FOUND. Adding someone who is already VIP answers 200 with `added: false`.',
        body: z
          .object({ customerId: z.string().uuid().optional(), name: z.string().max(120).optional() })
          .strict()
          .refine((b) => b.customerId !== undefined || (b.name ?? '').trim() !== '', {
            message: 'Enter a client name.',
            path: ['name'],
          }),
        response: {
          200: z.object({
            customerId: z.string(),
            fullName: z.string(),
            added: z.boolean(),
            toast: z.string().nullable(),
          }),
          201: z.object({
            customerId: z.string(),
            fullName: z.string(),
            added: z.boolean(),
            toast: z.string().nullable(),
          }),
        },
      },
    },
    async (req, reply) => {
      const c = requestContext(req)
      const canSeeContact = hasPermission(req.auth!, 'cli.contact')
      const addedBy = await storedUserId(app.db, c.userId)
      const out = await inTx(app.db, async (tx) => {
        if (req.body.customerId) {
          const r = await addVipClient(tx, {
            locationId: c.locationId,
            customerId: req.body.customerId,
            addedBy,
            audit: c.audit,
          })
          return {
            customerId: r.customer.id,
            fullName: r.customer.fullName,
            added: r.added,
            toast: r.added ? `${r.customer.fullName} is now VIP` : null,
          }
        }
        const r = await addVipByName(tx, {
          locationId: c.locationId,
          name: req.body.name ?? '',
          addedBy,
          audit: c.audit,
        })
        switch (r.status) {
          case 'added':
            return { customerId: r.customer.id, fullName: r.customer.fullName, added: true, toast: r.toast }
          case 'already_vip':
            return { customerId: r.customer.id, fullName: r.customer.fullName, added: false, toast: null }
          case 'candidates':
            throw new AppError('VIP_CLIENT_AMBIGUOUS', {
              meta: {
                candidates: r.candidates.map((k) => ({
                  customerId: k.customerId,
                  fullName: k.fullName,
                  phoneHint: canSeeContact ? k.phoneHint : null,
                  vehicles: k.vehicles,
                  alreadyVip: k.alreadyVip,
                })),
              },
            })
          case 'not_found':
            throw new AppError('VIP_CLIENT_NOT_FOUND')
        }
      })
      return reply.status(out.added ? 201 : 200).send(out)
    },
  )

  app.delete(
    '/vip/clients/:customerId',
    {
      config: { access: access.perm('cli.member') },
      schema: {
        tags: ['settings'],
        operationId: 'removeVipClient',
        summary: 'Remove a customer from the VIP list (no toast in the design)',
        params: z.object({ customerId: z.string().uuid() }),
        response: { 200: z.object({ customerId: z.string(), removed: z.literal(true) }) },
      },
    },
    async (req) => {
      const c = requestContext(req)
      const removed = await inTx(app.db, (tx) =>
        removeVipClient(tx, { locationId: c.locationId, customerId: req.params.customerId, audit: c.audit }),
      )
      if (!removed) throw new AppError('NOT_FOUND', { detail: 'That client is not on the VIP list' })
      return { customerId: req.params.customerId, removed: true as const }
    },
  )
}
