// An in-process Bedrock runtime stand-in for `pnpm verify:ai --sim` and the provider's HTTP tests: POST /model/{modelId}/converse
// answered over real HTTP/2 (cleartext; the SDK's Bedrock runtime client speaks HTTP/2), so the real AWS SDK client and the app's BedrockProvider run unchanged (serialisation, signing,
// error parsing). It records every request body byte for byte (the prompt-cache tests compare them).
//
// What it models: a text answer (stop end_turn, or max_tokens when maxTokens is 1, like a one-token ping), usage with cache
// counts, an optional reasoning block, the error answers AWS gives (AccessDenied for IAM and for model access, the account
// quota of 0, throttling, 5xx, an unknown model id) and a model that rejects the effort field. Not modelled: SigV4 maths
// (any credentials pass), streaming, guardrails.
import { createServer, type Http2Server, type Http2ServerRequest, type Http2ServerResponse } from 'node:http2'
import type { AddressInfo } from 'node:net'

export type BedrockSimScenario =
  | 'ok'
  | 'access_denied'
  | 'model_access'
  | 'quota'
  | 'throttled'
  | 'unavailable'
  | 'invalid_model'
  | 'refusal'

export interface BedrockSimOptions {
  scenario?: BedrockSimScenario
  /** Answer 400 to a request carrying an effort (outputConfig.effort or additionalModelRequestFields). */
  rejectEffort?: boolean
  /** The answer's content blocks (Converse JSON) for 'ok'; default one text block "OK". */
  content?: unknown[]
  usage?: {
    inputTokens: number
    outputTokens: number
    cacheReadInputTokens?: number
    cacheWriteInputTokens?: number
  }
}

export interface BedrockSimRequest {
  modelId: string
  body: Buffer
  json: Record<string, unknown>
}

export const SIM_MESSAGES = {
  access_denied:
    'User: arn:aws:sts::123456789012:assumed-role/oasis-app-role/i-0 is not authorized to perform: bedrock:InvokeModel on resource: arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-sonnet-5-5 because no identity-based policy allows the bedrock:InvokeModel action',
  model_access: "You don't have access to the model with the specified model ID.",
  quota:
    'The model anthropic.claude-sonnet-5-5 is not available for this account. Request a quota increase to use it.',
  throttled: 'Too many requests, please wait before trying again.',
  unavailable: 'Bedrock is unable to process your request.',
  invalid_model: 'The provided model identifier is invalid.',
} as const

const ERRORS: Record<Exclude<BedrockSimScenario, 'ok' | 'refusal'>, { status: number; type: string }> = {
  access_denied: { status: 403, type: 'AccessDeniedException' },
  model_access: { status: 403, type: 'AccessDeniedException' },
  quota: { status: 429, type: 'ThrottlingException' },
  throttled: { status: 429, type: 'ThrottlingException' },
  unavailable: { status: 503, type: 'ServiceUnavailableException' },
  invalid_model: { status: 400, type: 'ValidationException' },
}

export class BedrockSim {
  readonly requests: BedrockSimRequest[] = []
  private server: Http2Server | undefined

  constructor(public opts: BedrockSimOptions = {}) {}

  async start(port = 0): Promise<string> {
    this.server = createServer((req, res) => void this.handle(req, res))
    await new Promise<void>((resolve) => this.server!.listen(port, '127.0.0.1', resolve))
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
  }

  async stop(): Promise<void> {
    const s = this.server
    this.server = undefined
    if (s) await new Promise<void>((resolve) => s.close(() => resolve()))
  }

  private async handle(req: Http2ServerRequest, res: Http2ServerResponse): Promise<void> {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const body = Buffer.concat(chunks)
    const m = /^\/model\/([^/]+)\/converse$/.exec(req.url ?? '')
    if (req.method !== 'POST' || !m)
      return this.error(res, 404, 'UnknownOperationException', `no route ${req.method} ${req.url}`)
    let json: Record<string, unknown>
    try {
      json = JSON.parse(body.toString('utf8')) as Record<string, unknown>
    } catch {
      return this.error(res, 400, 'SerializationException', 'the body is not JSON')
    }
    const modelId = decodeURIComponent(m[1]!)
    this.requests.push({ modelId, body, json })
    const scenario = this.opts.scenario ?? 'ok'
    if (scenario !== 'ok' && scenario !== 'refusal') {
      const e = ERRORS[scenario]
      return this.error(res, e.status, e.type, SIM_MESSAGES[scenario])
    }
    const effort =
      (json.outputConfig as { effort?: unknown } | undefined)?.effort ?? json.additionalModelRequestFields
    if (this.opts.rejectEffort && effort !== undefined)
      return this.error(
        res,
        400,
        'ValidationException',
        'The model returned the following errors: output_config.effort: Extra inputs are not permitted',
      )
    const maxTokens = (json.inferenceConfig as { maxTokens?: number } | undefined)?.maxTokens
    const usage = this.opts.usage ?? { inputTokens: 12, outputTokens: 1 }
    const answer = {
      output: {
        message: {
          role: 'assistant',
          content: scenario === 'refusal' ? [] : (this.opts.content ?? [{ text: 'OK' }]),
        },
      },
      stopReason: scenario === 'refusal' ? 'refusal' : maxTokens === 1 ? 'max_tokens' : 'end_turn',
      usage: {
        ...usage,
        totalTokens:
          usage.inputTokens +
          usage.outputTokens +
          (usage.cacheReadInputTokens ?? 0) +
          (usage.cacheWriteInputTokens ?? 0),
      },
      metrics: { latencyMs: 5 },
    }
    res.writeHead(200, {
      'content-type': 'application/json',
      'x-amzn-requestid': `sim-${this.requests.length}`,
    })
    res.end(JSON.stringify(answer))
  }

  private error(res: Http2ServerResponse, status: number, type: string, message: string): void {
    res.writeHead(status, {
      'content-type': 'application/json',
      'x-amzn-errortype': `${type}:http://internal.amazon.com/coral/com.amazon.bedrock/`,
      'x-amzn-requestid': 'sim-error',
    })
    res.end(JSON.stringify({ message }))
  }
}
