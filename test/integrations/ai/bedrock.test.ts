// BedrockProvider (ADR 0160, design section 9): the port request becomes exactly one deterministic Converse input (system blocks
// with cache points, messages, strict tools with auto choice, maxTokens, effort only when configured), the answer comes back with
// reasoning blocks unchanged, every stop reason has its own port value, every AWS failure has its kind, and usage prices to
// cost_micros. The client is the real SDK class behind aws-sdk-client-mock; nothing reaches AWS.
import {
  AccessDeniedException,
  BedrockRuntimeClient,
  ConverseCommand,
  InternalServerException,
  ModelErrorException,
  ModelNotReadyException,
  ModelTimeoutException,
  ResourceNotFoundException,
  ServiceQuotaExceededException,
  ServiceUnavailableException,
  ThrottlingException,
  ValidationException,
  type ConverseCommandOutput,
} from '@aws-sdk/client-bedrock-runtime'
import { mockClient } from 'aws-sdk-client-mock'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import {
  BedrockProvider,
  classifyBedrockError,
  createAiProvider,
  createBedrockClient,
  fromConverseOutput,
  mapStopReason,
  safeAwsMessage,
  toConverseInput,
  CLAUDE_BEDROCK_MODELS,
  INTERIM_ASSISTANT_MODEL,
  TARGET_ASSISTANT_MODEL,
} from '../../../src/integrations/ai/index.js'
import {
  AiProviderError,
  textOf,
  type AiConverseRequest,
  type AiMessage,
} from '../../../src/integrations/ports/ai.js'
import { loadEnv } from '../../../src/config/env.js'
import { createLogger } from '../../../src/platform/logging.js'

const MODEL = 'us.anthropic.claude-sonnet-5-5'
// mockClient stubs the class prototype for every instance: restore it, or later test files in the same fork get the stub
const mock = mockClient(BedrockRuntimeClient)
afterEach(() => mock.reset())
afterAll(() => mock.restore())

const SCHEMA = {
  type: 'object',
  properties: { category: { type: ['string', 'null'], enum: ['wash', 'tint', null] } },
  required: ['category'],
  additionalProperties: false,
}

const request = (over: Partial<AiConverseRequest> = {}): AiConverseRequest => ({
  system: [
    { text: 'You are the Oasis Auto Spa assistant. Rules...', cache: true },
    { text: 'Today: Saturday. The client: Maria (trusted).' },
  ],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'How much is a wash?' }] }],
  tools: [
    { name: 'list_services', description: 'The catalog from Settings', inputSchema: SCHEMA },
    {
      name: 'handoff_to_staff',
      description: 'Hand the thread to a person',
      inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    },
  ],
  cacheTools: true,
  toolChoice: 'auto',
  maxTokens: 800,
  ...over,
})

const answer = (over: Partial<ConverseCommandOutput> = {}): ConverseCommandOutput => ({
  $metadata: {},
  output: { message: { role: 'assistant', content: [{ text: 'A Signature Wash is $45.' }] } },
  stopReason: 'end_turn',
  usage: {
    inputTokens: 40,
    outputTokens: 12,
    totalTokens: 1252,
    cacheReadInputTokens: 1200,
    cacheWriteInputTokens: 0,
  },
  metrics: { latencyMs: 900 },
  ...over,
})

const provider = (o: Partial<ConstructorParameters<typeof BedrockProvider>[0]> = {}) =>
  new BedrockProvider({
    client: new BedrockRuntimeClient({ region: 'us-east-1' }),
    modelId: MODEL,
    timeoutMs: 20_000,
    ...o,
  })

