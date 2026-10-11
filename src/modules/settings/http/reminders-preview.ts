// The Reminders preview (ADR 0160, plan I): every automatic text of the section, rendered through the template registry exactly as
// it goes out (GSM-7 normalisation, segment count) for a sample appointment, from the saved settings or a draft the screen has not
// saved yet. The reminder texts come from reminderMessage(), the very composition the reminders job sends.
import type { SmsClass } from '../../messaging/policy/classes.js'
import { offsetLabel, prepTextFor, reminderMessage } from '../../messaging/jobs/reminders.js'
import { renderSms, type TemplateVars } from '../../messaging/templates/render.js'
import { checkedInMessage, lateMessage, pickedUpMessage, receiptLine } from '../../status-texts/compose.js'
import { addDays, fmtT, toBizDate, wallToInstant } from '../../../platform/time.js'
import type { ReminderCategory, ReminderValues } from './reminders-service.js'

export interface PreviewSample {
  firstName?: string
  /** Business date of the sample visit (YYYY-MM-DD); tomorrow by default. */
  date?: string
  /** Start, minutes after midnight; 10:00 AM by default. */
  startMin?: number
  /** Category keys of the sample visit; by default the categories that have a preparation line, else wash. */
  categories?: string[]
}

export interface PreviewText {
  id: string
  group: 'reminders' | 'statusTexts' | 'leads'
  label: string
  /** When it goes out, in words ("24 h before", "3 min after check-in"). */
  timing: string
  templateKey: string
  klass: SmsClass
  enabled: boolean
  /** Exactly what the phone receives (GSM-7 normalised). */
  text: string
  segments: number
  encoding: 'GSM-7' | 'UCS-2'
}

export interface PreviewResult {
  sample: { firstName: string; startsAt: string; date: string; time: string; categories: string[] }
  texts: PreviewText[]
}

/** A personal link as long as a real one (32-byte token), so the segment count is the real count. */
export const SAMPLE_LINK = `https://oasisautospanj.com/#/c/${'x'.repeat(43)}`
/** The sample visit's paid invoice, for the picked-up text's receipt line. */
export const SAMPLE_PAID_CENTS = 4500

export function buildPreview(o: {
  values: ReminderValues
  categories: readonly ReminderCategory[]
  sample: PreviewSample
  now: Date
  tz: string
}): PreviewResult {
  const v = o.values
  const firstName = o.sample.firstName?.trim() || 'Maria'
  const date = o.sample.date ?? addDays(toBizDate(o.now, o.tz), 1)
  const startMin = o.sample.startMin ?? 600
  const start = wallToInstant(date, startMin, o.tz)
  const order = o.categories.map((c) => c.key)
  const wanted =
    o.sample.categories ??
    (Object.keys(v.reminders.categoryPrep).length ? Object.keys(v.reminders.categoryPrep) : order.includes('wash') ? ['wash'] : [])
  // the appointment keeps its categories in catalog order, as appointments.categories does
  const categories = [...new Set(wanted)].sort((a, b) => order.indexOf(a) - order.indexOf(b))
  const prep = prepTextFor(categories, v.reminders.categoryPrep)
  const texts: PreviewText[] = []
  const add = (
    t: Omit<PreviewText, 'text' | 'segments' | 'encoding' | 'klass'> & { vars: TemplateVars },
  ): void => {
    const r = renderSms(t.templateKey, t.vars, { firstMessageToNumber: false })
    texts.push({
      id: t.id,
      group: t.group,
      label: t.label,
      timing: t.timing,
      templateKey: t.templateKey,
      enabled: t.enabled,
      klass: r.klass,
      text: r.prepared.body,
      segments: r.prepared.segments,
      encoding: r.prepared.encoding,
    })
  }

  for (const off of v.reminders.offsetsMin) {
    const now = new Date(start.getTime() - off * 60_000)
    for (const status of ['booked', 'confirmed'] as const) {
      const m = reminderMessage({ status, confirmRequest: v.reminders.confirmRequest, start, now, tz: o.tz, prep })
      add({
        id: `reminder.${off}.${status}`,
        group: 'reminders',
        label: status === 'booked' ? 'Reminder · booked, not confirmed yet' : 'Reminder · confirmed',
        timing: `${offsetLabel(off)} before`,
        templateKey: m.templateKey,
        enabled: true,
        vars: m.vars,
      })
    }
  }
  add({
    id: 'review',
    group: 'reminders',
    label: 'Review request',
    timing: '2 h after the visit',
    templateKey: 'review',
    enabled: v.reminders.reviewRequest,
    vars: {},
  })

  // the status texts compose exactly as the status-texts module sends them (src/modules/status-texts/compose.ts)
  const s = v.statusTexts
  const checkedIn = checkedInMessage()
  add({
    id: 'status.checked_in',
    group: 'statusTexts',
    label: 'Checked in',
    timing: `${s.checkedInDelayMin} min after a manual check-in (not sent once the wash starts)`,
    templateKey: checkedIn.templateKey,
    enabled: s.checkedIn,
    vars: checkedIn.vars,
  })
  add({
    id: 'status.wash_started',
    group: 'statusTexts',
    label: 'Wash started',
    timing: 'when cleaning starts',
    templateKey: 'in_progress',
    enabled: true,
    vars: {},
  })
  const late = lateMessage(new Date(start.getTime() + 90 * 60_000), o.tz)
  add({
    id: 'status.running_late',
    group: 'statusTexts',
    label: 'Running late',
    timing: `${s.lateGraceMin} min past the promised time, at most ${s.lateMax} per visit`,
    templateKey: late.templateKey,
    enabled: s.runningLate && s.lateMax > 0,
    vars: late.vars,
  })
  add({
    id: 'status.ready',
    group: 'statusTexts',
    label: 'Ready for pickup',
    timing: 'when the wash is done',
    templateKey: 'ready',
    enabled: s.ready,
    vars: {},
  })
  const pickedUp = pickedUpMessage({
    firstName,
    receipt: receiptLine({ totalCents: SAMPLE_PAID_CENTS, balanceCents: 0 }, false),
    link: s.bookAgainLink ? SAMPLE_LINK : null,
  })
  add({
    id: 'status.picked_up',
    group: 'statusTexts',
    label: 'Picked up',
    timing: `when the car leaves (“Paid in full” only when nothing is owed and no receipt text went in the last 2 h${s.bookAgainLink ? '; the link only for clients who agreed to marketing texts' : ''})`,
    templateKey: pickedUp.templateKey,
    enabled: s.pickedUp,
    vars: { ...pickedUp.vars, ...pickedUp.secretVars },
  })

  const l = v.leads
  add({
    id: 'lead.follow_up',
    group: 'leads',
    label: 'Lead follow-up (once)',
    timing: `${l.followUpDelayMin} min after their last text${l.businessHoursOnly ? ', in business hours' : ''}, within ${l.withinHours} h`,
    templateKey: 'lead_follow_up',
    enabled: l.followUpEnabled,
    vars: { first: firstName, interest: 'window tint', link: SAMPLE_LINK },
  })

  return {
    sample: {
      firstName,
      startsAt: start.toISOString(),
      date,
      time: fmtT(startMin),
      categories,
    },
    texts,
  }
}

