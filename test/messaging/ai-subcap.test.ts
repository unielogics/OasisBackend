// The AI's sub-cap in the dispatcher (ADR 0160, design sections 2 and 10): ai_reply, ai_fallback, personal_link and action_confirm
// together never spend more than AI_SMS_SEGMENTS_PER_30MIN of a device's 30-minute window, and never lane 0's reserve, so a flood
// of texts to the AI cannot delay the shop's own texts.
import { describe, expect, it } from 'vitest'
import { AI_CAP_WINDOW_MS, AI_CAPPED_CLASSES, aiCapAllows, aiUsedInWindow, type UsagePoint } from '../../src/modules/messaging/dispatch/budget.js'
import { dispatcherConfigFromValues } from '../../src/modules/messaging/dispatch/config.js'
import type { SmsClass } from '../../src/modules/messaging/policy/classes.js'
import { harness, recipient, type Harness } from './helpers.js'

const at = (min: number): Date => new Date(Date.UTC(2026, 5, 13, 16, 0) + min * 60_000)

describe('aiCapAllows', () => {
  const cap = { segments: 12, windowMs: AI_CAP_WINDOW_MS }
  const pts = (klass: string, ...mins: number[]): UsagePoint[] => mins.map((m) => ({ at: at(m), segments: 1, klass }))

  it('counts only the AI classes inside the window', () => {
    const usage = [...pts('ai_reply', 0, 1, 2), ...pts('personal_link', 3), ...pts('ready', 4, 5), ...pts('ai_fallback', -31)]
    expect(aiUsedInWindow(usage, at(10), AI_CAP_WINDOW_MS)).toBe(4)
    expect(AI_CAPPED_CLASSES).toEqual(new Set(['ai_reply', 'ai_fallback', 'personal_link', 'action_confirm']))
  })

  it('refuses an AI text that would pass the cap; other classes are not its business', () => {
    const full = pts('ai_reply', ...Array.from({ length: 11 }, (_, i) => i))
    expect(aiCapAllows('action_confirm', full, at(12), 1, cap)).toBe(true)
    expect(aiCapAllows('action_confirm', full, at(12), 2, cap)).toBe(false)
    expect(aiCapAllows('ready', [...full, ...pts('ai_reply', 11)], at(12), 1, cap)).toBe(true)
    expect(aiCapAllows('ai_reply', [...full, ...pts('ai_reply', 11)], at(12), 1, null)).toBe(true)
    // the window slides
    expect(aiCapAllows('ai_reply', [...full, ...pts('ai_reply', 11)], at(30.5), 1, cap)).toBe(true)
  })

  it('the environment sets the cap (AI_SMS_SEGMENTS_PER_30MIN, default 12) on a 30-minute window', () => {
    const base = { NODE_ENV: 'test', BUSINESS_TZ: 'America/New_York', SMS_ALLOWLIST: '', SMSGATE_MAX_PER_WINDOW: 30, SMSGATE_WINDOW_MINUTES: 30, SMSGATE_RESERVED_P0: 6, SMSGATE_SAFETY_MARGIN: 0, SMSGATE_MIN_INTERVAL_MS: 3000, SMSGATE_MAX_SEGMENTS: 8, SMSGATE_HEARTBEAT_STALE_SECONDS: 600, SMSGATE_ONLINE_WITHIN_SECONDS: 180 } as const
    expect(dispatcherConfigFromValues('d', { ...base, AI_SMS_SEGMENTS_PER_30MIN: 12 }).dispatcher.aiCap).toEqual({ segments: 12, windowMs: 30 * 60_000 })
    expect(dispatcherConfigFromValues('d', { ...base, AI_SMS_SEGMENTS_PER_30MIN: 0 }).dispatcher.aiCap).toEqual({ segments: 0, windowMs: 30 * 60_000 })
  })
})

async function enqueueAt(h: Harness, id: string, klass: SmsClass, who: number): Promise<void> {
  const r = await h.dispatcher.enqueue({ messageId: id, klass, text: `${klass} ${id}`, recipient: recipient(who, { lastInboundAt: h.clock.now() }) })
  if (r.status !== 'queued') throw new Error(`enqueue ${id}: ${r.status}`)
}

