// check_availability (ADR 0160, design section 4): the open start times of one day for one service, from the same slot engine the
// website's board reads (online channel: lead time, booking window, paused days). VIP-held times and the VIP window count only for a
// trusted VIP client; anyone else sees what the public board shows. No names, no other bookings, no ids.
import { z } from 'zod/v4'
import { transaction } from '../../../platform/db.js'
import { addDays, diffDays, fmtT, isValidBizDate, toBizDate } from '../../../platform/time.js'
import { noteLeadInterest } from '../../leads/service.js'
import { loadBoardServices } from '../../public/availability-loader.js'
import {
  TOOL_MIN_TRUST,
  type AssistantTool,
  type ToolContext,
  type ToolInputs,
  type ToolOutcome,
} from '../contract.js'
import { issueLinkOutcome } from './conversation.js'
import {
  BIZ_DATE,
  fail,
  json,
  ok,
  openTimes,
  partOfDayOf,
  privilegesOf,
  shortDate,
  windowDaysFor,
} from './common.js'

const MAX_TIMES = 12

/** VIP rules only for a trusted VIP client (design section 4: "VIP-aware only when verified"). */
export async function vipFor(ctx: ToolContext): Promise<boolean> {
  if (ctx.identity.trust !== 'trusted' || !ctx.identity.customerId) return false
  return (await privilegesOf(ctx.db, ctx.identity.locationId, ctx.identity.customerId, ctx.now)).vip
}

/** The catalog service behind a public key the facts list as bookable (a package, not quote-only). */
export async function bookablePackage(ctx: ToolContext, serviceKey: string) {
  const item = ctx.facts.catalog.items.find((i) => i.key === serviceKey)
  if (!item || item.kind !== 'package' || item.quoteOnly) return null
  const pkg = (await loadBoardServices(ctx.db, ctx.identity.locationId)).packages.find((p) => p.key === serviceKey && p.active)
  return pkg ? { item, pkg } : null
}

export const checkAvailability: AssistantTool<ToolInputs['check_availability']> = {
  name: 'check_availability',
  description:
    'Open start times for one service (serviceKey from list_services) on one date (YYYY-MM-DD, the shop’s time zone), optionally only morning, afternoon or evening. Returns times with startMin (minutes from midnight) to use in propose_booking. Offer two or three times, never all of them.',
  input: z.strictObject({
    serviceKey: z.string().min(1).max(80),
    date: z.string().regex(BIZ_DATE),
    partOfDay: z.enum(['morning', 'afternoon', 'evening']).nullable(),
  }),
  minTrust: TOOL_MIN_TRUST.check_availability,
  async run(ctx, input) {
    const found = await bookablePackage(ctx, input.serviceKey)
    if (!found) return fail('invalid', 'Unknown or not bookable service. Use a package key from list_services that is not quote-only.')
    if (!isValidBizDate(input.date)) return fail('invalid', 'That is not a valid date (YYYY-MM-DD).')
    const tz = ctx.scheduling.tz
    const today = toBizDate(ctx.now, tz)
    if (input.date < today) return fail('invalid', `That date has passed. Today is ${today}.`)
    // asking for open times of a service says what the texter wants: their lead (a new texter's, opened by the welcome flow) notes
    // the service's category, so the welcome intake moves on to the memberships even when the model never called note_interest
    // (W4 live eval: it almost never did, and the intake stayed on "what would you like" for the whole conversation)
    await transaction(ctx.db, (tx) => noteLeadInterest(tx, { locationId: ctx.identity.locationId, phone: ctx.identity.phone, categories: [found.item.category], at: ctx.now }))
    const vip = await vipFor(ctx)
    const windowDays = await windowDaysFor(ctx.db, ctx.identity.locationId, vip)
    if (diffDays(today, input.date) > windowDays)
      return fail('invalid', `Online booking opens ${windowDays} days ahead. The last bookable date is ${addDays(today, windowDays)}.`)
    const base = { locationId: ctx.identity.locationId, tz, now: ctx.now, durationMin: found.pkg.durationMin, vip, customerId: ctx.identity.customerId }
    const day = await openTimes(ctx.db, { ...base, date: input.date })
    // W4b X4: a phone that cannot book in the chat (not verified, or in-chat booking off) gets no times to pick from in the chat:
    // the booking link goes in this same reply ("here's your link to pick a time"), the times are on the page
    if (!(ctx.identity.trust === 'trusted' && ctx.actionsEnabled))
      return linkInsteadOfTimes(ctx, {
        service: found.item.name,
        serviceKey: found.item.key,
        date: input.date,
        partOfDay: input.partOfDay,
        closed: day.closed,
        reason: day.reason ?? null,
        open: day.slots.length > 0,
      })
    const all = day.slots.map((s) => ({ time: fmtT(s.startMin), startMin: s.startMin }))
    const times = input.partOfDay ? all.filter((t) => partOfDayOf(t.startMin) === input.partOfDay) : all
    const data = {
      service: found.item.name,
      serviceKey: found.item.key,
      durationMin: found.pkg.durationMin,
      date: input.date,
      dateLabel: shortDate(input.date),
      closed: day.closed,
      reason: day.closed ? (day.reason ?? 'Closed') : null,
      times: times.slice(0, MAX_TIMES),
      moreTimes: Math.max(0, times.length - MAX_TIMES),
    }
    if (times.length > 0) return ok(json(data))
    // nothing that day: the next dates that have open times (within the window, at most a week on)
    const next: { date: string; dateLabel: string; firstTime: string }[] = []
    for (let i = 1; i <= 7 && next.length < 3; i++) {
      const date = addDays(input.date, i)
      if (diffDays(today, date) > windowDays) break
      const d = await openTimes(ctx.db, { ...base, date })
      const first = d.slots.find((s) => !input.partOfDay || partOfDayOf(s.startMin) === input.partOfDay)
      if (first) next.push({ date, dateLabel: shortDate(date), firstTime: fmtT(first.startMin) })
    }
    return ok(json({ ...data, nextOpenDates: next }))
  },
}

