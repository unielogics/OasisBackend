// The AI provider port and its simulator (ADR 0160): scripted, deterministic answers in order, every request recorded, errors and
// aborts as AiProviderError, and the factory (building a provider contacts nothing).
import { describe, expect, it } from 'vitest'
import { createAiProvider, DEFAULT_SIM_REPLY, SimAiProvider, simText, simToolUse } from '../../src/integrations/ai/index.js'
import { AiProviderError, textOf, type AiConverseRequest } from '../../src/integrations/ports/ai.js'
import { loadEnv } from '../../src/config/env.js'

const req = (text: string): AiConverseRequest => ({
  system: [{ text: 'You are the Oasis Auto Spa assistant.', cache: true }],
  messages: [{ role: 'user', content: [{ type: 'text', text }] }],
  tools: [{ name: 'list_services', description: 'The catalog', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }],
  toolChoice: 'auto',
  maxTokens: 800,
  effort: 'low',
})

describe('SimAiProvider', () => {
  it('replays the script in order, with the tool-use stop reason inferred, usage and the model name', async () => {
    const sim = new SimAiProvider(
      [simToolUse('list_services', {}, 'tu-1'), simText('A Signature Wash is $45.', { usage: { inputTokens: 1200, outputTokens: 30, cacheReadTokens: 1000 } })],
      { model: 'sim-sonnet' },
    )
    const first = await sim.converse(req('How much is a wash?'))
    expect(first).toMatchObject({ stopReason: 'tool_use', rawStopReason: 'tool_use', model: 'sim-sonnet' })
    expect(first.message.content).toEqual([{ type: 'toolUse', id: 'tu-1', name: 'list_services', input: {} }])
    const second = await sim.converse(req('How much is a wash?'))
    expect(second.stopReason).toBe('end_turn')
    expect(textOf(second.message)).toBe('A Signature Wash is $45.')
    expect(second.usage).toEqual({ inputTokens: 1200, outputTokens: 30, cacheReadTokens: 1000, cacheWriteTokens: 0 })
    expect(sim.remaining).toBe(0)
    await expect(sim.converse(req('more'))).rejects.toMatchObject({ name: 'AiProviderError', kind: 'invalid_request' })
  })

  it('records deep copies of the requests it was given', async () => {
    const sim = new SimAiProvider([simText('ok')])
    const r = req('hi')
    await sim.converse(r)
    r.messages[0]!.content = []
    expect(sim.requests).toHaveLength(1)
    expect(sim.requests[0]!.messages[0]!.content).toEqual([{ type: 'text', text: 'hi' }])
  })

  it('throws scripted errors as AiProviderError, retryable only when transient', async () => {
    const sim = new SimAiProvider([{ error: 'throttled' }, { error: 'access_denied', message: 'no model agreement' }])
    const a = await sim.converse(req('x')).catch((e: unknown) => e)
    expect(a).toBeInstanceOf(AiProviderError)
    expect(a).toMatchObject({ kind: 'throttled', retryable: true })
    await expect(sim.converse(req('x'))).rejects.toMatchObject({ kind: 'access_denied', retryable: false, message: 'no model agreement' })
  })

  it('reports refusals and cut answers as their stop reasons', async () => {
    const sim = new SimAiProvider([simText('', { stopReason: 'refused', rawStopReason: 'refusal' }), simText('A long', { stopReason: 'max_tokens' })])
    expect(await sim.converse(req('x'))).toMatchObject({ stopReason: 'refused', rawStopReason: 'refusal' })
    expect((await sim.converse(req('x'))).stopReason).toBe('max_tokens')
  })

  it('honours the abort signal, before and during a slow answer', async () => {
    const sim = new SimAiProvider([simText('late', { delayMs: 5_000 }), simText('never')])
    const before = new AbortController()
    before.abort()
    await expect(sim.converse(req('x'), { signal: before.signal })).rejects.toMatchObject({ kind: 'aborted' })
    const during = new AbortController()
    const p = sim.converse(req('x'), { signal: during.signal })
    setTimeout(() => during.abort(), 10)
    await expect(p).rejects.toMatchObject({ kind: 'aborted' })
  })

  it('a responder function answers from the request', async () => {
    const sim = new SimAiProvider((r, i) => simText(`#${i} ${textOf(r.messages.at(-1)!)}`))
    expect(textOf((await sim.converse(req('ping'))).message)).toBe('#0 ping')
    expect(textOf((await sim.converse(req('pong'))).message)).toBe('#1 pong')
  })
})

describe('createAiProvider', () => {
  it('builds the simulator by default (no AWS), and the Bedrock provider for AI_PROVIDER=bedrock (test/integrations/ai)', async () => {
    const env = loadEnv({ DATABASE_URL: 'postgres://oasis:x@127.0.0.1:5432/oasis' })
    const ai = createAiProvider(env)
    expect(ai.name).toBe('sim')
    expect(textOf((await ai.converse(req('hello'))).message)).toBe(DEFAULT_SIM_REPLY)
    expect(createAiProvider({ ...env, AI_PROVIDER: 'bedrock' })).toMatchObject({ name: 'bedrock', model: 'us.anthropic.claude-sonnet-5-5' })
  })
})
