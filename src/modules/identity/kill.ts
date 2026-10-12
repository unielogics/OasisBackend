// The personal links' kill switch (ADR 0160, design section 9; W4c fixes): bumping the location's links.epoch ends every personal
// link, every link session and every 30-day phone trust at once (each was issued or granted in the epoch it records; links.ts,
// sessions.ts and trust.ts compare on every read), so a reply number in chat stops running too. Two ways in, both audited
// (identity.links.killed beside the settings.update of links.epoch): the staff route POST /identity/links/kill (owner level) and the
// break-glass CLI deploy/scripts/links-kill.sh. PUBLIC_LINKS_ENABLED=false closes the link routes as well; the epoch is the switch
// that needs no restart and also voids what was issued before.
import * as audit from '../../platform/audit.js'
import type { AuditContext } from '../../platform/audit.js'
import type { Tx } from '../../platform/db.js'
import { getSetting, updateSetting } from '../../platform/settings.js'

export interface LinksKilled {
  epochBefore: number
  epoch: number
}

/** Bumps links.epoch by one (every link, session and trust issued before ends). `reason` is kept in the audit log. */
export async function killAllLinks(
  tx: Tx,
  o: { locationId: string; reason: string; updatedBy?: string | null; audit?: AuditContext },
): Promise<LinksKilled> {
  const before = (await getSetting(tx, o.locationId, 'links.epoch')).value
  const rec = await updateSetting(tx, {
    locationId: o.locationId,
    key: 'links.epoch',
    value: before + 1,
    updatedBy: o.updatedBy ?? null,
    audit: o.audit,
  })
  await audit.record(tx, {
    locationId: o.locationId,
    action: 'identity.links.killed',
    entityType: 'setting',
    entityId: 'links.epoch',
    before: { epoch: before },
    after: { epoch: rec.value, reason: o.reason.slice(0, 300) },
    ctx: o.audit,
  })
  return { epochBefore: before, epoch: rec.value }
}
