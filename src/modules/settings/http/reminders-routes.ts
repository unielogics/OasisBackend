// Settings → Reminders (ADR 0160, plan I): GET/PUT /settings/reminders and the preview of the exact texts.
import { access } from '../../../http/access.js'
import { z } from '../../../http/zod.js'
import { buildPreview } from './reminders-preview.js'
import {
  loadReminderSettings,
  mergeReminderValues,
  saveReminderSettings,
  type ReminderPatch,
  type ReminderSettings,
} from './reminders-service.js'
import { businessTzOf, etag, inTx, requestContext, requiredVersion, storedUserId, type SettingsRuntime } from './runtime.js'

const Minutes = z.number().int()
const CategoryKey = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/, 'Use a category key')

const RemindersGroup = z.object({
  offsetsMin: z
    .array(Minutes)
    .describe('Minutes before the visit, longest first (at most 5, each 1 to 10080); [] turns appointment reminders off'),
  confirmRequest: z
    .boolean()
    .describe('A booked visit that is not confirmed yet is asked to "Reply C to confirm"; off: it gets the plain reminder'),
  categoryPrep: z
    .record(CategoryKey, z.string())
    .describe('The preparation line added to the reminder of a visit holding that category (e.g. tint: "Plan for 2–3 hours."), 160 characters at most'),
  reviewRequest: z.boolean().describe('One review request 2 hours after a completed visit (reviews.enabled)'),
})
const StatusTextsGroup = z.object({
  checkedIn: z.boolean(),
  checkedInDelayMin: Minutes.describe('0 to 30; the text is dropped when the wash starts first'),
  runningLate: z.boolean(),
  lateGraceMin: Minutes.describe('Minutes past the promised end before the first "running late" text, 0 to 120'),
  lateMax: Minutes.describe('At most this many per visit, 0 to 2'),
  ready: z.boolean(),
  pickedUp: z.boolean(),
  bookAgainLink: z.boolean().describe('The picked-up text carries a book-again link (only to clients with marketing-grade consent)'),
})
const LeadsGroup = z.object({
  followUpEnabled: z.boolean().describe('One automatic follow-up text to a lead who did not book'),
  followUpDelayMin: Minutes.describe('15 to 1440 minutes after their last text'),
  businessHoursOnly: z.boolean(),
  withinHours: Minutes.describe('Only within this many hours of their last text, 1 to 24'),
})

export const RemindersView = z.object({
  reminders: RemindersGroup,
  statusTexts: StatusTextsGroup,
  leads: LeadsGroup,
  categories: z
    .array(z.object({ key: z.string(), label: z.string(), colour: z.string(), active: z.boolean() }))
    .describe('The catalog categories a preparation line can name (read-only here; Settings → Catalog edits them)'),
  quietHours: z
    .object({ enabled: z.boolean(), start: z.string(), end: z.string() })
    .describe('Read-only: automated texts wait for the end of quiet hours'),
  version: z.number().int().describe('The section’s version (ETag): send it back with PUT'),
})

const Patch = z
  .object({
    reminders: RemindersGroup.partial().strict().optional(),
    statusTexts: StatusTextsGroup.partial().strict().optional(),
    leads: LeadsGroup.partial().strict().optional(),
  })
  .strict()

const PreviewSample = z
  .object({
    firstName: z.string().trim().min(1).max(40).optional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').optional(),
    startMin: z.number().int().min(0).max(1439).optional(),
    categories: z.array(CategoryKey).max(10).optional(),
  })
  .strict()

const PreviewText = z.object({
  id: z.string(),
  group: z.enum(['reminders', 'statusTexts', 'leads']),
  label: z.string(),
  timing: z.string(),
  templateKey: z.string(),
  klass: z.string(),
  enabled: z.boolean(),
  text: z.string().describe('Exactly what the phone receives (GSM-7 normalised; the first text to a number also gets the STOP line)'),
  segments: z.number().int(),
  encoding: z.enum(['GSM-7', 'UCS-2']),
})

