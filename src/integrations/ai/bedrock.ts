// BedrockProvider (ADR 0160, design section 9): the AiProvider port on Amazon Bedrock's Converse API, Claude Sonnet 5.5 through the
// cross-region inference profile us.anthropic.claude-sonnet-5-5, with the instance role's credentials.
//
// The mapping is pure and deterministic (toConverseInput / fromConverseOutput): the same port request always gives the same
// Converse input, key for key, so the prompt-cache prefix (tools -> system -> messages) stays byte-identical from one call to the
// next. Reasoning blocks (text + signature, or redacted bytes) come back as port blocks and go out again unchanged, because the
// model rejects or ignores an edited transcript. A refusal, a guardrail or an unknown stop reason is reported as its own stop
// reason (never as an answer); every failure is an AiProviderError whose kind says whether a retry can help. Error messages carry
// the AWS exception name and a masked, quote-free, truncated AWS message: never the prompt.
import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
  type ConverseCommandInput,
  type ConverseCommandOutput,
  type Message,
  type SystemContentBlock,
  type Tool,
  type ToolResultContentBlock,
} from '@aws-sdk/client-bedrock-runtime'
import { maskText } from '../../platform/logging.js'
import {
  AiProviderError,
  type AiCallOptions,
  type AiContentBlock,
  type AiConverseRequest,
  type AiConverseResponse,
  type AiErrorKind,
  type AiJson,
  type AiJsonObject,
  type AiMessage,
  type AiProvider,
  type AiStopReason,
  type AiToolResultContent,
} from '../ports/ai.js'

/** How the request's effort reaches Bedrock (AI_BEDROCK_EFFORT_MODE). */
export type BedrockEffortMode = 'off' | 'output_config' | 'additional_fields'

export interface BedrockProviderOptions {
  /** The Bedrock runtime client (tests inject a mock or a client pointed at a local stand-in). */
  client: Pick<BedrockRuntimeClient, 'send'>
  /** Inference profile or model id, e.g. us.anthropic.claude-sonnet-5-5. */
  modelId: string
  /** One call's limit (AI_TIMEOUT_MS); combined with the caller's signal (the turn deadline). */
  timeoutMs: number
  /** Default off: the effort is not sent at all. */
  effortMode?: BedrockEffortMode
  /** Used when a request names no effort (AI_EFFORT). */
  defaultEffort?: 'low' | 'medium' | 'high'
  /** Tool specs go out with strict: true (the default; the schemas must be strict-compatible). */
  strictTools?: boolean
  /** Monotonic milliseconds for the latency (tests); a duration, not a time of day, so not the Clock. */
  now?: () => number
}

/** Bedrock (like the Anthropic API) takes at most four cache points per request. */
export const MAX_CACHE_POINTS = 4

const CACHE_POINT = { type: 'default' } as const

const doc = (v: AiJson | AiJsonObject): never => v as never

function toolResultContent(c: AiToolResultContent): ToolResultContentBlock {
  return c.type === 'text' ? { text: c.text } : { json: doc(c.json) }
}

function contentBlock(b: AiContentBlock): ContentBlock {
  switch (b.type) {
    case 'text':
      return { text: b.text }
    case 'toolUse':
      return { toolUse: { toolUseId: b.id, name: b.name, input: doc(b.input) } }
    case 'toolResult':
      return {
        toolResult: { toolUseId: b.toolUseId, content: b.content.map(toolResultContent), status: b.status },
      }
    case 'reasoning':
      return b.redacted !== undefined
        ? { reasoningContent: { redactedContent: Uint8Array.from(Buffer.from(b.redacted, 'base64')) } }
        : {
            reasoningContent: {
              reasoningText:
                b.signature !== undefined ? { text: b.text, signature: b.signature } : { text: b.text },
            },
          }
  }
}

const usesTools = (messages: AiMessage[]): boolean =>
  messages.some((m) => m.content.some((b) => b.type === 'toolUse' || b.type === 'toolResult'))

