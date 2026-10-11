// The welcome flow's first step (ADR 0160, owner 2026-10-11; the W2d NewTexters port). The messaging core calls adopt inside the
// webhook's transaction for the first text the gate admits from a number with no client (never for a keyword, a code, AGENT or a
// picture-only text). It creates the provisional client "New texter ••NNNN" (source inbound_sms, consent inbound_text,
// needs_details), or restores the number's archived one, and opens the number's lead (source text), so the thread exists from the
// start and the turn greets a client. Idempotent per (location, phone): a second text finds the client the first one created.
// Off by default: while AI_ENABLED or assistant.enabled is off it adopts nobody (and the gate would not call it anyway).
import { advisoryXactLock } from '../../../platform/db.js'
import { normalizeTextableNanp } from '../../../platform/phone.js'
import type { NewTexters } from '../ports.js'
import type { CreateNewTexters } from '../contract.js'
import { openLead } from '../../leads/service.js'
import { assistantOn } from '../tools/switches.js'
import { createProvisionalClient } from './provisional.js'

export const createNewTexters: CreateNewTexters = (deps): NewTexters => ({
  async adopt(tx, input) {
    if (!(await assistantOn(tx, deps.env, input.locationId))) return null
    const p = normalizeTextableNanp(input.phone)
    if (!p.ok) return null
    const phone = p.e164
    // one decision per number at a time: two texts of a burst never create two clients
    await advisoryXactLock(tx, `welcome:${input.locationId}:${phone}`)
    const optedOut = await tx
      .selectFrom('sms_opt_outs')
      .select('id')
      .where('location_id', '=', input.locationId)
      .where('phone_e164', '=', phone)
      .where('opted_in_again_at', 'is', null)
      .executeTakeFirst()
    const client = await createProvisionalClient(tx, { newId: deps.newId, locationId: input.locationId, phone, at: input.receivedAt, optedOut: !!optedOut })
    await openLead(tx, deps.newId, { locationId: input.locationId, phone, customerId: client.customerId, source: 'text', at: input.receivedAt })
    return { customerId: client.customerId }
  },
})
