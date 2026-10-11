// Settings → Reminders (ADR 0160, plan I): GET/PUT /settings/reminders over the real app, one version token for the section (the
// sum of its setting versions), validation, audit and settings.changed per changed key, set.hours to save, and the preview of the
// exact texts for a sample appointment (the composition the reminders job sends).
import { describe, expect, it } from 'vitest'
import { auditActions, events, json, useSettingsHarness, type Json, type Session } from './harness.js'

const h = useSettingsHarness()

const sectionVersion = async (s: Session): Promise<number> => json(await h.get('settings/reminders', s)).version as number

const DEFAULTS = {
  reminders: { offsetsMin: [1440, 120], confirmRequest: true, categoryPrep: {}, reviewRequest: false },
  statusTexts: {
    checkedIn: true,
    checkedInDelayMin: 3,
    runningLate: true,
    lateGraceMin: 10,
    lateMax: 2,
    ready: true,
    pickedUp: true,
    bookAgainLink: false,
  },
  leads: { followUpEnabled: true, followUpDelayMin: 180, businessHoursOnly: true, withinHours: 24 },
}

describe('GET /settings/reminders', () => {
  it('returns the defaults, the categories a preparation line can name, the quiet hours and version 0 as the ETag', async () => {
    const s = await h.admin()
    const r = await h.get('settings/reminders', s)
    expect(r.statusCode, r.body).toBe(200)
    const b = json(r)
    expect(b).toMatchObject({ ...DEFAULTS, quietHours: { enabled: false, start: '21:00', end: '08:00' } })
    expect(b.categories.map((c: { key: string }) => c.key)).toEqual(['wash', 'addons', 'tint', 'detail', 'quote'])
    // the section's version is the sum of its 16 settings' versions (each default row starts at 1)
    expect(b.version).toBe(16)
    expect(r.headers.etag).toBe('"16"')
  })

  it('is readable by any signed-in user and refuses anonymous callers', async () => {
    const crew = await h.withPermissions([])
    expect((await h.get('settings/reminders', crew)).statusCode).toBe(200)
    expect((await h.call('GET', 'settings/reminders')).statusCode).toBe(401)
  })
})

