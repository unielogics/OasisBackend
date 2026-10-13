// Settings → Oasis AI → Practice (ADR 0174 §4c and §6; api-spec 15.6e), all behind set.assistant; a session that plays a real client
// also needs cli.view (checked here: the persona is in the body):
//   POST   /assistant/practice/sessions              a new chat {persona, customerId?, verified?, language?, includeEntryIds?}   201
//   GET    /assistant/practice/sessions              my chats (30 days) and the practice switches and budget
//   GET    /assistant/practice/sessions/:id          one of my chats with its turns (another user's: 404)
//   DELETE /assistant/practice/sessions/:id          204
//   POST   /assistant/practice/sessions/:id/turns    a text {text}; Idempotency-Key; 10 a minute                             202
//   POST   /assistant/practice/turns/:id/rerun       "Try again" (after a correction)                                          202
// A text is answered by job ai.practice (enqueued after the commit); the dashboard polls the session or listens for
// `assistant.practice.turn` (notifications channel, to the session's creator). Nothing here sends, books or writes a client record.
import type { FastifyRequest } from 'fastify'
import { access } from '../../../http/access.js'
import { hasPermission } from '../../../http/authorizer.js'
import type { AppInstance } from '../../../http/types.js'
import { z } from '../../../http/zod.js'
import { AppError } from '../../../platform/errors.js'
import { idem, inTx, storedUserId } from '../../settings/http/runtime.js'
import { AI_PRACTICE_JOB } from '../practice/runner.js'
import {
  createSession,
  createTurn,
  deleteSession,
  failTurn,
  getSession,
  listSessions,
  practiceStatus,
  rerunTurn,
  type PracticeContext,
} from '../practice/service.js'

const TAGS = ['assistant']
const Uuid = z.string().uuid()
const IdParams = z.object({ id: Uuid })

export const PracticeSessionDto = z.object({
  id: z.string(),
  persona: z.enum(['new_texter', 'client']).describe('A synthetic new texter, or a real client on file (read-only; needs cli.view)'),
  client: z
    .object({ id: z.string(), firstName: z.string().nullable() })
    .nullable()
    .describe('The client a `client` session plays (null for a new texter)'),
  verified: z.boolean().describe('The phone counts as verified in this session (in-chat booking, with AI_ACTIONS_ENABLED)'),
  language: z.enum(['en', 'es']),
  includeEntryIds: z.array(z.string()).describe('Draft knowledge entries this session reads as if they were on ("Try this draft")'),
  turns: z.number().int(),
  costMicros: z.number().int().describe('USD millionths spent by this session (practice has its own daily budget)'),
  createdAt: z.string(),
  updatedAt: z.string(),
})

const Badge = z.object({
  kind: z.enum(['rewritten', 'shortened', 'policy_rewrite', 'handed_off', 'fallback', 'link', 'proposal', 'opted_out', 'looked_up']),
  label: z.string().describe('Plain words ("Booking link", "Handed to staff: asked for a person", "Looked up: open times")'),
})

export const PracticeTurnDto = z.object({
  id: z.string(),
  sessionId: z.string(),
  seq: z.number().int(),
  rerunOf: z.string().nullable().describe('The turn this one re-runs ("After your correction")'),
  clientText: z.string(),
  status: z.enum(['running', 'replied', 'handed_off', 'failed', 'opted_out']),
  replyText: z.string().nullable().describe('What the client would get; links as "[booking link]"'),
  extraTexts: z.array(z.string()).describe('Other texts the server would send (a proposal’s confirmation with its reply number)'),
  badges: z.array(Badge),
  error: z.string().nullable(),
  latencyMs: z.number().int().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
})

const PracticeStatus = z.object({
  enabled: z.boolean().describe('AI_PRACTICE_ENABLED'),
  budgetUsd: z.number().describe('AI_PRACTICE_DAILY_BUDGET_USD'),
  spentTodayUsd: z.number(),
  actionsEnabled: z.boolean().describe('Practice mirrors AI_ACTIONS_ENABLED and the setting: off, it never proposes'),
  linksEnabled: z.boolean().describe('Practice mirrors PUBLIC_LINKS_ENABLED: off, it sends no link'),
})

/** The turn a text created, for its job enqueued once the command committed (never on an idempotent replay). */
const created = new WeakMap<FastifyRequest, string>()

