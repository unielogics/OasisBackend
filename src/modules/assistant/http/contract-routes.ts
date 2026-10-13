// CONTRACTS ONLY (ADR 0174 §6; api-spec 15.6e and 15.6f): the routes of the practice chat, the corrections and the review of real
// conversations, with their request and response schemas fixed now so the dashboard can build against them. Each answers 501
// NOT_BUILT until the next wave (K2c: policy wiring, the practice runtime, corrections and review) replaces the handler. The
// permissions are final: set.assistant everywhere; the review of real conversations also needs cli.view, and so does a practice
// session as a real client (checked by the handler, since the persona is in the body).
import { access } from '../../../http/access.js'
import type { AppInstance } from '../../../http/types.js'
import { z } from '../../../http/zod.js'
import { AppError } from '../../../platform/errors.js'
import { idem } from '../../settings/http/runtime.js'
import { KnowledgeBudgetDto, KnowledgeEntryDto } from './knowledge-routes.js'

const TAGS = ['assistant']
const Uuid = z.string().uuid()
const IdParams = z.object({ id: Uuid })
const NOT_BUILT = 'Contract only (ADR 0174): answers 501 NOT_BUILT until the practice and review wave builds it.'

const notBuilt = async (): Promise<never> => {
  throw new AppError('NOT_BUILT')
}

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
  kind: z.enum([
    'rewritten',
    'shortened',
    'policy_rewrite',
    'handed_off',
    'fallback',
    'link',
    'proposal',
    'opted_out',
    'looked_up',
  ]),
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

export function registerContractRoutes(app: AppInstance): void {
  app.post(
    '/assistant/practice/sessions',
    {
      config: { access: access.perm('set.assistant') },
      schema: {
        tags: TAGS,
        operationId: 'createAssistantPracticeSession',
        summary: 'Start a practice chat (the owner texts as a client; nothing is sent or booked)',
        description: `${NOT_BUILT} A client persona needs cli.view (403). 409 \`PRACTICE_OFF\` while AI_PRACTICE_ENABLED is false; 20 sessions per user a day.`,
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
    notBuilt,
  )

  app.get(
    '/assistant/practice/sessions',
    {
      config: { access: access.perm('set.assistant') },
      schema: {
        tags: TAGS,
        operationId: 'listAssistantPracticeSessions',
        summary: 'My practice chats (newest first; kept 30 days) and the practice switches and budget',
        description: NOT_BUILT,
        response: { 200: z.object({ sessions: z.array(PracticeSessionDto), practice: PracticeStatus }) },
      },
    },
    notBuilt,
  )

  app.get(
    '/assistant/practice/sessions/:id',
    {
      config: { access: access.perm('set.assistant') },
      schema: {
        tags: TAGS,
        operationId: 'getAssistantPracticeSession',
        summary: 'One of my practice chats with its turns (another user’s is 404)',
        description: NOT_BUILT,
        params: IdParams,
        response: { 200: z.object({ session: PracticeSessionDto, turns: z.array(PracticeTurnDto) }) },
      },
    },
    notBuilt,
  )

  app.delete(
    '/assistant/practice/sessions/:id',
    {
      config: { access: access.perm('set.assistant') },
      schema: {
        tags: TAGS,
        operationId: 'deleteAssistantPracticeSession',
        summary: 'Delete one of my practice chats',
        description: NOT_BUILT,
        params: IdParams,
        response: { 204: z.null() },
      },
    },
    notBuilt,
  )

  app.post(
    '/assistant/practice/sessions/:id/turns',
    {
      config: { access: access.perm('set.assistant'), idempotency: 'required', rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        tags: TAGS,
        operationId: 'createAssistantPracticeTurn',
        summary: 'Text Oasis AI in a practice chat; the answer comes from a job (poll the session or listen for assistant.practice.turn)',
        description: `${NOT_BUILT} Idempotency-Key required. 202 with the turn \`running\`; 409 \`PRACTICE_BUSY\` while one runs, \`PRACTICE_OFF\`; 429 \`PRACTICE_BUDGET\` when today’s practice budget is spent; 40 turns per session.`,
        params: IdParams,
        body: z.object({ text: z.string().min(1).max(640) }).strict(),
        response: { 202: z.object({ turn: PracticeTurnDto }) },
      },
    },
    idem(notBuilt),
  )

  app.post(
    '/assistant/practice/turns/:id/rerun',
    {
      config: { access: access.perm('set.assistant'), rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        tags: TAGS,
        operationId: 'rerunAssistantPracticeTurn',
        summary: '"Try again": the same client text over the session’s earlier turns, as an alternate turn (after a correction)',
        description: NOT_BUILT,
        params: IdParams,
        response: { 202: z.object({ turn: PracticeTurnDto }) },
      },
    },
    notBuilt,
  )

  app.post(
    '/assistant/corrections',
    {
      config: { access: access.perm('set.assistant') },
      schema: {
        tags: TAGS,
        operationId: 'createAssistantCorrection',
        summary: 'Save a correction: the client’s question and the right answer, as a knowledge entry',
        description: `${NOT_BUILT} With a turn named, the server loads the client’s text and the wrong reply itself (redacted; the wrong reply is never shown to the model). Same validation and warnings as notes; the budget applies (\`active: false\` saves a draft). 409 \`CORRECTION_EXISTS {entryId}\` for the same question (send \`replaceEntryId\` to replace it).`,
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
    notBuilt,
  )

  app.get(
    '/assistant/conversations',
    {
      config: { access: access.perm('set.assistant', 'cli.view') },
      schema: {
        tags: TAGS,
        operationId: 'listAssistantConversations',
        summary: 'Real Oasis AI conversations for training review (90 days at most)',
        description: NOT_BUILT,
        querystring: z.object({
          days: z.coerce.number().int().min(1).max(90).default(30),
          filter: z.enum(['all', 'handed_off', 'fallback', 'judge', 'corrected']).default('all'),
          cursor: z.string().max(200).optional(),
          limit: z.coerce.number().int().min(1).max(100).default(50),
        }),
        response: { 200: z.object({ conversations: z.array(ReviewConversationDto), nextCursor: z.string().nullable() }) },
      },
    },
    notBuilt,
  )

  app.get(
    '/assistant/conversations/:id',
    {
      config: { access: access.perm('set.assistant', 'cli.view') },
      schema: {
        tags: TAGS,
        operationId: 'getAssistantConversation',
        summary: 'One conversation, turn by turn, with what the guard and the policy check did ("This answer was wrong" opens a correction)',
        description: NOT_BUILT,
        params: IdParams,
        response: { 200: z.object({ conversation: ReviewConversationDto, turns: z.array(ReviewTurnDto) }) },
      },
    },
    notBuilt,
  )
}
