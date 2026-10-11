// Status texts as the car moves through the shop (ADR 0160, design section 6, wave W3d): the scheduling StatusTextsPort called by
// lifecycle.finish(), the two jobs (appointments.checkin_texts, appointments.late_texts) and the pure composition the Settings preview
// shares. Every text is off until the owner turns it on in Settings -> Reminders (status_texts.*), except ready-for-pickup, which
// was sent before and stays on.
import type { MessagingRuntime } from '../messaging/runtime.js'
import type { StatusTextsPort } from '../scheduling/ports.js'
import { createStatusTexts } from './service.js'

export * from './compose.js'
export * from './jobs.js'
export * from './service.js'

/** The port over this process's messaging runtime: its queue, the link pages' switch and the website's origin from its env. */
export function statusTextsFor(rt: MessagingRuntime): StatusTextsPort {
  const env = rt.deps.env
  return createStatusTexts({
    queue: rt.queue,
    links: { enabled: env.PUBLIC_LINKS_ENABLED, siteUrl: env.PUBLIC_SITE_URL },
    log: rt.log,
  })
}
