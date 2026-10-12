import type { SmsPriority } from '../../../integrations/ports/sms.js'

// Send budget for one physical device.
//
// Android stops an app that sends more than 30 SMS in 30 minutes until a person taps a confirmation dialog (AOSP
// SmsUsageMonitor: sms_outgoing_check_max_count / sms_outgoing_check_interval_ms; a multipart message counts once per
// part). On an unattended tablet that dialog silently blocks everything. So the budget is a sliding window, not a token
// bucket: a bucket that refills continuously allows a full burst and then more, which exceeds the OS limit; a sliding
// window never has more than `max` segments inside any `windowMs` span.
//
// Reserved capacity: the last `reservedForP0` segments of the window can only be spent by lane 0 (transactional/urgent),
// so a bulk lane (an emergency fan-out) can never use the whole window and leave ready-for-pickup texts waiting.

export interface BudgetConfig {
  maxPerWindow: number
  windowMs: number
  reservedForP0: number
  /** Subtracted from maxPerWindow, a cushion against the device counting slightly differently from us. */
  safetyMargin: number
}

export const DEFAULT_BUDGET: BudgetConfig = {
  maxPerWindow: 30,
  windowMs: 30 * 60_000,
  reservedForP0: 6,
  safetyMargin: 0,
}

export interface UsagePoint {
  at: Date
  segments: number
  /** The class that spent the segments, when known (the AI sub-cap counts its own). */
  klass?: string | null
}

/** Segments spent inside the window that ends at `now` (exclusive of entries older than the window). */
export function usedInWindow(usage: readonly UsagePoint[], now: Date, windowMs: number): number {
  const since = now.getTime() - windowMs
  let n = 0
  for (const u of usage) if (u.at.getTime() > since) n += u.segments
  return n
}

/** The most segments a lane may have in the window: lane 0 gets all of it, the others lose the reserve. */
export function laneLimit(priority: SmsPriority, cfg: BudgetConfig): number {
  const cap = Math.max(0, cfg.maxPerWindow - cfg.safetyMargin)
  return priority === 0 ? cap : Math.max(0, cap - cfg.reservedForP0)
}

export function canSpend(usage: readonly UsagePoint[], now: Date, cost: number, priority: SmsPriority, cfg: BudgetConfig): boolean {
  return usedInWindow(usage, now, cfg.windowMs) + cost <= laneLimit(priority, cfg)
}

/**
 * Earliest instant at or after `from` at which `cost` segments fit for the lane, or null when they never can (the message
 * is larger than the lane limit).
 */
export function nextFit(usage: readonly UsagePoint[], from: Date, cost: number, priority: SmsPriority, cfg: BudgetConfig): Date | null {
  const limit = laneLimit(priority, cfg)
  if (cost > limit) return null
  const sorted = [...usage].sort((a, b) => a.at.getTime() - b.at.getTime())
  let t = from
  for (let guard = 0; guard <= sorted.length + 1; guard++) {
    if (usedInWindow(sorted, t, cfg.windowMs) + cost <= limit) return t
    // Entries leave the window at (at + windowMs); jump to the first such moment after t.
    const leaving = sorted.map((u) => u.at.getTime() + cfg.windowMs).filter((x) => x > t.getTime())
    const first = leaving[0]
    if (first === undefined) return null
    t = new Date(first)
  }
  return null
}

// The AI's sub-cap (ADR 0160, design section 2): the texts the assistant sends (its answers, its fallback, personal links, reply
// numbers and the lead's one automatic follow-up, which a spoofed first text also triggers: W4c fixes) together never spend more than
// AI_SMS_SEGMENTS_PER_30MIN segments of a device's 30-minute window. They never touch lane 0's reserve either: a flood of texts to
// the AI cannot delay a ready-for-pickup text.

/** The classes the AI sub-cap counts. */
export const AI_CAPPED_CLASSES: ReadonlySet<string> = new Set(['ai_reply', 'ai_fallback', 'personal_link', 'action_confirm', 'lead_follow_up'])

export interface AiCapConfig {
  /** Segments the AI classes may spend inside `windowMs` (AI_SMS_SEGMENTS_PER_30MIN). */
  segments: number
  windowMs: number
}

export const AI_CAP_WINDOW_MS = 30 * 60_000

/** Segments the AI classes spent inside the window that ends at `now`. */
export function aiUsedInWindow(usage: readonly UsagePoint[], now: Date, windowMs: number): number {
  const since = now.getTime() - windowMs
  let n = 0
  for (const u of usage) if (u.klass && AI_CAPPED_CLASSES.has(u.klass) && u.at.getTime() > since) n += u.segments
  return n
}

/** True when a text of `klass` costing `cost` segments may go now as far as the AI sub-cap is concerned. */
export function aiCapAllows(klass: string, usage: readonly UsagePoint[], now: Date, cost: number, cap: AiCapConfig | null): boolean {
  if (!cap || !AI_CAPPED_CLASSES.has(klass)) return true
  return aiUsedInWindow(usage, now, cap.windowMs) + cost <= cap.segments
}

export interface BudgetSnapshot {
  used: number
  max: number
  reservedForP0: number
  /** Remaining for lane 0 and for the other lanes. */
  remainingP0: number
  remainingOthers: number
  windowMs: number
}

export function snapshot(usage: readonly UsagePoint[], now: Date, cfg: BudgetConfig): BudgetSnapshot {
  const used = usedInWindow(usage, now, cfg.windowMs)
  const cap = Math.max(0, cfg.maxPerWindow - cfg.safetyMargin)
  return {
    used,
    max: cap,
    reservedForP0: cfg.reservedForP0,
    remainingP0: Math.max(0, cap - used),
    remainingOthers: Math.max(0, cap - cfg.reservedForP0 - used),
    windowMs: cfg.windowMs,
  }
}