/** The most AI segments inside any 30-minute window of the run. */
function peakAiWindow(usage: ReadonlyArray<{ at: Date; segments: number; klass?: string | null }>): number {
  let peak = 0
  for (const u of usage) {
    const end = u.at.getTime()
    peak = Math.max(peak, aiUsedInWindow(usage.filter((x) => x.at.getTime() <= end), new Date(end), AI_CAP_WINDOW_MS))
  }
  return peak
}

describe('a 40-text flood to the AI', () => {
  it('keeps the AI within its sub-cap while a lane-0 "ready" text goes on time and the shop texts all go', async () => {
    // the production defaults: 30 segments per 30 minutes, 6 reserved for lane 0, 3 s between sends, the AI's 12
    const h = harness({ config: { minIntervalMs: 3000, aiCap: { segments: 12, windowMs: AI_CAP_WINDOW_MS } } })
    const start = h.clock.now().getTime()
    const sentAt = new Map<string, number>()
    let readyQueuedAt = 0
    // 40 inbound texts in 10 minutes, each answered by the AI (one ai_reply each, the worst case), plus 8 booking confirmations
    for (let s = 0; s <= 30 * 60; s += 5) {
      if (s < 600 && s % 15 === 0) await enqueueAt(h, `ai-${s / 15}`, 'ai_reply', 100 + (s / 15) * 3)
      if (s < 600 && s % 75 === 0) await enqueueAt(h, `book-${s / 75}`, 'booking_thanks', 500 + s / 75)
      if (s === 300) {
        await enqueueAt(h, 'ready-1', 'ready', 900)
        readyQueuedAt = h.clock.now().getTime()
      }
      const report = await h.dispatcher.tick()
      for (const id of report.sent) sentAt.set(id, h.clock.now().getTime())
      h.clock.advance(5000)
    }

    const usage = await h.outbox.listUsage(new Date(start - 1))
    const items = [...h.outbox.items.values()]
    const ai = items.filter((i) => i.klass === 'ai_reply')
    expect(ai).toHaveLength(40)
    // the AI never spent more than its share of any 30-minute window
    expect(peakAiWindow(usage)).toBeLessThanOrEqual(12)
    expect(ai.filter((i) => i.state === 'accepted' || i.state === 'sent').length).toBe(12)
    // the rest waited and expired (an AI answer is worth 15 minutes)
    expect(ai.filter((i) => i.state === 'expired').length).toBe(28)
    // the ready text left at the first tick it could (no later than the pacing gap)
    expect(sentAt.get('ready-1')! - readyQueuedAt).toBeLessThanOrEqual(5000)
    // and every booking confirmation went
    expect(items.filter((i) => i.klass === 'booking_thanks').every((i) => i.state === 'accepted')).toBe(true)
    // the whole device window was never exceeded
    const total = usage.filter((u) => u.at.getTime() > h.clock.now().getTime() - 30 * 60_000).reduce((n, u) => n + u.segments, 0)
    expect(total).toBeLessThanOrEqual(30)
  })

  it('with the lane-1 room spent by shop texts the AI cannot dip into lane 0\'s reserve either', async () => {
    const h = harness({ config: { aiCap: { segments: 30, windowMs: AI_CAP_WINDOW_MS } } })
    for (let i = 0; i < 24; i++) await enqueueAt(h, `book-${i}`, 'booking_thanks', 200 + i)
    await h.dispatcher.tick()
    await enqueueAt(h, 'ai-1', 'ai_reply', 300)
    await enqueueAt(h, 'ready-1', 'ready', 301)
    const r = await h.dispatcher.tick()
    expect(r.sent).toEqual(['ready-1'])
    expect((await h.outbox.get('ai-1'))!.state).toBe('pending')
  })

  it('records the class of each send in the window accounting', async () => {
    const h = harness({ config: { aiCap: { segments: 1, windowMs: AI_CAP_WINDOW_MS } } })
    await enqueueAt(h, 'ai-1', 'ai_reply', 1)
    await enqueueAt(h, 'ai-2', 'personal_link', 2)
    const r = await h.dispatcher.tick()
    expect(r).toMatchObject({ sent: ['ai-1'], aiCapped: 1 })
    expect(h.outbox.usage).toMatchObject([{ providerMessageId: 'ai-1', klass: 'ai_reply' }])
  })
})