/**
 * The Converse input for a port request. Pure: no clock, no randomness, fixed key order, so equal requests serialise to equal
 * bytes and a request that only appends messages keeps the earlier bytes as its prefix.
 *
 * toolChoice 'none' (the final "reply now" call): Converse has no "none". Without tool blocks in the conversation the tools are
 * left out entirely; with them Bedrock requires the tool configuration, so it goes out unchanged (auto) and the caller treats a
 * tool call on that answer as a fallback.
 */
export function toConverseInput(
  req: AiConverseRequest,
  o: Pick<BedrockProviderOptions, 'modelId' | 'effortMode' | 'defaultEffort' | 'strictTools'>,
): ConverseCommandInput {
  const system: SystemContentBlock[] = []
  for (const s of req.system) {
    system.push({ text: s.text })
    if (s.cache) system.push({ cachePoint: CACHE_POINT })
  }
  const messages: Message[] = req.messages.map((m) => ({
    role: m.role,
    content: m.content.map(contentBlock),
  }))
  const tools = req.tools ?? []
  const sendTools = tools.length > 0 && (req.toolChoice !== 'none' || usesTools(req.messages))
  let toolConfig: ConverseCommandInput['toolConfig']
  if (sendTools) {
    const list: Tool[] = tools.map((t) => ({
      toolSpec: {
        name: t.name,
        description: t.description,
        inputSchema: { json: doc(t.inputSchema) },
        ...(o.strictTools === false ? {} : { strict: true }),
      },
    }))
    if (req.cacheTools) list.push({ cachePoint: CACHE_POINT })
    toolConfig = { tools: list, toolChoice: { auto: {} } }
  } else if (usesTools(req.messages)) {
    throw new AiProviderError(
      'invalid_request',
      'the conversation has tool blocks but the request lists no tools (Bedrock needs them)',
    )
  }
  const points =
    system.filter((b) => 'cachePoint' in b && b.cachePoint).length + (sendTools && req.cacheTools ? 1 : 0)
  if (points > MAX_CACHE_POINTS)
    throw new AiProviderError(
      'invalid_request',
      `${points} cache points in one request (Bedrock takes at most ${MAX_CACHE_POINTS})`,
    )
  if (!Number.isInteger(req.maxTokens) || req.maxTokens < 1)
    throw new AiProviderError(
      'invalid_request',
      `maxTokens must be a positive integer (got ${req.maxTokens})`,
    )

  const effort = req.effort ?? o.defaultEffort
  const mode = o.effortMode ?? 'off'
  const input: ConverseCommandInput = {
    modelId: o.modelId,
    messages,
    ...(system.length ? { system } : {}),
    inferenceConfig: { maxTokens: req.maxTokens },
    ...(toolConfig ? { toolConfig } : {}),
  }
  if (effort && mode === 'output_config') input.outputConfig = { effort }
  if (effort && mode === 'additional_fields')
    input.additionalModelRequestFields = doc({ output_config: { effort } })
  return input
}

const STOP_REASONS: Record<string, AiStopReason> = {
  end_turn: 'end_turn',
  tool_use: 'tool_use',
  max_tokens: 'max_tokens',
  stop_sequence: 'stop_sequence',
  // Claude's safety decline: Converse passes the Anthropic stop reason through (it is not in the SDK's enum)
  refusal: 'refused',
  content_filtered: 'content_filtered',
  guardrail_intervened: 'content_filtered',
}

/** The port's stop reason for Bedrock's; anything else (malformed output, context window exceeded, a new value) is 'other'. */
export function mapStopReason(raw: string | undefined): AiStopReason {
  return (raw && STOP_REASONS[raw]) || 'other'
}

