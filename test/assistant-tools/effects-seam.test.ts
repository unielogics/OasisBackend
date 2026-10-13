// The tools' side-effect seam (ADR 0174 §4b): every write a tool makes goes through ctx.effects; its checks and reads stay in the
// tool. With effects that only record (what practice will pass), the same tools run their validation, answer the model, and leave
// the live tables untouched: no lead, link, pending action, opt-out, client name or vehicle, outbox text or audit row. Without
// effects on the context, the live effects run (the tools' own suites cover them).
import { describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import type { AnyAssistantTool, ToolEffects, ToolOutcome } from '../../src/modules/assistant/contract.js'
import { liveToolEffects } from '../../src/modules/assistant/tools/effects-live.js'
import { createToolRegistry } from '../../src/modules/assistant/tools/index.js'
import { STRANGER, useToolWorld } from './world.js'

const w = useToolWorld()
const tool = (name: string): AnyAssistantTool => createToolRegistry(w.deps).get(name)!

const TABLES = [
  'leads',
  'client_links',
  'assistant_pending_actions',
  'sms_opt_outs',
  'vehicles',
  'messages',
  'sms_outbox',
  'audit_log',
] as const

async function counts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const t of TABLES) out[t] = Number((await sql<{ n: number }>`select count(*)::int as n from ${sql.table(t)}`.execute(w.t.db)).rows[0]!.n)
  return out
}

function recordingEffects(): { effects: ToolEffects; calls: string[] } {
  const calls: string[] = []
  const done = (what: string, data: Record<string, unknown> = {}): ToolOutcome => {
    calls.push(what)
    return { ok: true, data: { practice: true, ...data } as never }
  }
  return {
    calls,
    effects: {
      async noteInterest(_ctx, categories, o) {
        calls.push(`noteInterest:${categories.join(',')}:${o.openLead ? 'open' : 'add'}`)
        return [...categories]
      },
      async issueLink(ctx, input) {
        return done(`issueLink:${input.kind}`, { placeholder: ctx.addLink(`practice:${input.kind}`, { kind: input.kind, expiresAt: ctx.now }) })
      },
      async propose(_ctx, o) {
        return done(`propose:${o.kind}`, { proposed: o.kind, summary: o.summary, confirmationTexted: true })
      },
      async saveName(_ctx, name) {
        return done(`saveName:${name}`, { saved: true, firstName: name.split(' ')[0] })
      },
      async saveVehicle(_ctx, v) {
        return done(`saveVehicle:${v.size.key}:${v.make} ${v.model}`, { saved: true })
      },
      async optOut() {
        return done('optOut', { optedOut: true })
      },
      async cancelPending() {
        calls.push('cancelPending')
      },
    },
  }
}

describe('the ToolEffects seam (ADR 0174 §4b)', () => {
  it('the live effects are the default of a context without effects', () => {
    expect(Object.keys(liveToolEffects).sort()).toEqual(['cancelPending', 'issueLink', 'noteInterest', 'optOut', 'propose', 'saveName', 'saveVehicle'])
  })

  it('every writing tool goes through ctx.effects; the checks still run in the tool; nothing is written', async () => {
    await w.assistantOn({ actions: true })
    const maria = w.customer('Maria Delgado')
    const before = await counts()
    const rec = recordingEffects()
    const probe = await w.ctx({ customerId: maria.id, phone: maria.phone, trust: 'trusted' })
    const ctx = { ...probe.ctx, effects: rec.effects, lang: 'en' as const }
    const run = (name: string, input: unknown) => tool(name).run(ctx, tool(name).input.parse(input))

    expect((await run('note_interest', { categories: ['wash'] })).ok).toBe(true)
    // the tool's own check: an unknown category never reaches the effects
    expect(await run('note_interest', { categories: ['nope'] })).toMatchObject({ ok: false, error: 'invalid' })
    expect((await run('set_my_vehicle', { size: 'compact_suv', make: 'Honda', model: 'CR-V', year: null, color: null })).ok).toBe(true)
    expect(await run('set_my_vehicle', { size: 'spaceship', make: 'Honda', model: 'CR-V', year: null, color: null })).toMatchObject({ ok: false, error: 'invalid' })
    expect((await run('handoff_to_staff', { reason: 'client_asked', summary: 'Wants a person.' })).ok).toBe(true)
    expect((await run('opt_out', {})).ok).toBe(true)
    expect(rec.calls).toEqual(['noteInterest:wash:open', 'saveVehicle:compact_suv:Honda CR-V', 'cancelPending', 'optOut'])
    // a proposal after the handoff of this turn is refused by the tool itself, before the effects
    const day = w.facts.today.date
    expect(await run('propose_booking', { serviceKey: 'signature-hand-wash', addonKeys: [], date: day, startMin: 600, vehicle: null, vehicleClass: null })).toMatchObject({
      ok: false,
      error: 'unavailable',
    })
    expect(await counts()).toEqual(before)
  })

  it('a new texter: the name and the links go through the effects too', async () => {
    await w.assistantOn()
    const before = await counts()
    const rec = recordingEffects()
    const probe = await w.ctx({ customerId: null, phone: STRANGER, trust: 'unknown' })
    const ctx = { ...probe.ctx, effects: rec.effects }
    const run = (name: string, input: unknown) => tool(name).run(ctx, tool(name).input.parse(input))
    // the tool refuses a name without a client before any effect
    expect(await run('set_my_name', { fullName: 'Ana Lopez' })).toMatchObject({ ok: false, error: 'not_allowed' })
    const link = await run('send_link', { kind: 'calendar', appointmentRef: null, tier: null })
    if (w.env.PUBLIC_LINKS_ENABLED) expect(link).toMatchObject({ ok: true, data: { placeholder: '{link1}' } })
    else expect(link).toMatchObject({ ok: false, error: 'unavailable' })
    expect(rec.calls).toEqual(w.env.PUBLIC_LINKS_ENABLED ? ['issueLink:calendar'] : [])
    expect(await counts()).toEqual(before)
  })
})
