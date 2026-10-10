// The scheduling ports the AI foundation adds (ADR 0160): an optional status-texts port that does nothing by default, and the
// "Needs attention" kinds of an AI handoff and a picture message, passed through like the other external alerts.
import { describe, expect, it } from 'vitest'
import { buildAlerts } from '../../src/modules/scheduling/alerts.js'
import { noStatusTexts, type ExternalAlert, type SchedulingPorts } from '../../src/modules/scheduling/ports.js'

describe('status-texts port', () => {
  it('is optional on SchedulingPorts and the default does nothing', async () => {
    const ports: Partial<SchedulingPorts> = {}
    expect(ports.statusTexts).toBeUndefined()
    await expect(noStatusTexts.onChange({} as never, {} as never, { appointmentId: 'a', change: 'arrived', status: 'arrived' })).resolves.toBeUndefined()
  })
})

describe('external alert kinds', () => {
  it('an AI handoff and a picture message open like the other external alerts', () => {
    const ext = (kind: ExternalAlert['kind'], title: string): ExternalAlert => ({
      key: `${kind}:x`,
      kind,
      tone: 'violet',
      title,
      desc: 'Open the conversation',
      actionLabel: 'Open messages',
      appointmentId: null,
      priority: 1,
    })
    const out = buildAlerts(
      {
        now: new Date('2026-06-13T10:36:00-04:00'),
        tz: 'America/New_York',
        rows: [],
        ops: { lateGraceMin: 10, etaVisibleMaxMin: 30 } as never,
        external: [ext('ai_handoff', 'Oasis AI handed off · Maria D.'), ext('sms.picture_message', 'Picture message from Maria D.')],
      },
      new Map(),
    )
    expect(out.map((a) => [a.kind, a.action.type])).toEqual([
      ['ai_handoff', 'open'],
      ['sms.picture_message', 'open'],
    ])
  })
})
