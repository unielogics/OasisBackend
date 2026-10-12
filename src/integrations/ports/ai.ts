// The AI model port (ADR 0160): one Converse-style call, provider-neutral. The assistant (wave 3) builds a request from system
// blocks, the conversation and its tools, and loops on toolUse/toolResult itself; the provider only maps these shapes to its API
// (Amazon Bedrock Converse in wave 2) or replays a script (SimAiProvider). Nothing here knows about texts, clients or prices.

export type AiJson = null | boolean | number | string | AiJson[] | { [key: string]: AiJson }
export type AiJsonObject = { [key: string]: AiJson }

export type AiRole = 'user' | 'assistant'

/** The content of a tool result: text, or a JSON value the model reads. */
export type AiToolResultContent = { type: 'text'; text: string } | { type: 'json'; json: AiJson }

export type AiContentBlock =
  | { type: 'text'; text: string }
  /** The model asks to run a tool; `id` pairs it with the toolResult that answers it. */
  | { type: 'toolUse'; id: string; name: string; input: AiJsonObject }
  | { type: 'toolResult'; toolUseId: string; content: AiToolResultContent[]; status: 'success' | 'error' }
  /**
   * The model's reasoning. It must be passed back unchanged (text, signature, redacted bytes) in the same conversation; the
   * transcript keeps it, the client never sees it.
   */
  | { type: 'reasoning'; text: string; signature?: string; redacted?: string }

export interface AiMessage {
  role: AiRole
  content: AiContentBlock[]
}

/** A system prompt block; `cache` puts a prompt-cache point after it (the static rules, FAQ and catalog digest). */
export interface AiSystemBlock {
  text: string
  cache?: boolean
}

export interface AiToolSpec {
  name: string
  description: string
  /** JSON Schema of the input (strict: additionalProperties false, every property required or nullable). */
  inputSchema: AiJsonObject
}

export interface AiConverseRequest {
  system: AiSystemBlock[]
  messages: AiMessage[]
  tools?: AiToolSpec[]
  /** Put a prompt-cache point after the tool definitions. */
  cacheTools?: boolean
  /** 'auto' lets the model choose; 'none' forbids tools (the final "reply now" call). Forcing a tool is not offered. */
  toolChoice?: 'auto' | 'none'
  maxTokens: number
  /** Sampling temperature, 0 to 1 (unset: the model's default). The output guard's judge uses 0. */
  temperature?: number
  /**
   * The model stops when it writes one of these (not blank; the sequence itself is not in the answer, stopReason 'stop_sequence').
   * The output guard's judge stops after its one-line JSON object.
   */
  stopSequences?: string[]
  effort?: 'low' | 'medium' | 'high'
}

/**
 * Why the model stopped. 'refused' is a safety decline, 'max_tokens' a cut answer, 'other' anything the provider reported that
 * this port does not know (rawStopReason has it): the assistant treats every one but end_turn and tool_use as a fallback.
 */
export type AiStopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'refused' | 'content_filtered' | 'other'

export interface AiUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export interface AiConverseResponse {
  /** The assistant's message (role 'assistant'), to append to the conversation as it is. */
  message: AiMessage
  stopReason: AiStopReason
  rawStopReason: string
  usage: AiUsage
  /** The model that answered (the provider's id). */
  model: string
  latencyMs: number
}

export interface AiCallOptions {
  /** Aborts the call (the per-call timeout and the turn deadline). */
  signal?: AbortSignal
}

export interface AiProvider {
  readonly name: 'sim' | 'bedrock'
  readonly model: string
  converse(req: AiConverseRequest, opts?: AiCallOptions): Promise<AiConverseResponse>
}

export type AiErrorKind =
  | 'timeout'
  | 'aborted'
  | 'throttled'
  | 'unavailable'
  | 'access_denied'
  | 'invalid_request'
  | 'unknown'

/** Every provider failure, by kind. `retryable`: throttling and transient unavailability. Messages never carry prompt text. */
export class AiProviderError extends Error {
  override name = 'AiProviderError'
  readonly retryable: boolean
  constructor(
    readonly kind: AiErrorKind,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.retryable = kind === 'throttled' || kind === 'unavailable'
  }
}

/** The text of a message's text blocks, joined (what the assistant would send). */
export function textOf(message: AiMessage): string {
  return message.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('')
}