describe('PUT /settings/reminders', () => {
  it('saves a partial edit with the version: only changed keys are written, each audited and published; offsets kept longest first', async () => {
    const s = await h.admin()
    const v0 = await sectionVersion(s)
    const r = await h.put('settings/reminders', s, {
      version: v0,
      reminders: { offsetsMin: [60, 2880], categoryPrep: { tint: 'Plan for 2–3 hours.' }, confirmRequest: true },
      leads: { followUpDelayMin: 240 },
    })
    expect(r.statusCode, r.body).toBe(200)
    const b = json(r)
    expect(b.changed).toEqual(['reminders.offsets_min', 'reminders.category_prep', 'leads.follow_up_delay_min'])
    expect(b.reminders).toEqual({ offsetsMin: [2880, 60], confirmRequest: true, categoryPrep: { tint: 'Plan for 2–3 hours.' }, reviewRequest: false })
    expect(b.leads.followUpDelayMin).toBe(240)
    expect(b.statusTexts).toEqual(DEFAULTS.statusTexts)
    expect(b.version).toBe(v0 + 3)
    expect(r.headers.etag).toBe(`"${v0 + 3}"`)
    const changed = (await events(h.db, 'settings')).map((e) => [e.payload.section, e.payload.key])
    expect(changed).toEqual([
      ['reminders', 'reminders.offsets_min'],
      ['reminders', 'reminders.category_prep'],
      ['leads', 'leads.follow_up_delay_min'],
    ])
    expect((await auditActions(h.db)).filter((a) => a === 'settings.update')).toHaveLength(3)
    const audit = await h.db
      .selectFrom('audit_log')
      .select(['entity_id', 'before', 'after', 'actor_name'])
      .where('entity_id', '=', 'reminders.offsets_min')
      .executeTakeFirstOrThrow()
    expect(audit).toMatchObject({ before: [1440, 120], after: [2880, 60], actor_name: 'Amara O.' })
    // read back the same; a second identical save changes nothing and keeps the version
    const saved = { ...b }
    delete saved.changed
    expect(json(await h.get('settings/reminders', s))).toEqual(saved)
    const again = json(await h.put('settings/reminders', s, { version: v0 + 3, reminders: { offsetsMin: [60, 2880] } }))
    expect(again).toMatchObject({ changed: [], version: v0 + 3 })
    // an emptied preparation line removes it; a loaded view (read-only fields included) can be sent back as it is
    const loaded = json(await h.get('settings/reminders', s))
    loaded.reminders.categoryPrep = { tint: '  ' }
    const cleared = json(await h.put('settings/reminders', s, loaded))
    expect(cleared.reminders.categoryPrep).toEqual({})
    expect(cleared.version).toBe(v0 + 4)
  })

  it('needs the version (428), refuses a stale one (412) and an unknown field (422)', async () => {
    const s = await h.admin()
    const v0 = await sectionVersion(s)
    expect((await h.put('settings/reminders', s, { reminders: { confirmRequest: false } })).statusCode).toBe(428)
    expect((await h.put('settings/reminders', s, { version: v0, statusTexts: { ready: false } })).statusCode).toBe(200)
    const stale = await h.put('settings/reminders', s, { version: v0, statusTexts: { pickedUp: false } })
    expect(stale.statusCode).toBe(412)
    expect(json(stale)).toMatchObject({ code: 'VERSION_CONFLICT', meta: { currentVersion: v0 + 1 } })
    expect((await h.put('settings/reminders', s, { version: v0 + 1, statusTexts: { nope: true } })).statusCode).toBe(422)
    // If-Match works as well
    expect((await h.put('settings/reminders', s, { statusTexts: { pickedUp: false } }, { 'if-match': `"${v0 + 1}"` })).statusCode).toBe(200)
  })

  it('validates every value and the section’s own rules, naming each field, and writes nothing on a refusal', async () => {
    const s = await h.admin()
    const v0 = await sectionVersion(s)
    const r = await h.put('settings/reminders', s, {
      version: v0,
      reminders: { offsetsMin: [120, 120], categoryPrep: { ceramic: 'Plan a day.', tint: 'x'.repeat(161) } },
      statusTexts: { lateMax: 3, checkedInDelayMin: -1 },
      leads: { withinHours: 48 },
    })
    expect(r.statusCode).toBe(422)
    const paths = (json(r).errors as { path: string }[]).map((e) => e.path).sort()
    expect(paths).toEqual(
      expect.arrayContaining([
        'leads.withinHours',
        'reminders.categoryPrep.tint',
        'statusTexts.checkedInDelayMin',
        'statusTexts.lateMax',
      ]),
    )
    const dup = await h.put('settings/reminders', s, { version: v0, reminders: { offsetsMin: [120, 120] } })
    expect(json(dup)).toMatchObject({ status: 422, errors: [{ path: 'reminders.offsetsMin', message: 'Each reminder time can be listed once.' }] })
    const unknown = await h.put('settings/reminders', s, { version: v0, reminders: { categoryPrep: { ceramic: 'Plan a day.' } } })
    expect(json(unknown)).toMatchObject({ errors: [{ path: 'reminders.categoryPrep.ceramic', message: 'There is no category "ceramic".' }] })
    const tooMany = await h.put('settings/reminders', s, { version: v0, reminders: { offsetsMin: [1, 2, 3, 4, 5, 6] } })
    expect(tooMany.statusCode).toBe(422)
    // an emoji would turn every reminder into a 70-character UCS-2 text: the line must be plain characters (Chinese text cannot be
    // transliterated, so it is refused; curly quotes and dashes are normalised and accepted)
    const ucs = await h.put('settings/reminders', s, { version: v0, reminders: { categoryPrep: { tint: '请提前两小时到达' } } })
    expect(json(ucs)).toMatchObject({ status: 422, errors: [{ path: 'reminders.categoryPrep.tint' }] })
    expect(json(await h.get('settings/reminders', s)).version).toBe(v0)
    expect((await auditActions(h.db)).filter((a) => a === 'settings.update')).toEqual([])
  })

  it('needs set.hours to save; the preview needs only a session', async () => {
    const crew = await h.withPermissions([])
    const v0 = await sectionVersion(await h.admin())
    const r = await h.put('settings/reminders', crew, { version: v0, statusTexts: { ready: false } })
    expect(r.statusCode).toBe(403)
    const manager = await h.withPermissions(['set.hours'])
    expect((await h.put('settings/reminders', manager, { version: v0, statusTexts: { ready: false } })).statusCode).toBe(200)
    expect((await h.post('settings/reminders/preview', crew, {})).statusCode).toBe(200)
  })
})

