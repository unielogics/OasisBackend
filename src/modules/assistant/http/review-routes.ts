// Settings → Oasis AI: corrections and the review of real conversations (ADR 0174 §5 and §6; api-spec 15.6f):
//   POST /assistant/corrections                    {clientText, rightAnswer, source, practiceTurnId?, assistantTurnId?, active?,
//                                                  replaceEntryId?} → 201 {entry, budget} (set.assistant; a live turn needs cli.view)
//   GET  /assistant/conversations                  real AI conversations of the last days (≤ 90), with flags (set.assistant + cli.view)
//   GET  /assistant/conversations/:id              one conversation turn by turn, redacted ("This answer was wrong" corrects it)
import type { FastifyRequest } from 'fastify'
import { access } from '../../../http/access.js'
import { auditContextOf, hasPermission } from '../../../http/authorizer.js'
import type { AppInstance } from '../../../http/types.js'
import { z } from '../../../http/zod.js'
import { inTx, storedUserId } from '../../settings/http/runtime.js'
import { createCorrection, type CorrectionContext } from '../knowledge/corrections.js'
import { forReader, knowledgeBudget } from '../knowledge/service.js'
import { getConversation, listConversations } from '../review.js'
import { KnowledgeBudgetDto, KnowledgeEntryDto } from './knowledge-routes.js'

const TAGS = ['assistant']
const Uuid = z.string().uuid()
const IdParams = z.object({ id: Uuid })

export const ReviewConversationDto = z.object({
  id: z.string(),
  client: z.object({ firstName: z.string().nullable(), phoneLast4: z.string().describe('"•••0142"') }),
  lastTurnAt: z.string(),
  turns: z.number().int(),
  handoff: z.object({ open: z.boolean(), reason: z.string().nullable() }).nullable(),
  flags: z.array(z.enum(['handed_off', 'fallback', 'judge', 'corrected'])),
})

export const ReviewTurnDto = z.object({
  id: z.string(),
  startedAt: z.string(),
  status: z.string(),
  clientTexts: z.array(z.string()).describe('The client’s texts this turn answered (redacted)'),
  reply: z.string().nullable().describe('What was sent (redacted; links as "[link]")'),
  handoffReason: z.string().nullable(),
  guard: z.array(z.string()).describe('What the output guard changed, in plain words'),
  judge: z.object({ verdict: z.enum(['pass', 'fail', 'error']), category: z.string().nullable(), words: z.string() }).nullable(),
  tools: z.array(z.string()),
  model: z.string().nullable(),
  promptVersion: z.string().nullable(),
  correctionEntryId: z.string().nullable(),
})

