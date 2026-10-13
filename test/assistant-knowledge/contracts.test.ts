// Settings → Oasis AI's routes (ADR 0174 §6): every route declares exactly the permission the design gives it (set.assistant; the
// review of real conversations set.assistant + cli.view), the practice, correction and review contracts answer 501 NOT_BUILT to a
// permitted caller (their schemas are fixed for the dashboard; the next wave builds them), and everything new is off by default.
import { describe, expect, it } from 'vitest'
import { describeAccess } from '../../src/http/access.js'
import { loadEnv } from '../../src/config/env.js'
import { json } from '../settings-http/harness.js'
import { useKnowledgeHarness } from './harness.js'

const h = useKnowledgeHarness()
const NIL = '00000000-0000-7000-8000-000000000000'

const EXPECTED: [string, string, string, 'required' | undefined][] = [
  ['GET', '/api/v1/assistant/knowledge', 'set.assistant', undefined],
  ['POST', '/api/v1/assistant/knowledge', 'set.assistant', undefined],
  ['PUT', '/api/v1/assistant/knowledge/:id', 'set.assistant', undefined],
  ['DELETE', '/api/v1/assistant/knowledge/:id', 'set.assistant', undefined],
  ['POST', '/api/v1/assistant/knowledge/documents/presign', 'set.assistant', undefined],
  ['POST', '/api/v1/assistant/knowledge/documents/:id/complete', 'set.assistant', undefined],
  ['POST', '/api/v1/assistant/knowledge/documents/:id/extract', 'set.assistant', undefined],
  ['DELETE', '/api/v1/assistant/knowledge/documents/:id', 'set.assistant', undefined],
  ['GET', '/api/v1/assistant/knowledge/documents/:id/file', 'set.assistant', undefined],
  ['POST', '/api/v1/assistant/practice/sessions', 'set.assistant', undefined],
  ['GET', '/api/v1/assistant/practice/sessions', 'set.assistant', undefined],
  ['GET', '/api/v1/assistant/practice/sessions/:id', 'set.assistant', undefined],
  ['DELETE', '/api/v1/assistant/practice/sessions/:id', 'set.assistant', undefined],
  ['POST', '/api/v1/assistant/practice/sessions/:id/turns', 'set.assistant', 'required'],
  ['POST', '/api/v1/assistant/practice/turns/:id/rerun', 'set.assistant', undefined],
  ['POST', '/api/v1/assistant/corrections', 'set.assistant', undefined],
  ['GET', '/api/v1/assistant/conversations', 'set.assistant + cli.view', undefined],
  ['GET', '/api/v1/assistant/conversations/:id', 'set.assistant + cli.view', undefined],
]

describe('the routes of Settings → Oasis AI (ADR 0174 §6)', () => {
  it('declare exactly the design’s access and idempotency', () => {
    const routes = [...h.t.app.routeRegistry].filter((r) => r.url.startsWith('/api/v1/assistant/'))
    expect(routes.map((r) => [r.method, r.url, describeAccess(r.access), r.idempotency]).sort()).toEqual([...EXPECTED].sort())
  })

  it('the contracts answer 501 NOT_BUILT to a permitted caller, 403 without the permission', async () => {
    const s = await h.admin()
    const calls: [string, string, unknown?, Record<string, string>?][] = [
      ['POST', 'assistant/practice/sessions', { persona: 'new_texter' }],
      ['GET', 'assistant/practice/sessions'],
      ['GET', `assistant/practice/sessions/${NIL}`],
      ['DELETE', `assistant/practice/sessions/${NIL}`],
      ['POST', `assistant/practice/sessions/${NIL}/turns`, { text: 'Do you have a lounge?' }, { 'idempotency-key': 'practice-key-0001' }],
      ['POST', `assistant/practice/turns/${NIL}/rerun`, {}],
      ['POST', 'assistant/corrections', { clientText: 'Lounge?', rightAnswer: 'Yes, with wifi.', source: 'practice' }],
      ['GET', 'assistant/conversations'],
      ['GET', `assistant/conversations/${NIL}`],
    ]
    for (const [method, url, body, headers] of calls) {
      const r = await h.call(method as 'GET', url, { session: s, ...(body !== undefined ? { body } : {}), ...(headers ? { headers } : {}) })
      expect(r.statusCode, `${method} ${url}: ${r.body}`).toBe(501)
      expect(json(r).code).toBe('NOT_BUILT')
    }
    // a practice text needs its Idempotency-Key
    expect((await h.call('POST', `assistant/practice/sessions/${NIL}/turns`, { session: s, body: { text: 'Hi' } })).statusCode).toBe(400)
    // review needs cli.view on top of set.assistant
    const noClients = await h.withPermissions(['set.assistant'])
    expect((await h.call('GET', 'assistant/conversations', { session: noClients })).statusCode).toBe(403)
    expect((await h.call('GET', 'assistant/practice/sessions', { session: await h.withPermissions(['cli.view', 'set.hours']) })).statusCode).toBe(403)
  })

  it('everything new is off by default: practice off with a $3 budget, knowledge capped at 20,000 characters', () => {
    const env = loadEnv({ DATABASE_URL: 'postgres://x@localhost/x', NODE_ENV: 'test' })
    expect(env).toMatchObject({ AI_ENABLED: false, AI_PRACTICE_ENABLED: false, AI_PRACTICE_DAILY_BUDGET_USD: 3, AI_KNOWLEDGE_MAX_CHARS: 20_000 })
  })
})