describe('POST /settings/reminders/preview', () => {
  type Text = { id: string; text: string; templateKey: string; enabled: boolean; segments: number; encoding: string; timing: string }
  const byId = (b: Json) => new Map((b.texts as Text[]).map((t) => [t.id, t]))
  /** The text without the STOP line automated texts carry. */
  const body = (t: Text): string => t.text.replace(/ Reply STOP to opt out\.$/, '')

  it('renders the exact texts of the saved settings for tomorrow 10:00 AM, per offset, booked and confirmed', async () => {
    const s = await h.admin()
    const b = json(await h.post('settings/reminders/preview', s, {}))
    expect(b.sample).toEqual({
      firstName: 'Maria',
      startsAt: '2026-06-14T14:00:00.000Z',
      date: '2026-06-14',
      time: '10:00 AM',
      categories: ['wash'],
    })
    const t = byId(b)
    expect([...t.keys()]).toEqual([
      'reminder.1440.booked',
      'reminder.1440.confirmed',
      'reminder.120.booked',
      'reminder.120.confirmed',
      'review',
      'status.checked_in',
      'status.wash_started',
      'status.running_late',
      'status.ready',
      'status.picked_up',
      'lead.follow_up',
    ])
    // exactly what goes out, the STOP line of the automated texts included
    expect(t.get('reminder.1440.booked')).toMatchObject({
      templateKey: 'confirm_request',
      timing: '24 h before',
      text: 'Your appointment at Oasis Auto Spa is booked for tomorrow at 10:00 AM. Reply C to confirm. Reply STOP to opt out.',
      segments: 1,
      encoding: 'GSM-7',
    })
    expect(body(t.get('reminder.120.confirmed')!)).toBe('Reminder: your Oasis Auto Spa appointment is today at 10:00 AM.')
    expect(t.get('review')).toMatchObject({ enabled: false })
    expect(body(t.get('review')!)).toBe('Thanks for visiting Oasis Auto Spa! How did we do?')
    expect(t.get('status.checked_in')).toMatchObject({ templateKey: 'welcome', timing: '3 min after check-in (not sent once the wash starts)' })
    expect(body(t.get('status.running_late')!)).toBe("We're running a little behind on your vehicle. New estimate: 11:30 AM. Sorry for the wait!")
    expect(body(t.get('status.picked_up')!)).toBe('Thanks for visiting Oasis Auto Spa, Maria!')
    expect(body(t.get('lead.follow_up')!)).toMatch(/^Hi Maria, thanks for reaching out to Oasis Auto Spa about window tint\. Reply here and we'll save you a spot\. Or pick a time: https:\/\/oasisautospanj\.com\/#\/c\/x{43}$/)
  })

  it('previews a draft without saving it: confirm request off, preparation lines in category order, the book-again link', async () => {
    const s = await h.admin()
    const r = await h.post('settings/reminders/preview', s, {
      draft: {
        reminders: { offsetsMin: [2880], confirmRequest: false, categoryPrep: { tint: 'Plan for 2–3 hours.', wash: 'Remove valuables.' } },
        statusTexts: { bookAgainLink: true, pickedUp: false },
      },
      sample: { firstName: 'Ana', categories: ['tint', 'wash'], date: '2026-06-20', startMin: 13 * 60 + 30 },
    })
    expect(r.statusCode, r.body).toBe(200)
    const b = json(r)
    expect(b.sample).toMatchObject({ firstName: 'Ana', date: '2026-06-20', time: '1:30 PM', categories: ['wash', 'tint'] })
    const t = byId(b)
    expect(t.get('reminder.2880.booked')).toMatchObject({ templateKey: 'reminder', timing: '48 h before' })
    expect(body(t.get('reminder.2880.booked')!)).toBe(
      'Reminder: your Oasis Auto Spa appointment is on Sat, Jun 20 at 1:30 PM. Remove valuables. Plan for 2-3 hours.',
    )
    expect(t.get('status.picked_up')).toMatchObject({ enabled: false })
    expect(t.get('status.picked_up')!.text).toMatch(/^Thanks for visiting Oasis Auto Spa, Ana! Book your next visit: https:/)
    // nothing was saved
    expect(json(await h.get('settings/reminders', s))).toMatchObject({ ...DEFAULTS, version: 16 })
    // a draft is validated like a save
    const bad = await h.post('settings/reminders/preview', s, { draft: { reminders: { categoryPrep: { nope: 'x' } } } })
    expect(bad.statusCode).toBe(422)
  })
})
