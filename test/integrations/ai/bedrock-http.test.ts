// BedrockProvider over real HTTP (scripts/verify-live/sim-bedrock.ts): the real AWS SDK serialises the Converse request, signs it,
// retries and parses the errors, so this proves what goes on the wire: the same bytes for the same request (prompt caching), the
// reasoning blocks back exactly as they came, one attempt for every error (no SDK retry: the turn retries once itself, W4a F3).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BedrockProvider, createBedrockClient } from '../../../src/integrations/ai/index.js'
import type { AiConverseRequest } from '../../../src/integrations/ports/ai.js'
import { BedrockSim } from '../../../scripts/verify-live/sim-bedrock.js'

const MODEL = 'us.anthropic.claude-sonnet-5-5'
let sim: BedrockSim
let endpoint: string
let client: ReturnType<typeof createBedrockClient>

beforeEach(async () => {
  sim = new BedrockSim()
  endpoint = await sim.start()
  client = createBedrockClient({
    region: 'us-east-1',
    endpoint,
    credentials: { accessKeyId: 'AKIDSIMULATOR', secretAccessKey: 'sim-secret' },
  })
})
afterEach(async () => {
  client.destroy()
  await sim.stop()
})

const provider = (timeoutMs = 10_000) =>
  new BedrockProvider({ client, modelId: MODEL, timeoutMs, effortMode: 'off' })

const request = (over: Partial<AiConverseRequest> = {}): AiConverseRequest => ({
  system: [{ text: 'Static rules, FAQ and catalog digest.', cache: true }, { text: 'Turn context.' }],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Are you open Sunday?' }] }],
  tools: [
    {
      name: 'get_business_info',
      description: 'Hours',
      inputSchema: {
        type: 'object',
        properties: { topic: { type: 'string' } },
        required: ['topic'],
        additionalProperties: false,
      },
    },
  ],
  cacheTools: true,
  toolChoice: 'auto',
  maxTokens: 800,
  ...over,
})

describe('on the wire', () => {
  it('POSTs the inference profile id, the exact JSON body, the same bytes every time', async () => {
    const p = provider()
    const r = await p.converse(request())
    expect(r).toMatchObject({
      stopReason: 'end_turn',
      model: MODEL,
      usage: { inputTokens: 12, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    })
    await p.converse(request())
    expect(sim.requests).toHaveLength(2)
    expect(sim.requests[0]!.modelId).toBe(MODEL)
    expect(sim.requests[1]!.body.equals(sim.requests[0]!.body)).toBe(true)
    expect(sim.requests[0]!.json).toEqual({
      messages: [{ role: 'user', content: [{ text: 'Are you open Sunday?' }] }],
      system: [
        { text: 'Static rules, FAQ and catalog digest.' },
        { cachePoint: { type: 'default' } },
        { text: 'Turn context.' },
      ],
      inferenceConfig: { maxTokens: 800 },
      toolConfig: {
        tools: [
          {
            toolSpec: {
              name: 'get_business_info',
              description: 'Hours',
              inputSchema: {
                json: {
                  type: 'object',
                  properties: { topic: { type: 'string' } },
                  required: ['topic'],
                  additionalProperties: false,
                },
              },
            },
          },
          { cachePoint: { type: 'default' } },
        ],
        toolChoice: { auto: {} },
      },
    })
  })

  it('reasoning blocks come back exactly as Bedrock sent them (signature and redacted bytes)', async () => {
    const redacted = Buffer.from([0, 1, 2, 200, 255]).toString('base64')
    sim.opts.content = [
      { reasoningContent: { reasoningText: { text: '', signature: 'EqQBCkYIBxgCKkBsig==' } } },
      { reasoningContent: { redactedContent: redacted } },
      { toolUse: { toolUseId: 'tooluse_1', name: 'get_business_info', input: { topic: 'hours' } } },
    ]
    const p = provider()
    const first = await p.converse(request())
    expect(first.message.content).toEqual([
      { type: 'reasoning', text: '', signature: 'EqQBCkYIBxgCKkBsig==' },
      { type: 'reasoning', text: '', redacted },
      { type: 'toolUse', id: 'tooluse_1', name: 'get_business_info', input: { topic: 'hours' } },
    ])
    sim.opts.content = [{ text: 'We are closed on Sundays.' }]
    await p.converse(
      request({
        messages: [
          ...request().messages,
          first.message,
          {
            role: 'user',
            content: [
              {
                type: 'toolResult',
                toolUseId: 'tooluse_1',
                status: 'success',
                content: [{ type: 'json', json: { sunday: 'closed' } }],
              },
            ],
          },
        ],
      }),
    )
    const sent = sim.requests[1]!.json as { messages: Array<{ role: string; content: unknown[] }> }
    expect(sent.messages[1]).toEqual({
      role: 'assistant',
      content: [
        { reasoningContent: { reasoningText: { text: '', signature: 'EqQBCkYIBxgCKkBsig==' } } },
        { reasoningContent: { redactedContent: redacted } },
        { toolUse: { toolUseId: 'tooluse_1', name: 'get_business_info', input: { topic: 'hours' } } },
      ],
    })
    expect(sent.messages[2]).toEqual({
      role: 'user',
      content: [
        {
          toolResult: {
            toolUseId: 'tooluse_1',
            content: [{ json: { sunday: 'closed' } }],
            status: 'success',
          },
        },
      ],
    })
    // the earlier messages are the same bytes at the start of the longer body's message list
    const firstMessages = JSON.stringify((sim.requests[0]!.json as { messages: unknown[] }).messages).slice(
      0,
      -1,
    )
    expect(JSON.stringify(sent.messages).startsWith(firstMessages)).toBe(true)
  })

  it('a refusal is the stop reason refused with no text', async () => {
    sim.opts.scenario = 'refusal'
    const r = await provider().converse(request())
    expect(r).toMatchObject({ stopReason: 'refused', rawStopReason: 'refusal', message: { content: [] } })
  })

  it('no SDK retry (one attempt; the turn retries throttling, timeouts and outages once itself, W4a F3)', async () => {
    for (const [scenario, kind, attempts] of [
      ['throttled', 'throttled', 1],
      ['unavailable', 'unavailable', 1],
      ['access_denied', 'access_denied', 1],
      ['model_access', 'access_denied', 1],
      ['invalid_model', 'invalid_request', 1],
    ] as const) {
      sim.requests.length = 0
      sim.opts.scenario = scenario
      const e = await provider()
        .converse(request())
        .catch((x: unknown) => x)
      expect(e, scenario).toMatchObject({ name: 'AiProviderError', kind })
      expect(sim.requests, scenario).toHaveLength(attempts)
    }
  })

  it("the account's quota of 0 is fatal and says quota, although AWS sends it as throttling", async () => {
    sim.opts.scenario = 'quota'
    const e = await provider()
      .converse(request())
      .catch((x: unknown) => x)
    expect(e).toMatchObject({ kind: 'access_denied', retryable: false })
    expect((e as Error).message).toMatch(
      /quota: the model is not available for this account \(ThrottlingException 429: /,
    )
  })
})