export const RemindersPreview = z.object({
  sample: z.object({
    firstName: z.string(),
    startsAt: z.string(),
    date: z.string(),
    time: z.string(),
    categories: z.array(z.string()),
  }),
  texts: z.array(PreviewText),
})

const view = (s: ReminderSettings): z.infer<typeof RemindersView> => ({
  ...s.values,
  categories: s.categories,
  quietHours: s.quietHours,
  version: s.version,
})

export function registerRemindersRoutes(rt: SettingsRuntime): void {
  const { app } = rt

  app.get(
    '/settings/reminders',
    {
      config: { access: access.authenticated() },
      schema: {
        tags: ['settings'],
        operationId: 'getSettingsReminders',
        summary: 'Reminders, status texts and the lead follow-up (ETag = version)',
        response: { 200: RemindersView },
      },
    },
    async (req, reply) => {
      const c = requestContext(req)
      const s = await loadReminderSettings(app.db, c.locationId)
      etag(reply, s.version)
      return view(s)
    },
  )

  app.put(
    '/settings/reminders',
    {
      config: { access: access.perm('set.hours') },
      schema: {
        tags: ['settings'],
        operationId: 'putSettingsReminders',
        summary: 'Save the Reminders section (the dirty-tracked save)',
        description:
          'Partial: any group and any field of it; the rest stays. `version` (or If-Match) is required and must be the section’s current version: 412 VERSION_CONFLICT otherwise, 428 without one. ' +
          'Validated against the settings registry plus the section’s rules (offsets listed once, stored longest first; a preparation line only for an existing category, in plain SMS characters; an empty line removes it). ' +
          'Each changed setting is audited (settings.update) and published as `settings.changed` (sections reminders, reviews, status_texts, leads).',
        body: Patch.extend({
          version: z.number().int().min(0).optional(),
          // read-only fields of GET /settings/reminders, accepted so a loaded view can be sent back as it is
          categories: z.array(z.unknown()).optional(),
          quietHours: z.unknown().optional(),
        }).strict(),
        response: { 200: RemindersView.extend({ changed: z.array(z.string()).describe('The setting keys this save changed') }) },
      },
    },
    async (req, reply) => {
      const c = requestContext(req)
      const version = requiredVersion(req, req.body.version)
      const { reminders, statusTexts, leads } = req.body
      const out = await inTx(app.db, async (tx) =>
        saveReminderSettings(tx, {
          locationId: c.locationId,
          patch: { reminders, statusTexts, leads } as ReminderPatch,
          expectedVersion: version,
          updatedBy: await storedUserId(tx, c.userId),
          audit: c.audit,
        }),
      )
      etag(reply, out.version)
      return { ...view(out), changed: out.changed }
    },
  )

  app.post(
    '/settings/reminders/preview',
    {
      config: { access: access.authenticated() },
      schema: {
        tags: ['settings'],
        operationId: 'previewSettingsReminders',
        summary: 'The exact texts of the Reminders section for a sample appointment (saved settings, or a draft)',
        description:
          'Renders every reminder (per offset, booked and confirmed), the review request, the status texts and the lead follow-up through the template registry, as they go out: GSM-7 normalised with the segment count. ' +
          '`draft` (the same shape as PUT, validated the same way) previews unsaved edits; `sample` sets the visit (tomorrow 10:00 AM with the categories that have a preparation line by default). Changes nothing.',
        body: z.object({ draft: Patch.optional(), sample: PreviewSample.optional() }).strict(),
        response: { 200: RemindersPreview },
      },
    },
    async (req) => {
      const c = requestContext(req)
      const s = await loadReminderSettings(app.db, c.locationId)
      const values = req.body.draft ? mergeReminderValues(s.values, req.body.draft as ReminderPatch, s.categories) : s.values
      const tz = await businessTzOf(app.db, c.locationId, app.env.BUSINESS_TZ)
      return buildPreview({ values, categories: s.categories, sample: req.body.sample ?? {}, now: app.clock.now(), tz })
    },
  )
}
