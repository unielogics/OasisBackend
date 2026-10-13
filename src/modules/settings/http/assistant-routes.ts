// Settings → Assistant (ADR 0160, design section 8, plan G): GET/PUT /settings/assistant over the assistant.* settings, one version
// token for the section (the sum of its setting versions), validation, audit and settings.changed per changed key, set.assistant to
// save (ADR 0174: its own permission since 2026-10-13; the migration gave it to every role that held set.hours, the permission it
// used before). The allowlist holds the owner's and staff's own mobile numbers, so a reader without set.assistant sees them masked
// to the last four digits (review F2).
import { access } from '../../../http/access.js'
import { hasPermission } from '../../../http/authorizer.js'
import { maskPhone } from '../../../platform/phone.js'
import { z } from '../../../http/zod.js'
import {
  loadAssistantSettings,
  saveAssistantSettings,
  type AssistantPatch,
  type AssistantSettings,
} from './assistant-service.js'
import { etag, inTx, requestContext, requiredVersion, storedUserId, type SettingsRuntime } from './runtime.js'

const FaqPair = z.object({
  q: z.string().describe('The question as a client would ask it, plain text, 500 characters at most'),
  a: z.string().describe('The answer the assistant gives, plain text, 500 characters at most'),
})

const Fields = z.object({
  enabled: z.boolean().describe('The assistant answers texts (with AI_ENABLED on the server); off: texts reach staff as today'),
  actionsEnabled: z
    .boolean()
    .describe('The assistant may book, reschedule and cancel in the chat, each confirmed by a reply number (with AI_ACTIONS_ENABLED on the server)'),
  stage: z
    .enum(['allowlist', 'customers', 'everyone'])
    .describe('Who it answers: only the allowlisted numbers, then also known clients, then everyone'),
  allowlist: z
    .array(z.string())
    .describe(
      'The numbers of the first stage (the owner and staff), E.164 (+12015550142; "(201) 555-0142" is read too), textable US/Canadian numbers, at most 50, each once. ' +
        'GET shows them masked to the last four digits ("+1******0142") to a reader without set.assistant',
    ),
  staffPauseHours: z.number().int().describe('A staff reply pauses the assistant on that thread this many hours, 1 to 72'),
  faq: z.array(FaqPair).describe('Questions and answers the assistant answers from, at most 40 pairs, plain text, each question once'),
  capabilities: z
    .object({
      availability: z.boolean().describe('It may look up open times (check_availability)'),
      bookingLinks: z.boolean().describe('It may text booking and verify links'),
      membershipLinks: z.boolean().describe('It may text a link to join a membership'),
      paymentLinks: z.boolean().describe('It may text a link to pay an open invoice'),
      accountInfo: z.boolean().describe('It may tell a client their balance, visits and membership'),
    })
    .strict()
    .describe(
      'ADR 0174 limits: what the assistant may do (all on by default = today). Settings only take abilities away; booking, moving and cancelling by text stays `actionsEnabled`. "Answer questions only" is all five off. Stored now, applied by the turn from the policy wave on',
    ),
  behavior: z
    .object({
      tone: z.enum(['friendly', 'professional', 'warm', 'concise']).describe('A fixed, vetted tone sentence'),
      length: z.enum(['short', 'standard']).describe('The reply length it aims for (320 characters stays the hard cap)'),
      styleNotes: z.string().describe('The owner’s style preferences, plain text, at most 400 characters (quoted to the model as data)'),
      spanish: z.enum(['on', 'english', 'handoff']).describe('Spanish texts: answer in Spanish, answer in English, or hand them to the team'),
      avoidWords: z.array(z.string()).describe('Words and phrases it never uses: 2 to 40 characters each, at most 30, each once'),
      avoidTopics: z.array(z.string()).describe('Topics it does not discuss: 3 to 80 characters each, at most 15, each once'),
      handoffTopics: z
        .array(z.string())
        .describe('Topics it always hands to the team: 3 to 80 characters each, at most 15, each once, none also in avoidTopics'),
      signOff: z
        .string()
        .describe('An optional sign-off the server adds, at most 24 characters, no amount, number, link or promise ("" = none)'),
    })
    .strict()
    .describe('ADR 0174 tone: how the assistant writes (defaults = today). Stored now, applied by the turn from the policy wave on'),
})