export function registerReviewRoutes(app: AppInstance): void {
  const correctionContext = async (req: FastifyRequest): Promise<CorrectionContext> => {
    const a = req.auth!
    return {
      locationId: a.locationId,
      userId: await storedUserId(app.db, a.realUserId ?? a.userId),
      audit: auditContextOf(req),
      newId: app.newId,
      now: app.clock.now(),
      maxChars: app.env.AI_KNOWLEDGE_MAX_CHARS,
      shopNumbers: [app.env.BUSINESS_TEXT_NUMBER, app.env.BUSINESS_PHONE],
      canViewClients: hasPermission(a, 'cli.view'),
    }
  }

  app.post(
    '/assistant/corrections',
    {
      config: { access: access.perm('set.assistant') },
      schema: {
        tags: TAGS,
        operationId: 'createAssistantCorrection',
        summary: 'Save a correction: the client’s question and the right answer, as a knowledge entry',
        description:
          'With a turn named (`practiceTurnId`: one of my practice texts; `assistantTurnId`: a real conversation, needs cli.view), the server loads the wrong reply itself (redacted; never shown to the model) and stores it with the correction; `clientText` is the question as the owner words it (it may be generalised). Plain text (no hidden character, no HTML tag): the question 1..300 characters, the answer 1..500. Same warnings and budget as notes: on by default (`active: false` saves a draft), 422 `KNOWLEDGE_BUDGET {usedChars, maxChars, needed}` when it would not fit. 409 `CORRECTION_EXISTS {entryId}` for the same question (case, spaces and punctuation ignored) unless `replaceEntryId` names it (then it is replaced in place). The model reads it only as `Q: "…" A: "…"` in SHOP KNOWLEDGE. Audited (`assistant.knowledge.create` / `.update`, never the body) and published as `settings.changed {section: assistant_knowledge}`.',
        body: z
          .object({
            clientText: z.string().min(1).max(300),
            rightAnswer: z.string().min(1).max(500),
            source: z.enum(['practice', 'live']),
            practiceTurnId: Uuid.optional(),
            assistantTurnId: Uuid.optional(),
            active: z.boolean().optional(),
            replaceEntryId: Uuid.optional(),
          })
          .strict(),
        response: { 201: z.object({ entry: KnowledgeEntryDto, budget: KnowledgeBudgetDto }) },
      },
    },
    async (req, reply) => {
      const c = await correctionContext(req)
      const created = await inTx(app.db, (tx) => createCorrection(tx, c, req.body))
      const [entry] = await forReader(app.db, c.locationId, [created], c.canViewClients)
      return reply.status(201).send({ entry: entry!, budget: await knowledgeBudget(app.db, c.locationId, app.env.AI_KNOWLEDGE_MAX_CHARS) })
    },
  )

  app.get(
    '/assistant/conversations',
    {
      config: { access: access.perm('set.assistant', 'cli.view') },
      schema: {
        tags: TAGS,
        operationId: 'listAssistantConversations',
        summary: 'Real Oasis AI conversations for training review (90 days at most)',
        description:
          'The location’s conversations with an Oasis AI turn in the last `days` (1..90, default 30), newest first: the client’s first name and the last four digits of the number, the last turn, the number of turns, the handoff, and flags (`handed_off`, `fallback`: the fallback text went or a turn failed, `judge`: the policy check failed or did not answer, `corrected`: a correction was made from it). `filter` keeps one flag. `nextCursor` pages on.',
        querystring: z.object({
          days: z.coerce.number().int().min(1).max(90).default(30),
          filter: z.enum(['all', 'handed_off', 'fallback', 'judge', 'corrected']).default('all'),
          cursor: z.string().max(200).optional(),
          limit: z.coerce.number().int().min(1).max(100).default(50),
        }),
        response: { 200: z.object({ conversations: z.array(ReviewConversationDto), nextCursor: z.string().nullable() }) },
      },
    },
    async (req, reply) => {
      void reply.header('Cache-Control', 'no-store')
      const q = req.query
      return listConversations(app.db, {
        locationId: req.auth!.locationId,
        now: app.clock.now(),
        days: q.days,
        filter: q.filter,
        ...(q.cursor ? { cursor: q.cursor } : {}),
        limit: q.limit,
      })
    },
  )

  app.get(
    '/assistant/conversations/:id',
    {
      config: { access: access.perm('set.assistant', 'cli.view') },
      schema: {
        tags: TAGS,
        operationId: 'getAssistantConversation',
        summary: 'One conversation, turn by turn, with what the guard and the policy check did ("This answer was wrong" opens a correction)',
        description:
          'The turns of the last 90 days: the client’s texts and what was sent, loaded on the server and redacted (phone numbers, codes and card numbers masked, links as "[link]"), the handoff reason, what the output guard and the policy check did in plain words, the tools used, the model, the prompt version and the correction made from the turn. Another location’s conversation, or one without a turn in 90 days, is 404.',
        params: IdParams,
        response: { 200: z.object({ conversation: ReviewConversationDto, turns: z.array(ReviewTurnDto) }) },
      },
    },
    async (req, reply) => {
      void reply.header('Cache-Control', 'no-store')
      return getConversation(app.db, { locationId: req.auth!.locationId, now: app.clock.now(), id: req.params.id })
    },
  )
}
