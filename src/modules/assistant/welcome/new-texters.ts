// The welcome flow's first step (ADR 0160, owner 2026-10-11; the W2d NewTexters port). The messaging core calls adopt inside the
// webhook's transaction for the first text the gate admits from a number with no client (never for a keyword, a code, AGENT or a
// picture-only text). It creates the provisional client "New texter ••NNNN" (source inbound_sms, consent inbound_text,
// needs_details), or restores the number's archived one, and opens the number's lead (source text), so the thread exists from the
// start and the turn greets a client. Idempotent per (location, phone): a second text finds the client the first one created.
// The hourly ceiling (settings assistant.new_texters_per_hour, W4c fixes): beyond it a first text creates nothing (no client, no lead,
// no AI reply: spoofed first texts cannot flood the shop with records and texts); it is stored for staff as an unknown sender's, and
// the managers are told once an hour. A returning texter's archived record is restored whatever the count (unless the stale-record
// rule holds it: then the text is a new texter's, provisional.ts).
// Off by default: while AI_ENABLED or assistant.enabled is off it adopts nobody (and the gate would not call it anyway).
import { advisoryXactLock, type Tx } from '../../../platform/db.js'
import { getSetting } from '../../../platform/settings.js'
import { normalizeTextableNanp } from '../../../platform/phone.js'
import type { NewTexters } from '../ports.js'
import type { AssistantDeps, CreateNewTexters } from '../contract.js'
import { staleRecord } from '../../identity/stale.js'
import { openLead } from '../../leads/service.js'
import { notifyManagers } from '../../messaging/notify.js'
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
    if (await overCeiling(tx, deps, { locationId: input.locationId, phone, at: input.receivedAt })) return { refused: 'ceiling' as const }
    const client = await createProvisionalClient(tx, { newId: deps.newId, locationId: input.locationId, phone, at: input.receivedAt, optedOut: !!optedOut })
    await openLead(tx, deps.newId, { locationId: input.locationId, phone, customerId: client.customerId, source: 'text', at: input.receivedAt })
    return { customerId: client.customerId }
  },
})

const HOUR = 3_600_000

/** True when the hour's new provisional clients reached the ceiling (and the managers are told, once per clock hour). */
async function overCeiling(tx: Tx, deps: AssistantDeps, o: { locationId: string; phone: string; at: Date }): Promise<boolean> {
  const archived = await tx
    .selectFrom('customers')
    .select('id')
    .where('phone_e164', '=', o.phone)
    .where('archived_at', 'is not', null)
    .where('merged_into', 'is', null)
    .orderBy('archived_at', 'desc')
    .limit(1)
    .executeTakeFirst()
  // a returning texter's record comes back whatever the count; one the stale-record rule holds does not (a new client is made)
  if (archived && !(await staleRecord(tx, { locationId: o.locationId, customerId: archived.id, phone: o.phone, now: o.at })).stale) return false
  const ceiling = (await getSetting(tx, o.locationId, 'assistant.new_texters_per_hour')).value
  // one count at a time per location, so two first texts never both take the last place
  await advisoryXactLock(tx, `welcome-ceiling:${o.locationId}`)
  const r = await tx
    .selectFrom('customers')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('source', '=', 'inbound_sms')
    .where('created_at', '>', new Date(o.at.getTime() - HOUR))
    .executeTakeFirstOrThrow()
  if (Number(r.n) < ceiling) return false
  const sourceRef = `assistant_new_texters:${new Date(Math.floor(o.at.getTime() / HOUR) * HOUR).toISOString()}`
  const told = await tx.selectFrom('notifications').select('id').where('location_id', '=', o.locationId).where('source_ref', '=', sourceRef).limit(1).executeTakeFirst()
  if (!told)
    await notifyManagers(
      tx,
      {
        locationId: o.locationId,
        kind: 'assistant.new_texters_ceiling',
        title: 'Many new numbers are texting: the assistant paused the welcome',
        body: `More than ${ceiling} new numbers texted the shop within an hour. Their first texts are kept for the team (Messages, unknown senders) without a client record or an AI reply until the hour passes.`,
        entityType: null,
        entityId: null,
        sourceRef,
      },
      { newId: deps.newId, clock: deps.clock },
    )
  return true
}