export const AssistantView = Fields.extend({
  server: z
    .object({
      aiEnabled: z.boolean().describe('AI_ENABLED: off, the assistant answers nobody whatever this section says'),
      actionsEnabled: z.boolean().describe('AI_ACTIONS_ENABLED: off, no in-chat booking, rescheduling or cancelling'),
    })
    .describe('Read-only: the server switches (environment), which this section cannot change'),
  active: z.boolean().describe('Read-only: the assistant answers texts now (AI_ENABLED and enabled)'),
  version: z.number().int().describe('The section’s version (ETag): send it back with PUT'),
})

const Patch = Fields.partial().strict()

export function registerAssistantRoutes(rt: SettingsRuntime): void {
  const { app } = rt

  const view = (s: AssistantSettings, fullNumbers = true): z.infer<typeof AssistantView> => ({
    ...s.values,
    allowlist: fullNumbers ? s.values.allowlist : s.values.allowlist.map(maskPhone),
    server: { aiEnabled: app.env.AI_ENABLED, actionsEnabled: app.env.AI_ACTIONS_ENABLED },
    active: app.env.AI_ENABLED && s.values.enabled,
    version: s.version,
  })

  app.get(
    '/settings/assistant',
    {
      config: { access: access.authenticated() },
      schema: {
        tags: ['settings'],
        operationId: 'getSettingsAssistant',
        summary: 'The AI text assistant: on/off, in-chat actions, stage, allowlist, staff pause, FAQ, limits and tone (ETag = version)',
        description: 'Any signed-in user may read it; without set.assistant the allowlist numbers come masked to their last four digits.',
        response: { 200: AssistantView },
      },
    },
    async (req, reply) => {
      const c = requestContext(req)
      const s = await loadAssistantSettings(app.db, c.locationId)
      etag(reply, s.version)
      return view(s, hasPermission(req.auth!, 'set.assistant'))
    },
  )

  app.put(
    '/settings/assistant',
    {
      config: { access: access.perm('set.assistant') },
      schema: {
        tags: ['settings'],
        operationId: 'putSettingsAssistant',
        summary: 'Save the Assistant section (the dirty-tracked save)',
        description:
          'Partial: any field; the rest stays (`allowlist`, `faq`, `capabilities` and `behavior` are replaced as a whole). `version` (or If-Match) is required and must be the section’s current version: 412 VERSION_CONFLICT otherwise, 428 without one. ' +
          'Validated against the settings registry plus the section’s rules (allowlist: E.164 textable US/Canadian numbers, each once, at most 50; FAQ: at most 40 pairs of plain text, 500 characters each, no hidden, invisible or control characters (a tab or line break is fine) or HTML, each question once; behavior (ADR 0174): plain text, each list without repeats, a topic not both avoided and handed to the team, a sign-off without an amount, number, link or promise). ' +
          'A FAQ that grows past the knowledge budget (AI_KNOWLEDGE_MAX_CHARS, shared with the active knowledge entries) is refused with 422 `KNOWLEDGE_BUDGET {usedChars, maxChars, needed}`; a save that shrinks it always passes. ' +
          'Each changed setting is audited (settings.update) and published as `settings.changed` (section assistant). The server switches (`server`) are read-only.',
        body: Patch.extend({
          version: z.number().int().min(0).optional(),
          // read-only fields of GET /settings/assistant, accepted so a loaded view can be sent back as it is
          server: z.unknown().optional(),
          active: z.unknown().optional(),
        }).strict(),
        response: { 200: AssistantView.extend({ changed: z.array(z.string()).describe('The setting keys this save changed') }) },
      },
    },
    async (req, reply) => {
      const c = requestContext(req)
      const version = requiredVersion(req, req.body.version)
      const { enabled, actionsEnabled, stage, allowlist, staffPauseHours, faq, capabilities, behavior } = req.body
      const out = await inTx(app.db, async (tx) =>
        saveAssistantSettings(tx, {
          locationId: c.locationId,
          patch: { enabled, actionsEnabled, stage, allowlist, staffPauseHours, faq, capabilities, behavior } as AssistantPatch,
          expectedVersion: version,
          updatedBy: await storedUserId(tx, c.userId),
          audit: c.audit,
        }),
      )
      etag(reply, out.version)
      return { ...view(out), changed: out.changed }
    },
  )
}