describe('request mapping', () => {
  it('maps system blocks with cache points, messages, tools (not strict) with a cache point and auto choice, and maxTokens', () => {
    expect(toConverseInput(request(), { modelId: MODEL })).toEqual({
      modelId: MODEL,
      messages: [{ role: 'user', content: [{ text: 'How much is a wash?' }] }],
      system: [
        { text: 'You are the Oasis Auto Spa assistant. Rules...' },
        { cachePoint: { type: 'default' } },
        { text: 'Today: Saturday. The client: Maria (trusted).' },
      ],
      inferenceConfig: { maxTokens: 800 },
      toolConfig: {
        tools: [
          {
            toolSpec: {
              name: 'list_services',
              description: 'The catalog from Settings',
              inputSchema: { json: SCHEMA },
            },
          },
          {
            toolSpec: {
              name: 'handoff_to_staff',
              description: 'Hand the thread to a person',
              inputSchema: {
                json: { type: 'object', properties: {}, required: [], additionalProperties: false },
              },
            },
          },
          { cachePoint: { type: 'default' } },
        ],
        toolChoice: { auto: {} },
      },
    })
  })

  it('is byte-stable: equal requests serialise to equal bytes, and appending messages keeps the earlier bytes as the prefix', () => {
    const a = JSON.stringify(toConverseInput(request(), { modelId: MODEL }))
    const b = JSON.stringify(toConverseInput(structuredClone(request()), { modelId: MODEL }))
    expect(b).toBe(a)
    // the next round of the same turn: the cached part (tools + system) is the same bytes, the messages only grow
    const round1 = toConverseInput(request(), { modelId: MODEL })
    const round2 = toConverseInput(
      request({
        messages: [
          ...request().messages,
          {
            role: 'assistant',
            content: [
              { type: 'reasoning', text: '', signature: 'sig-1' },
              { type: 'toolUse', id: 'tu-1', name: 'list_services', input: { category: 'wash' } },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'toolResult',
                toolUseId: 'tu-1',
                status: 'success',
                content: [{ type: 'json', json: { services: [{ name: 'Signature Wash', price: '$45' }] } }],
              },
            ],
          },
        ],
      }),
      { modelId: MODEL },
    )
    expect(JSON.stringify(round2.toolConfig)).toBe(JSON.stringify(round1.toolConfig))
    expect(JSON.stringify(round2.system)).toBe(JSON.stringify(round1.system))
    expect(JSON.stringify(round2.messages).startsWith(JSON.stringify(round1.messages).slice(0, -1))).toBe(
      true,
    )
    // the mapping keeps no state between calls (a provider instance maps the same way every time)
    const p = provider()
    expect(JSON.stringify(p.input(request()))).toBe(a)
    expect(JSON.stringify(p.input(request()))).toBe(a)
  })

  it('maps tool use, tool results (text and json, success and error) and reasoning blocks', () => {
    const messages: AiMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'Book me Saturday' }] },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'They want Saturday.', signature: 'c2lnLTE=' },
          { type: 'reasoning', text: '', redacted: Buffer.from([1, 2, 3, 250]).toString('base64') },
          { type: 'text', text: 'Let me check.' },
          {
            type: 'toolUse',
            id: 'tu-9',
            name: 'check_availability',
            input: { serviceKey: 'signature', date: '2026-10-17', partOfDay: null },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'toolResult',
            toolUseId: 'tu-9',
            status: 'error',
            content: [{ type: 'text', text: 'needs_verification' }],
          },
        ],
      },
    ]
    const input = toConverseInput(request({ messages }), { modelId: MODEL })
    expect(input.messages).toEqual([
      { role: 'user', content: [{ text: 'Book me Saturday' }] },
      {
        role: 'assistant',
        content: [
          { reasoningContent: { reasoningText: { text: 'They want Saturday.', signature: 'c2lnLTE=' } } },
          { reasoningContent: { redactedContent: Uint8Array.from([1, 2, 3, 250]) } },
          { text: 'Let me check.' },
          {
            toolUse: {
              toolUseId: 'tu-9',
              name: 'check_availability',
              input: { serviceKey: 'signature', date: '2026-10-17', partOfDay: null },
            },
          },
        ],
      },
      {
        role: 'user',
        content: [
          { toolResult: { toolUseId: 'tu-9', content: [{ text: 'needs_verification' }], status: 'error' } },
        ],
      },
    ])
  })

  it('sends the effort only when configured: off by default, Converse outputConfig, or the Anthropic field passed through', () => {
    expect(toConverseInput(request({ effort: 'low' }), { modelId: MODEL })).not.toHaveProperty('outputConfig')
    expect(toConverseInput(request({ effort: 'low' }), { modelId: MODEL })).not.toHaveProperty(
      'additionalModelRequestFields',
    )
    expect(
      toConverseInput(request({ effort: 'low' }), { modelId: MODEL, effortMode: 'output_config' })
        .outputConfig,
    ).toEqual({ effort: 'low' })
    expect(
      toConverseInput(request(), { modelId: MODEL, effortMode: 'additional_fields', defaultEffort: 'medium' })
        .additionalModelRequestFields,
    ).toEqual({
      output_config: { effort: 'medium' },
    })
    // a request's own effort wins over the default; no effort at all sends nothing
    expect(
      toConverseInput(request({ effort: 'high' }), {
        modelId: MODEL,
        effortMode: 'output_config',
        defaultEffort: 'low',
      }).outputConfig,
    ).toEqual({ effort: 'high' })
    expect(toConverseInput(request(), { modelId: MODEL, effortMode: 'output_config' })).not.toHaveProperty(
      'outputConfig',
    )
  })

  it('is the same request for every listed model (Sonnet/Opus 4.6 and 5.5): only modelId differs, no version-specific field', () => {
    const withReasoning = request({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Book me in' }] },
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'They want a slot.', signature: 'sig-1' },
            { type: 'toolUse', id: 'tu_1', name: 'list_services', input: { category: 'wash' } },
          ],
        },
        { role: 'user', content: [{ type: 'toolResult', toolUseId: 'tu_1', content: [{ type: 'json', json: { ok: true } }], status: 'success' }] },
      ],
      effort: 'low',
    })
    const shapes = CLAUDE_BEDROCK_MODELS.map((m) => {
      const input = toConverseInput(withReasoning, { modelId: m.profileId, defaultEffort: 'low' })
      expect(input.modelId).toBe(m.profileId)
      return JSON.stringify({ ...input, modelId: 'X' })
    })
    expect(new Set(shapes).size).toBe(1)
    // nothing a 4.6 model could reject: no thinking / reasoning config, no effort (AI_BEDROCK_EFFORT_MODE is off), no extra fields
    expect(Object.keys(JSON.parse(shapes[0]!) as object).sort()).toEqual(['inferenceConfig', 'messages', 'modelId', 'system', 'toolConfig'])
    expect(shapes[0]).not.toMatch(/thinking|reasoningConfig|budget_tokens|outputConfig|additionalModelRequestFields|between_tools/)
    expect(JSON.parse(shapes[0]!).inferenceConfig).toEqual({ maxTokens: 800 })
  })

  it('stop sequences go into inferenceConfig; a blank one is refused before the call (Bedrock refuses it)', () => {
    expect(toConverseInput(request({ stopSequences: ['}\n'] }), { modelId: MODEL }).inferenceConfig).toEqual({ maxTokens: 800, stopSequences: ['}\n'] })
    expect(toConverseInput(request({ stopSequences: [] }), { modelId: MODEL }).inferenceConfig).toEqual({ maxTokens: 800 })
    expect(() => toConverseInput(request({ stopSequences: ['\n'] }), { modelId: MODEL })).toThrow(/blank/)
  })

  it('toolChoice none: no tools without tool blocks; the tools stay (Bedrock requires them) once the conversation used one', () => {
    const plain = toConverseInput(request({ toolChoice: 'none' }), { modelId: MODEL })
    expect(plain).not.toHaveProperty('toolConfig')
    const used = toConverseInput(
      request({
        toolChoice: 'none',
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'hi' }] },
          {
            role: 'assistant',
            content: [{ type: 'toolUse', id: 't', name: 'list_services', input: { category: null } }],
          },
          {
            role: 'user',
            content: [
              {
                type: 'toolResult',
                toolUseId: 't',
                status: 'success',
                content: [{ type: 'json', json: [] }],
              },
            ],
          },
        ],
      }),
      { modelId: MODEL },
    )
    expect(used.toolConfig).toEqual(toConverseInput(request(), { modelId: MODEL }).toolConfig)
  })

  it('refuses requests Bedrock would reject, before sending', () => {
    expect(() => toConverseInput(request({ maxTokens: 0 }), { modelId: MODEL })).toThrow(AiProviderError)
    const five = Array.from({ length: 4 }, (_, i) => ({ text: `block ${i}`, cache: true }))
    expect(() => toConverseInput(request({ system: five, cacheTools: true }), { modelId: MODEL })).toThrow(
      /5 cache points/,
    )
    expect(() =>
      toConverseInput(request({ system: five, cacheTools: false }), { modelId: MODEL }),
    ).not.toThrow()
    expect(() =>
      toConverseInput(
        request({
          tools: [],
          messages: [{ role: 'assistant', content: [{ type: 'toolUse', id: 't', name: 'x', input: {} }] }],
        }),
        { modelId: MODEL },
      ),
    ).toThrow(/lists no tools/)
    // strict tool use only on request: Bedrock compiles strict tools into a grammar that for the assistant's fifteen tools exceeded
    // its 300 MB limit (every turn refused, W4 live eval) and refuses minimum/maximum; the tools' zod schemas validate on the server
    expect(toConverseInput(request(), { modelId: MODEL }).toolConfig!.tools![0]!.toolSpec).not.toHaveProperty('strict')
    expect(
      toConverseInput(request(), { modelId: MODEL, strictTools: false }).toolConfig!.tools![0]!.toolSpec,
    ).not.toHaveProperty('strict')
    expect(toConverseInput(request(), { modelId: MODEL, strictTools: true }).toolConfig!.tools![0]!.toolSpec).toMatchObject({ strict: true })
  })
})

