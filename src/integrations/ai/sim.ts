// SimAiProvider (ADR 0160): a deterministic stand-in for the model. It replays scripted steps in order (or asks a responder
// function), records every request it was given, and never touches the network, so the assistant's loop, tools, guards and
// fallbacks can be tested exactly. AI_PROVIDER=sim (the default) builds one with the default responder.
import {
  AiProviderError,
  type AiCallOptions,
  type AiContentBlock,
  type AiConverseRequest,
  type AiConverseResponse,
  type AiErrorKind,
  type AiProvider,
  type AiStopReason,
  type AiUsage,
} from '../ports/ai.js'

/** One scripted answer: the blocks the model "returns", or an error it "throws". */
export type SimStep =
  | {
      content: AiContentBlock[]
      /** Default: tool_use when the content has a toolUse block, else end_turn. */
      stopReason?: AiStopReason
      rawStopReason?: string
      usage?: Partial<AiUsage>
      /** Reported latency; also waited for (abortable) when `delayMs` is set. */
      latencyMs?: number
      delayMs?: number
    }
  | { error: AiErrorKind; message?: string; delayMs?: number }

export type SimResponder = (req: AiConverseRequest, index: number) => SimStep

export interface SimAiOptions {
  model?: string
}

/** A text answer step. */
export const simText = (text: string, extra: Omit<Extract<SimStep, { content: unknown }>, 'content'> = {}): SimStep => ({
  content: [{ type: 'text', text }],
  ...extra,
})

/** A tool call step. */
export const simToolUse = (name: string, input: Record<string, unknown>, id = `tool-${name}`): SimStep => ({
  content: [{ type: 'toolUse', id, name, input: input as never }],
})

/** What AI_PROVIDER=sim answers when nobody scripted it: a fixed, honest line. */
export const DEFAULT_SIM_REPLY = 'Thanks for your message! This is the Oasis Auto Spa assistant in test mode.'
/**
 * The first words of a policy judge's system prompt (the assistant's output guard v4, src/modules/assistant/judge.ts). The default
 * simulator answers such a request with a passing JSON verdict, so AI_PROVIDER=sim runs the whole guard without judging anything.
 */
export const POLICY_JUDGE_HEADER = 'OUTPUT POLICY JUDGE'
export const DEFAULT_SIM_VERDICT = '{"ok":true,"category":"none","reason":""}'
export const defaultSimResponder: SimResponder = (req) =>
  simText(req.system[0]?.text.startsWith(POLICY_JUDGE_HEADER) ? DEFAULT_SIM_VERDICT : DEFAULT_SIM_REPLY)

const clone = <T>(v: T): T => structuredClone(v)

function abortError(): AiProviderError {
  return new AiProviderError('aborted', 'the model call was aborted')
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError())
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export class SimAiProvider implements AiProvider {
  readonly name = 'sim' as const
  readonly model: string
  /** Every request, deep-copied, in call order. */
  readonly requests: AiConverseRequest[] = []
  private readonly steps: SimStep[] | null
  private readonly responder: SimResponder | null
  private calls = 0

  constructor(script: SimStep[] | SimResponder = defaultSimResponder, o: SimAiOptions = {}) {
    this.steps = Array.isArray(script) ? clone(script) : null
    this.responder = Array.isArray(script) ? null : script
    this.model = o.model ?? 'sim'
  }

  /** Scripted steps not used yet (0 for a responder). */
  get remaining(): number {
    return this.steps ? Math.max(0, this.steps.length - this.calls) : 0
  }

  async converse(req: AiConverseRequest, opts: AiCallOptions = {}): Promise<AiConverseResponse> {
    if (opts.signal?.aborted) throw abortError()
    const index = this.calls++
    this.requests.push(clone(req))
    const step = this.steps ? this.steps[index] : this.responder!(clone(req), index)
    if (!step) throw new AiProviderError('invalid_request', `sim script exhausted after ${this.steps?.length ?? 0} call(s)`)
    if (step.delayMs) await wait(step.delayMs, opts.signal)
    if ('error' in step) throw new AiProviderError(step.error, step.message ?? `sim ${step.error}`)
    const content = clone(step.content)
    const stopReason: AiStopReason = step.stopReason ?? (content.some((b) => b.type === 'toolUse') ? 'tool_use' : 'end_turn')
    return {
      message: { role: 'assistant', content },
      stopReason,
      rawStopReason: step.rawStopReason ?? stopReason,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, ...step.usage },
      model: this.model,
      latencyMs: step.latencyMs ?? step.delayMs ?? 0,
    }
  }
}
