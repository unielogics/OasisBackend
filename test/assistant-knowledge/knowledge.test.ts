// Settings → Oasis AI → Knowledge over the real app (ADR 0174 §1, §6 and §11 "Knowledge"): notes, the per-kind limits and plain
// text, versions (412/428), the shared budget with the Settings Q&A (422 KNOWLEDGE_BUDGET, never cut; a shrinking save always
// passes) and its race (one of two concurrent activations wins), the audit (a hash, never the body), the realtime event, set.assistant,
// and the shop facts: the knowledge fingerprint moves only for active entries and the facts carry only those.
import { describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { buildShopFacts, loadActiveKnowledge } from '../../src/modules/assistant/facts.js'
import { renderShopKnowledge } from '../../src/modules/assistant/knowledge/render.js'
import { loadEnv } from '../../src/config/env.js'
import { auditActions, events, json, type Session } from '../settings-http/harness.js'
import { useKnowledgeHarness } from './harness.js'

const h = useKnowledgeHarness({ env: { AI_KNOWLEDGE_MAX_CHARS: '2000' } })

const create = (s: Session, body: Record<string, unknown>) => h.post('assistant/knowledge', s, body)
const put = (s: Session, id: string, body: Record<string, unknown>) => h.put(`assistant/knowledge/${id}`, s, body)

describe('notes (ADR 0174 §1)', () => {
  it('creates a draft, lists it with its warnings, turns it on (budget), edits it with the version, deletes it', async () => {
    const s = await h.admin()
    const empty = json(await h.get('assistant/knowledge', s))
    expect(empty).toMatchObject({ entries: [], documents: [], budget: { usedChars: 0, maxChars: 2000, parts: { faq: 0, notes: 0, documents: 0, corrections: 0 } } })
    expect(empty.limits).toMatchObject({ noteMax: 4000, documentActiveMax: 20000, documentMaxBytes: 10 * 1024 * 1024, documentMaxPages: 60 })

    const r = await create(s, { title: 'Waiting area', body: 'We have a lounge with wifi and coffee.\nA full detail is $189.' })
    expect(r.statusCode, r.body).toBe(201)
    const e = json(r).entry
    // what the model reads counts when it is longer (K4 review asst:K4A-5): "$189" is "[price in Settings]" (12 + 38 + 37)
    expect(e).toMatchObject({ kind: 'note', title: 'Waiting area', active: false, version: 1, source: 'manual', chars: 12 + 38 + 37 })
    expect(e.warnings).toEqual([{ kind: 'amount', sample: '$189', line: 2 }])
    expect(json(r).budget.usedChars).toBe(0)

    const on = await put(s, e.id, { active: true, version: 1 })
    expect(on.statusCode, on.body).toBe(200)
    expect(json(on)).toMatchObject({ entry: { active: true, version: 2 }, budget: { usedChars: e.chars, parts: { notes: e.chars } } })

    expect((await put(s, e.id, { title: 'Lounge', version: 1 })).statusCode).toBe(412)
    expect((await put(s, e.id, { title: 'Lounge' })).statusCode).toBe(428)
    const renamed = await put(s, e.id, { title: 'Lounge', version: 2 })
    expect(json(renamed).entry).toMatchObject({ title: 'Lounge', version: 3, active: true })

    const del = await h.del(`assistant/knowledge/${e.id}`, s)
    expect(del.statusCode, del.body).toBe(204)
    expect(json(await h.get('assistant/knowledge', s)).entries).toEqual([])
    expect((await auditActions(h.db)).filter((a) => a.startsWith('assistant.knowledge'))).toEqual([
      'assistant.knowledge.create',
      'assistant.knowledge.activate',
      'assistant.knowledge.update',
      'assistant.knowledge.delete',
    ])
    // the audit holds the title, the size and a hash of the body, never the body
    const rows = await h.db.selectFrom('audit_log').select(['before', 'after']).where('action', 'like', 'assistant.knowledge.%').execute()
    expect(JSON.stringify(rows)).not.toContain('wifi and coffee')
    expect(JSON.stringify(rows)).toMatch(/"bodySha256":"[0-9a-f]{64}"/)
    expect((await events(h.db, 'settings')).filter((x) => x.payload.section === 'assistant_knowledge').length).toBeGreaterThanOrEqual(4)
  })

  it('refuses a long note, an empty one, hidden characters, HTML and a long title; nothing is saved', async () => {
    const s = await h.admin()
    const bad = async (body: Record<string, unknown>, path: string) => {
      const r = await create(s, body)
      expect(r.statusCode, r.body).toBe(422)
      expect(json(r).errors[0].path).toBe(path)
    }
    await bad({ title: 'x', body: 'y'.repeat(4001) }, 'body')
    await bad({ title: 'x', body: '   ' }, 'body')
    await bad({ title: 'x', body: `ok${String.fromCodePoint(0xe0041)}` }, 'body')
    await bad({ title: 'x', body: 'see <script>x</script>' }, 'body')
    await bad({ title: 't'.repeat(121), body: 'ok' }, 'title')
    expect(json(await h.get('assistant/knowledge', s)).entries).toEqual([])
  })

  it('needs set.assistant: set.hours alone is refused', async () => {
    expect((await h.get('assistant/knowledge', await h.withPermissions(['set.hours']))).statusCode).toBe(403)
    expect((await h.get('assistant/knowledge', await h.withPermissions(['set.assistant']))).statusCode).toBe(200)
  })
})

describe('the budget (ADR 0174 §1c): active entries and the Q&A share AI_KNOWLEDGE_MAX_CHARS', () => {
  it('refuses to turn on what would go over (422 with the numbers; it stays a draft); a shrinking save always passes', async () => {
    const s = await h.admin()
    const a = json(await create(s, { title: 'A', body: 'a'.repeat(1499), active: true })).entry
    const b = json(await create(s, { title: 'B', body: 'b'.repeat(599) })).entry
    const r = await put(s, b.id, { active: true, version: 1 })
    expect(r.statusCode, r.body).toBe(422)
    expect(json(r)).toMatchObject({ code: 'KNOWLEDGE_BUDGET', meta: { usedChars: 1500, maxChars: 2000, needed: 100 } })
    expect(json(await h.get('assistant/knowledge', s)).entries.find((x: { id: string }) => x.id === b.id).active).toBe(false)
    // shrinking A makes room
    expect((await put(s, a.id, { body: 'a'.repeat(1300), version: 1 })).statusCode).toBe(200)
    expect((await put(s, b.id, { active: true, version: 1 })).statusCode).toBe(200)
    // over budget (as after a lower cap): adding characters is refused, removing them still passes, turning one off too
    await sql`update assistant_knowledge set chars = chars + 1000 where id = ${a.id}`.execute(h.db)
    expect((await put(s, b.id, { body: 'b'.repeat(700), version: 2 })).statusCode).toBe(422)
    expect((await put(s, a.id, { body: 'a'.repeat(1200), version: 2 })).statusCode).toBe(200)
    expect((await put(s, b.id, { active: false, version: 2 })).statusCode).toBe(200)
  })

  it('a growing Settings Q&A is refused past the shared budget; a shrinking one passes', async () => {
    const s = await h.admin()
    await create(s, { title: 'A', body: 'a'.repeat(1900), active: true })
    const v0 = json(await h.get('settings/assistant', s)).version as number
    const big = await h.put('settings/assistant', s, { version: v0, faq: [{ q: 'Do you have a lounge?', a: 'x'.repeat(200) }] })
    expect(big.statusCode, big.body).toBe(422)
    expect(json(big)).toMatchObject({ code: 'KNOWLEDGE_BUDGET', meta: { maxChars: 2000 } })
    const small = await h.put('settings/assistant', s, { version: v0, faq: [{ q: 'Lounge?', a: 'Yes.' }] })
    expect(small.statusCode, small.body).toBe(200)
    expect(json(await h.get('assistant/knowledge', s)).budget.parts.faq).toBe(11)
  })

  it('two activations at the same time: exactly one is refused (the per-location advisory lock)', async () => {
    const s = await h.admin()
    const x = json(await create(s, { title: 'X', body: 'x'.repeat(1199) })).entry
    const y = json(await create(s, { title: 'Y', body: 'y'.repeat(1199) })).entry
    const [rx, ry] = await Promise.all([put(s, x.id, { active: true, version: 1 }), put(s, y.id, { active: true, version: 1 })])
    expect([rx.statusCode, ry.statusCode].sort()).toEqual([200, 422])
    expect(json(await h.get('assistant/knowledge', s)).budget.usedChars).toBe(1200)
  })
})

describe('the shop facts read the active knowledge (facts-v5)', () => {
  it('the fingerprint moves for an active entry’s change only; the facts carry the active entries, rendered and masked', async () => {
    const s = await h.admin()
    const env = { ...loadEnv(), BUSINESS_TZ: 'America/New_York' }
    const facts = buildShopFacts({ db: h.db, clock: h.clock, env })
    const loc = h.fx.locationId
    const v0 = (await facts.get(loc)).version
    const draft = json(await create(s, { title: 'Parking', body: 'Park in bay 3. Call 201-555-0142 for help.' })).entry
    expect((await facts.get(loc)).version).toBe(v0)
    await put(s, draft.id, { body: 'Park in bay 4. Call 201-555-0142 for help.', version: 1 })
    expect((await facts.get(loc)).version).toBe(v0)
    await put(s, draft.id, { active: true, version: 2 })
    const f1 = await facts.get(loc)
    expect(f1.version).not.toBe(v0)
    expect(f1.knowledge?.entries.map((e) => e.title)).toEqual(['Parking'])
    expect(renderShopKnowledge(f1)).toContain('> Park in bay 4. Call [number] for help.')
    await put(s, draft.id, { title: 'Parking spots', version: 3 })
    expect((await facts.get(loc)).version).not.toBe(f1.version)
    await put(s, draft.id, { active: false, version: 4 })
    expect((await loadActiveKnowledge(h.db, loc)).entries).toEqual([])
  })
})