describe('response mapping', () => {
  it('maps text, tool use, reasoning (signature and redacted) and usage; reasoning round-trips byte for byte', () => {
    const out = answer({
      output: {
        message: {
          role: 'assistant',
          content: [
            { reasoningContent: { reasoningText: { text: '', signature: 'EqQBCkYIBxgCKkB' } } },
            { reasoningContent: { redactedContent: Uint8Array.from([9, 8, 7, 0, 255]) } },
            { text: 'Checking.' },
            { toolUse: { toolUseId: 'tooluse_abc', name: 'list_services', input: { category: 'tint' } } },
          ],
        },
      },
      stopReason: 'tool_use',
    })
    const r = fromConverseOutput(out, MODEL, 1234)
    expect(r).toEqual({
      message: {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: '', signature: 'EqQBCkYIBxgCKkB' },
          { type: 'reasoning', text: '', redacted: Buffer.from([9, 8, 7, 0, 255]).toString('base64') },
          { type: 'text', text: 'Checking.' },
          { type: 'toolUse', id: 'tooluse_abc', name: 'list_services', input: { category: 'tint' } },
        ],
      },
      stopReason: 'tool_use',
      rawStopReason: 'tool_use',
      usage: { inputTokens: 40, outputTokens: 12, cacheReadTokens: 1200, cacheWriteTokens: 0 },
      model: MODEL,
      latencyMs: 1234,
    })
    // appended to the conversation as it is, the next request carries Bedrock's own blocks back unchanged
    const next = toConverseInput(request({ messages: [request().messages[0]!, r.message] }), {
      modelId: MODEL,
    })
    expect(next.messages![1]).toEqual(out.output!.message)
  })

  it('gives every stop reason its own port value; a refusal or anything unknown is never an ordinary answer', () => {
    expect(mapStopReason('end_turn')).toBe('end_turn')
    expect(mapStopReason('tool_use')).toBe('tool_use')
    expect(mapStopReason('max_tokens')).toBe('max_tokens')
    expect(mapStopReason('stop_sequence')).toBe('stop_sequence')
    expect(mapStopReason('refusal')).toBe('refused')
    expect(mapStopReason('content_filtered')).toBe('content_filtered')
    expect(mapStopReason('guardrail_intervened')).toBe('content_filtered')
    for (const raw of [
      'malformed_model_output',
      'malformed_tool_use',
      'model_context_window_exceeded',
      'pause_turn',
      'brand_new',
      undefined,
    ])
      expect(mapStopReason(raw), String(raw)).toBe('other')
    const refused = fromConverseOutput(
      answer({ stopReason: 'refusal' as never, output: { message: { role: 'assistant', content: [] } } }),
      MODEL,
      1,
    )
    expect(refused).toMatchObject({ stopReason: 'refused', rawStopReason: 'refusal' })
    expect(fromConverseOutput(answer({ stopReason: 'something_new' as never }), MODEL, 1)).toMatchObject({
      stopReason: 'other',
      rawStopReason: 'something_new',
    })
  })

  it('a missing message or a block the port cannot carry is an error, never a silently shortened transcript', () => {
    expect(() => fromConverseOutput(answer({ output: undefined }), MODEL, 1)).toThrow(/without a message/)
    expect(() =>
      fromConverseOutput(
        answer({
          output: {
            message: {
              role: 'assistant',
              content: [{ image: { format: 'png', source: { bytes: new Uint8Array(1) } } }],
            },
          },
        }),
        MODEL,
        1,
      ),
    ).toThrow(/does not carry \(image\)/)
  })
})