function fromContentBlock(b: ContentBlock): AiContentBlock {
  if (b.text !== undefined) return { type: 'text', text: b.text }
  if (b.toolUse) {
    const input = b.toolUse.input
    return {
      type: 'toolUse',
      id: b.toolUse.toolUseId ?? '',
      name: b.toolUse.name ?? '',
      input: (input && typeof input === 'object' && !Array.isArray(input) ? input : {}) as AiJsonObject,
    }
  }
  if (b.reasoningContent) {
    const r = b.reasoningContent
    if (r.reasoningText)
      return r.reasoningText.signature !== undefined
        ? { type: 'reasoning', text: r.reasoningText.text ?? '', signature: r.reasoningText.signature }
        : { type: 'reasoning', text: r.reasoningText.text ?? '' }
    if (r.redactedContent)
      return { type: 'reasoning', text: '', redacted: Buffer.from(r.redactedContent).toString('base64') }
  }
  const kind =
    Object.keys(b).find((k) => (b as unknown as Record<string, unknown>)[k] !== undefined) ?? 'empty'
  throw new AiProviderError(
    'unknown',
    `Bedrock returned a content block this provider does not carry (${kind})`,
  )
}

/** The port response for a Converse output (latency measured by the caller). */
export function fromConverseOutput(
  out: ConverseCommandOutput,
  model: string,
  latencyMs: number,
): AiConverseResponse {
  const msg = out.output?.message
  if (!msg) throw new AiProviderError('unknown', 'Bedrock answered without a message')
  const raw = out.stopReason ?? 'unknown'
  const u = out.usage
  return {
    message: { role: 'assistant', content: (msg.content ?? []).map(fromContentBlock) },
    stopReason: mapStopReason(raw),
    rawStopReason: raw,
    usage: {
      inputTokens: u?.inputTokens ?? 0,
      outputTokens: u?.outputTokens ?? 0,
      cacheReadTokens: u?.cacheReadInputTokens ?? 0,
      cacheWriteTokens: u?.cacheWriteInputTokens ?? 0,
    },
    model,
    latencyMs,
  }
}

// ---- errors -------------------------------------------------------------------------------------------------------------------

const THROTTLED = new Set([
  'ThrottlingException',
  'TooManyRequestsException',
  'ServiceQuotaExceededException',
])
const UNAVAILABLE = new Set([
  'InternalServerException',
  'ServiceUnavailableException',
  'ServiceUnavailable',
  'ModelNotReadyException',
  'ModelErrorException',
  'InternalFailure',
])
const DENIED = new Set([
  'AccessDeniedException',
  'UnrecognizedClientException',
  'InvalidSignatureException',
  'ExpiredTokenException',
  'ExpiredToken',
  'InvalidClientTokenId',
  'CredentialsProviderError',
])
const INVALID = new Set([
  'ValidationException',
  'ResourceNotFoundException',
  'ConflictException',
  'SerializationException',
])
const TIMEOUTS = new Set([
  'ModelTimeoutException',
  'TimeoutError',
  'RequestTimeout',
  'RequestTimeoutException',
])
const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'ENETUNREACH',
])

/**
 * The account has no quota for the model (Claude 5.5 tokens-per-minute 0 on a new account) or no access to it: retrying cannot
 * help, so these are fatal whatever exception carries them.
 */