export function registerPracticeRoutes(app: AppInstance): void {
  const context = async (req: FastifyRequest): Promise<PracticeContext> => {
    const a = req.auth!
    const userId = await storedUserId(app.db, a.realUserId ?? a.userId)
    // practice belongs to a person with a login (a kiosk or service actor has none)
    if (!userId) throw new AppError('FORBIDDEN', { meta: { required: ['a user login'], mode: 'all' } })
    return { locationId: a.locationId, userId, now: app.clock.now(), newId: app.newId, env: app.env }
  }
  /** ai.practice for a turn (after the commit); a turn whose job cannot be queued fails at once rather than hang. */
  const kick = async (turnId: string): Promise<void> => {
    const ok = await (app.jobs?.enqueue(AI_PRACTICE_JOB, { turnId }) ?? Promise.resolve(null)).catch(() => null)
    if (!ok) await failTurn(app.db, turnId, app.clock.now(), 'not_queued')
  }

  app.post(
    '/assistant/practice/sessions',
    {
      config: { access: access.perm('set.assistant') },
      schema: {
        tags: TAGS,
        operationId: 'createAssistantPracticeSession',
        summary: 'Start a practice chat (the owner texts as a client; nothing is sent or booked)',
        description:
          'A client persona needs cli.view (403) and a client of the shop (404). 409 `PRACTICE_OFF` while AI_PRACTICE_ENABLED is false (whatever AI_ENABLED says); 429 `PRACTICE_LIMIT` after 20 sessions a user a day. `includeEntryIds` are draft knowledge entries the session reads as if they were on ("Try this draft"; 422 when one does not exist). Practice mirrors the saved settings, AI_ACTIONS_ENABLED and PUBLIC_LINKS_ENABLED.',
        body: z
          .object({
            persona: z.enum(['new_texter', 'client']),
            customerId: Uuid.nullable().optional().describe('The client a `client` session plays'),
            verified: z.boolean().optional(),
            language: z.enum(['en', 'es']).optional(),
            includeEntryIds: z.array(Uuid).max(20).optional(),
          })
          .strict(),
        response: { 201: z.object({ session: PracticeSessionDto }) },
      },
    },
    async (req, reply) => {
      if (req.body.persona === 'client' && !hasPermission(req.auth!, 'cli.view'))
        throw new AppError('FORBIDDEN', { meta: { required: ['cli.view'], mode: 'all' } })
      const c = await context(req)
      const session = await inTx(app.db, (tx) => createSession(tx, c, req.body))
      return reply.status(201).send({ session })
    },
  )

  app.get(
    '/assistant/practice/sessions',
    {
      config: { access: access.perm('set.assistant') },
      schema: {
        tags: TAGS,
        operationId: 'listAssistantPracticeSessions',
        summary: 'My practice chats (newest first; kept 30 days) and the practice switches and budget',
        response: { 200: z.object({ sessions: z.array(PracticeSessionDto), practice: PracticeStatus }) },
      },
    },
    async (req) => {
      const c = await context(req)
      return { sessions: await listSessions(app.db, c), practice: await practiceStatus(app.db, c) }
    },
  )

  app.get(
    '/assistant/practice/sessions/:id',
    {
      config: { access: access.perm('set.assistant') },
      schema: {
        tags: TAGS,
        operationId: 'getAssistantPracticeSession',
        summary: 'One of my practice chats with its turns (another user’s is 404)',
        description: 'Poll it every 2 s while a turn is `running`, or listen for `assistant.practice.turn {sessionId, turnId}` on the notifications channel.',
        params: IdParams,
        response: { 200: z.object({ session: PracticeSessionDto, turns: z.array(PracticeTurnDto) }) },
      },
    },
    async (req, reply) => {
      void reply.header('Cache-Control', 'no-store')
      return getSession(app.db, await context(req), req.params.id)
    },
  )

  app.delete(
    '/assistant/practice/sessions/:id',
    {
      config: { access: access.perm('set.assistant') },
      schema: {
        tags: TAGS,
        operationId: 'deleteAssistantPracticeSession',
        summary: 'Delete one of my practice chats',
        params: IdParams,
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      const c = await context(req)
      await inTx(app.db, (tx) => deleteSession(tx, c, req.params.id))
      return reply.status(204).send(null)
    },
  )

  app.post(
    '/assistant/practice/sessions/:id/turns',
    {
      config: { access: access.perm('set.assistant'), idempotency: 'required', rateLimit: { max: 10, timeWindow: '1 minute' } },
      // after the idempotent command committed and before the answer leaves: the job can only find a committed turn
      onSend: async (req, _reply, payload) => {
        const id = created.get(req)
        if (id) {
          created.delete(req)
          await kick(id)
        }
        return payload
      },
      schema: {
        tags: TAGS,
        operationId: 'createAssistantPracticeTurn',
        summary: 'Text Oasis AI in a practice chat; the answer comes from a job (poll the session or listen for assistant.practice.turn)',
        description:
          'Idempotency-Key required. 202 with the turn `running`; 409 `PRACTICE_BUSY` while one runs (a turn running over 5 minutes is failed as `timeout`), `PRACTICE_OFF`, `PRACTICE_ENDED` after the client opted out; 429 `PRACTICE_BUDGET` when today’s practice budget is spent, `PRACTICE_LIMIT` after 40 turns a session.',
        params: IdParams,
        body: z.object({ text: z.string().min(1).max(640) }).strict(),
        response: { 202: z.object({ turn: PracticeTurnDto }) },
      },
    },
    idem(async (req, tx) => {
      const r = req as FastifyRequest<{ Params: { id: string }; Body: { text: string } }>
      const turn = await createTurn(tx, await context(r), r.params.id, r.body.text)
      created.set(req, turn.id)
      return { status: 202, body: { turn } }
    }),
  )

  app.post(
    '/assistant/practice/turns/:id/rerun',
    {
      config: { access: access.perm('set.assistant'), rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        tags: TAGS,
        operationId: 'rerunAssistantPracticeTurn',
        summary: '"Try again": the same client text over the session’s earlier turns, as an alternate turn (after a correction)',
        description:
          'The re-run reads the knowledge as it is now (a correction saved meanwhile is in it) and starts from the session as it was before that text; it never changes the session’s own state. Same switches, budget and limits as a text (409 `PRACTICE_BUSY`, `PRACTICE_OFF`; 429 `PRACTICE_BUDGET`, `PRACTICE_LIMIT`); another user’s turn is 404.',
        params: IdParams,
        response: { 202: z.object({ turn: PracticeTurnDto }) },
      },
    },
    async (req, reply) => {
      const c = await context(req)
      const turn = await inTx(app.db, (tx) => rerunTurn(tx, c, req.params.id))
      await kick(turn.id)
      return reply.status(202).send({ turn })
    },
  )
}