describe('the provider', () => {
  it('sends one ConverseCommand and answers with the mapped response', async () => {
    mock.on(ConverseCommand).resolves(answer())
    const r = await provider({ effortMode: 'output_config', defaultEffort: 'low' }).converse(request())
    expect(textOf(r.message)).toBe('A Signature Wash is $45.')
    expect(r).toMatchObject({ stopReason: 'end_turn', model: MODEL, usage: { cacheReadTokens: 1200 } })
    const calls = mock.commandCalls(ConverseCommand)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.args[0].input).toEqual(
      toConverseInput(request(), { modelId: MODEL, effortMode: 'output_config', defaultEffort: 'low' }),
    )
    expect(calls[0]!.args[0].input.outputConfig).toEqual({ effort: 'low' })
  })

  it('the per-call timeout aborts the request (timeout), the caller signal too (aborted)', async () => {
    let seen: AbortSignal | undefined
    const slow = {
      send: (_c: unknown, o?: { abortSignal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          seen = o?.abortSignal
          o?.abortSignal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('Request aborted'), { name: 'AbortError' })),
          )
        }),
    } as unknown as BedrockRuntimeClient
    const p = provider({ client: slow, timeoutMs: 30 })
    await expect(p.converse(request())).rejects.toMatchObject({ kind: 'timeout', retryable: false })
    expect(seen?.aborted).toBe(true)
    const caller = new AbortController()
    const call = provider({ client: slow, timeoutMs: 10_000 }).converse(request(), { signal: caller.signal })
    setTimeout(() => caller.abort(), 10)
    await expect(call).rejects.toMatchObject({ kind: 'aborted' })
    const before = new AbortController()
    before.abort()
    await expect(
      provider({ client: slow }).converse(request(), { signal: before.signal }),
    ).rejects.toMatchObject({ kind: 'aborted' })
  })

  it('classifies every AWS failure: throttling and 5xx retryable, access, validation and quota fatal', async () => {
    const meta = (s: number) => ({ $metadata: { httpStatusCode: s } })
    const cases: Array<[Error, string, boolean]> = [
      [
        new ThrottlingException({
          message: 'Too many requests, please wait before trying again.',
          ...meta(429),
        }),
        'throttled',
        true,
      ],
      [
        new ServiceQuotaExceededException({
          message: 'Your request exceeds the service quota',
          ...meta(429),
        }),
        'throttled',
        true,
      ],
      [new InternalServerException({ message: 'internal', ...meta(500) }), 'unavailable', true],
      [new ServiceUnavailableException({ message: 'unavailable', ...meta(503) }), 'unavailable', true],
      [new ModelNotReadyException({ message: 'not ready', ...meta(429) }), 'unavailable', true],
      [new ModelErrorException({ message: 'model error', ...meta(424) }), 'unavailable', true],
      [new ModelTimeoutException({ message: 'took too long', ...meta(408) }), 'timeout', false],
      [
        new AccessDeniedException({
          message: "You don't have access to the model with the specified model ID.",
          ...meta(403),
        }),
        'access_denied',
        false,
      ],
      [
        new ValidationException({ message: 'messages: roles must alternate', ...meta(400) }),
        'invalid_request',
        false,
      ],
      [new ResourceNotFoundException({ message: 'Model not found', ...meta(404) }), 'invalid_request', false],
      // the account's quota of 0 (Claude 5.5 TPM on this account): fatal whatever exception carries it
      [
        new ThrottlingException({ message: 'The model is not available for this account.', ...meta(429) }),
        'access_denied',
        false,
      ],
      [Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }), 'unavailable', true],
      [
        Object.assign(new Error('Could not load credentials from any providers'), {
          name: 'CredentialsProviderError',
        }),
        'access_denied',
        false,
      ],
      [new Error('something odd'), 'unknown', false],
    ]
    for (const [err, kind, retryable] of cases) {
      mock.reset()
      mock.on(ConverseCommand).rejects(err)
      const e = (await provider()
        .converse(request())
        .catch((x: unknown) => x)) as AiProviderError
      expect(e, `${err.name}: ${err.message}`).toBeInstanceOf(AiProviderError)
      expect({ kind: e.kind, retryable: e.retryable }, err.name).toEqual({ kind, retryable })
      // the cause keeps only safe metadata: never the SDK error itself (a logger appends the cause chain to the line)
      expect(e.cause).not.toBe(err)
      expect(e.cause).toBeInstanceOf(Error)
      expect((e.cause as Error).name).toBe(err.name)
      expect((e.cause as Error).message).toBe(safeAwsMessage(err.message))
      expect(Object.keys(e.cause as object).sort()).toEqual(
        ['code', 'httpStatusCode', 'requestId'].filter((k) => (e.cause as Record<string, unknown>)[k] !== undefined),
      )
    }
    const quota = classifyBedrockError(
      new ThrottlingException({
        message: 'The model is not available for this account.',
        $metadata: { httpStatusCode: 429 },
      }),
    )
    expect(quota.message).toMatch(/^Bedrock Converse refused: quota: /)
  })

  it('error messages carry the exception name and a masked, quote-free AWS message, never the prompt', async () => {
    const prompt = 'My number is +12015550142 and my card is 4111 1111 1111 1111'
    mock
      .on(ConverseCommand)
      .rejects(
        new ValidationException({
          message: `messages.0.content.0.text: "${prompt}" is too long; contact jane@example.com`,
          $metadata: { httpStatusCode: 400 },
        }),
      )
    const e = (await provider()
      .converse(request({ messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }] }))
      .catch((x: unknown) => x)) as AiProviderError
    expect(e.message).toMatch(
      /^Bedrock Converse rejected the request \(ValidationException 400: messages\.0\.content\.0\.text: "…" is too long; contact j\*\*\*@example\.com\)$/,
    )
    expect(e.message).not.toContain('4111')
    expect(e.message).not.toContain('5550142')
    expect(safeAwsMessage('x'.repeat(500))).toHaveLength(200)
    expect(safeAwsMessage(undefined)).toBe('')
  })

  it('a logged provider error carries no prompt text: neither its message nor its cause chain echoes the AWS message raw', async () => {
    const prompt = 'Hello I am Maria and my address is Elm Street'
    const awsText = `Malformed input request: '${prompt}' contains ${prompt} ${'and more '.repeat(40)}TAIL_BEYOND_200`
    const raw = new ValidationException({
      message: awsText,
      $metadata: { httpStatusCode: 400, requestId: 'req-123' },
    })
    mock.on(ConverseCommand).rejects(raw)
    const e = (await provider()
      .converse(request())
      .catch((x: unknown) => x)) as AiProviderError
    expect(e.cause).toMatchObject({
      name: 'ValidationException',
      httpStatusCode: 400,
      requestId: 'req-123',
    })
    expect((e.cause as Error).message).toBe(safeAwsMessage(awsText))
    expect((e.cause as Error).stack ?? '').not.toContain(`'${prompt}'`)
    expect((e.cause as Error).stack ?? '').not.toContain('TAIL_BEYOND_200')
    // the app's logger appends the cause chain to err.message and err.stack: nothing beyond the safe text may reach the line
    const lines: string[] = []
    const log = createLogger({ level: 'info' }, { write: (l: string) => void lines.push(l) })
    log.error({ err: e }, 'assistant turn failed')
    const line = lines.join('')
    expect(line).toContain('caused by: ValidationException: Malformed input request: \\"…\\" contains')
    expect(line).not.toContain(`'${prompt}'`)
    expect(line).not.toContain('TAIL_BEYOND_200')
    // the timeout and abort paths keep no raw cause either
    const t = classifyBedrockError(Object.assign(new Error(`aborted while sending ${prompt}`), { name: 'AbortError' }), {
      timedOut: true,
    })
    expect(t.kind).toBe('timeout')
    expect((t.cause as Error).message).not.toContain('Maria')
    const a = classifyBedrockError(Object.assign(new Error(`aborted '${prompt}'`), { name: 'AbortError' }))
    expect(a.kind).toBe('aborted')
    expect((a.cause as Error).message).not.toContain('Maria')
  })

  it('the factory builds the Bedrock provider for AI_PROVIDER=bedrock with the env settings, without contacting AWS', async () => {
    const env = loadEnv({
      DATABASE_URL: 'postgres://oasis:x@127.0.0.1:5432/oasis',
      AI_PROVIDER: 'bedrock',
      AI_TIMEOUT_MS: '5000',
      AI_BEDROCK_EFFORT_MODE: 'output_config',
    })
    expect(env.AI_BEDROCK_EFFORT_MODE).toBe('output_config')
    expect(loadEnv({ DATABASE_URL: 'postgres://oasis:x@127.0.0.1:5432/oasis' }).AI_BEDROCK_EFFORT_MODE).toBe(
      'off',
    )
    const ai = createAiProvider(env)
    expect(ai).toBeInstanceOf(BedrockProvider)
    // the interim model by default (owner 2026-10-11); Sonnet 5.5 is the one setting AI_BEDROCK_MODEL_ID
    expect(ai).toMatchObject({ name: 'bedrock', model: INTERIM_ASSISTANT_MODEL })
    expect(createAiProvider({ ...env, AI_BEDROCK_MODEL_ID: TARGET_ASSISTANT_MODEL })).toMatchObject({ model: 'us.anthropic.claude-sonnet-5-5' })
    mock.on(ConverseCommand).resolves(answer())
    await ai.converse(request())
    expect(mock.commandCalls(ConverseCommand)[0]!.args[0].input.outputConfig).toEqual({ effort: 'low' })
    const client = createBedrockClient({ region: 'us-east-2' })
    expect(await client.config.maxAttempts()).toBe(2)
    expect(await client.config.region()).toBe('us-east-2')
    client.destroy()
  })
})