export const QUOTA_RE = /not available for this account|quota (?:of|is) 0\b/i
export const MODEL_ACCESS_RE =
  /(?:don't|do not) have access to the model|model access|use case|agreement|marketplace|subscri/i

/** The AWS message, masked (addresses, numbers), quoted parts dropped (a validation message may echo input), 200 characters. */
export function safeAwsMessage(message: string | undefined): string {
  if (!message) return ''
  const unquoted = message
    .replace(/"[^"]*"|'[^'\n]*'|`[^`]*`/g, '"…"')
    .replace(/\s+/g, ' ')
    .trim()
  return maskText(unquoted).slice(0, 200)
}

export interface ErrorContext {
  /** The per-call timeout fired. */
  timedOut?: boolean
  /** The caller's signal fired (the turn deadline or a shutdown). */
  callerAborted?: boolean
}

/** An AiProviderError for anything the client threw. Throttling and 5xx are retryable; access, validation and quota are not. */
export function classifyBedrockError(err: unknown, ctx: ErrorContext = {}): AiProviderError {
  if (err instanceof AiProviderError) return err
  const e = (err ?? {}) as {
    name?: string
    message?: string
    code?: string
    $metadata?: { httpStatusCode?: number }
    $retryable?: unknown
  }
  const name = e.name ?? 'Error'
  const status = e.$metadata?.httpStatusCode
  const aws = safeAwsMessage(e.message)
  const say = (what: string): string =>
    `Bedrock Converse ${what} (${name}${status ? ` ${status}` : ''}${aws ? `: ${aws}` : ''})`
  const make = (kind: AiErrorKind, what: string): AiProviderError =>
    new AiProviderError(kind, say(what), { cause: err })

  if (ctx.timedOut)
    return new AiProviderError('timeout', 'Bedrock Converse did not answer within the per-call timeout', {
      cause: err,
    })
  if (ctx.callerAborted || name === 'AbortError')
    return new AiProviderError('aborted', 'the Bedrock call was aborted', { cause: err })
  if (QUOTA_RE.test(e.message ?? ''))
    return make('access_denied', 'refused: quota: the model is not available for this account')
  // the exception name first (ModelNotReadyException answers 429 but is an outage), then the HTTP status
  if (TIMEOUTS.has(name)) return make('timeout', 'timed out')
  if (UNAVAILABLE.has(name)) return make('unavailable', 'unavailable')
  if (THROTTLED.has(name)) return make('throttled', 'throttled')
  if (DENIED.has(name)) return make('access_denied', 'refused access')
  if (INVALID.has(name)) return make('invalid_request', 'rejected the request')
  if (status === 408) return make('timeout', 'timed out')
  if (status === 429) return make('throttled', 'throttled')
  if (status === 401 || status === 403) return make('access_denied', 'refused access')
  if (status === 400 || status === 404 || status === 422)
    return make('invalid_request', 'rejected the request')
  if ((status !== undefined && status >= 500) || status === 424 || NETWORK_CODES.has(e.code ?? ''))
    return make('unavailable', 'unavailable')
  if (e.$retryable) return make('unavailable', 'failed (retryable)')
  return make('unknown', 'failed')
}

// ---- the provider -------------------------------------------------------------------------------------------------------------

export class BedrockProvider implements AiProvider {
  readonly name = 'bedrock' as const
  readonly model: string
  private readonly now: () => number

  constructor(private readonly o: BedrockProviderOptions) {
    if (!o.modelId) throw new Error('BedrockProvider needs a model id (AI_BEDROCK_MODEL_ID)')
    if (!(o.timeoutMs > 0))
      throw new Error('BedrockProvider needs a positive per-call timeout (AI_TIMEOUT_MS)')
    this.model = o.modelId
    this.now = o.now ?? (() => performance.now())
  }

  /** The exact Converse input this request becomes (for logs of the request shape and the cache tests). */
  input(req: AiConverseRequest): ConverseCommandInput {
    return toConverseInput(req, this.o)
  }

  async converse(req: AiConverseRequest, opts: AiCallOptions = {}): Promise<AiConverseResponse> {
    if (opts.signal?.aborted)
      throw new AiProviderError('aborted', 'the Bedrock call was aborted before it started')
    const input = this.input(req)
    const timeout = AbortSignal.timeout(this.o.timeoutMs)
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout
    const started = this.now()
    let out: ConverseCommandOutput
    try {
      out = await this.o.client.send(new ConverseCommand(input), { abortSignal: signal })
    } catch (err) {
      throw classifyBedrockError(err, {
        timedOut: timeout.aborted && !opts.signal?.aborted,
        callerAborted: !!opts.signal?.aborted,
      })
    }
    return fromConverseOutput(out, this.model, Math.max(0, Math.round(this.now() - started)))
  }
}

export interface BedrockClientConfig {
  region: string
  /** Simulator or VPC endpoint; unset for AWS. */
  endpoint?: string
  credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string }
}

/** The runtime client the app uses: the default credential chain (the instance role), two attempts in all (one SDK retry). */
export function createBedrockClient(c: BedrockClientConfig): BedrockRuntimeClient {
  return new BedrockRuntimeClient({
    region: c.region,
    maxAttempts: 2,
    ...(c.endpoint ? { endpoint: c.endpoint } : {}),
    ...(c.credentials ? { credentials: c.credentials } : {}),
  })
}