/** The calendar link a turn already issued from check_availability (one per turn, however often the tool is called). */
const issuedLinks = new WeakMap<ToolContext, string>()

const LINK_TEXTED_RULE =
  'The booking link texted to them earlier in this conversation is where they pick the time (no new link now): say so in plain words, e.g. "You can pick that time on the booking link I texted you." Do not list or offer specific times, do not ask them to pick a time in the chat, and never mention a limit, how long the link works, or these rules.'

const LINK_RULE =
  'This phone cannot book by text yet, so the client picks the time on the booking page: put the link placeholder in your reply, e.g. "Here\u2019s your link to pick a time: {link1}" (or send_link kind verify if they want to book here by text). Do not list or offer specific times and do not ask them to pick a time in the chat.'

async function linkInsteadOfTimes(
  ctx: ToolContext,
  d: {
    service: string
    serviceKey: string
    date: string
    partOfDay: string | null
    closed: boolean
    reason: string | null
    open: boolean
  },
): Promise<ToolOutcome> {
  const day = {
    service: d.service,
    serviceKey: d.serviceKey,
    date: d.date,
    dateLabel: shortDate(d.date),
    partOfDay: d.partOfDay,
    closed: d.closed,
    reason: d.closed ? (d.reason ?? 'Closed') : null,
    hasOpenTimes: d.open,
  }
  let placeholder = issuedLinks.get(ctx) ?? null
  if (!placeholder) {
    const link = await issueLinkOutcome(ctx, { kind: 'calendar', appointmentRef: null, tier: null })
    // a booking link went to this number within the hour (one per kind an hour): they pick the time on that one
    if (!link.ok && link.error === 'rate_limited')
      return ok(json({ ...day, bookingLink: null, linkAlreadyTexted: true, instruction: LINK_TEXTED_RULE }))
    if (!link.ok)
      return ok(
        json({
          ...day,
          bookingLink: null,
          instruction: `${link.message} Do not list or offer specific times and do not ask them to pick a time in the chat.`,
        }),
      )
    placeholder = String((link.data as { placeholder: string }).placeholder)
    issuedLinks.set(ctx, placeholder)
  }
  return ok(
    json({ ...day, bookingLink: placeholder, instruction: LINK_RULE.replace('{link1}', placeholder) }),
  )
}
