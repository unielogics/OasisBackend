import http from 'node:http'

export interface SseFrame {
  id?: string
  event?: string
  data?: unknown
  comment?: string
  retry?: string
  raw: string
}

export interface SseClient {
  frames: SseFrame[]
  status: number
  headers: Headers
  /** Resolves with the first frame (after those already seen) matching the predicate. */
  waitFor(pred: (f: SseFrame) => boolean, timeoutMs?: number): Promise<SseFrame>
  /** Data frames only (default unnamed messages). */
  messages(): SseFrame[]
  ended: Promise<void>
  /** Response body text for non-200 responses. */
  body(): string
  close(): void
}

function parseFrame(raw: string): SseFrame {
  const f: SseFrame = { raw }
  for (const line of raw.split('\n')) {
    if (line.startsWith(':')) f.comment = line.slice(1).trim()
    else if (line.startsWith('id: ')) f.id = line.slice(4)
    else if (line.startsWith('event: ')) f.event = line.slice(7)
    else if (line.startsWith('retry: ')) f.retry = line.slice(7)
    else if (line.startsWith('data: ')) f.data = JSON.parse(line.slice(6))
  }
  return f
}

export async function openSse(url: string, headers: Record<string, string> = {}): Promise<SseClient> {
  const frames: SseFrame[] = []
  const waiters: Array<() => void> = []
  let resolveEnded!: () => void
  const ended = new Promise<void>((r) => (resolveEnded = r))
  const wake = (): void => {
    for (const w of waiters.splice(0)) w()
  }

  // node:http with its own agent: close() destroys the socket, exactly like a browser tab closing.
  const { req, res } = await new Promise<{ req: http.ClientRequest; res: http.IncomingMessage }>(
    (resolve, reject) => {
      const r = http.get(
        url,
        { headers: { accept: 'text/event-stream', ...headers }, agent: new http.Agent({ keepAlive: false }) },
        (resp) => resolve({ req: r, res: resp }),
      )
      r.on('error', reject)
    },
  )

  let buf = ''
  res.setEncoding('utf8')
  res.on('data', (chunk: string) => {
    buf += chunk
    let i: number
    while ((i = buf.indexOf('\n\n')) >= 0) {
      frames.push(parseFrame(buf.slice(0, i)))
      buf = buf.slice(i + 2)
    }
    wake()
  })
  const finish = (): void => {
    resolveEnded()
    wake()
  }
  res.on('end', finish)
  res.on('close', finish)
  res.on('error', finish)
  if (res.statusCode !== 200) {
    // plain JSON error bodies (401/422/429) are exposed through frames-less status + the raw text
    let body = ''
    res.on('data', (c: string) => (body += c))
    await ended
    const client: SseClient = {
      frames,
      status: res.statusCode ?? 0,
      headers: toHeaders(res.headers),
      messages: () => [],
      waitFor: async () => {
        throw new Error(body)
      },
      ended,
      close: () => req.destroy(),
      body: () => body,
    }
    return client
  }

  return {
    frames,
    status: res.statusCode,
    headers: toHeaders(res.headers),
    body: () => '',
    messages: () => frames.filter((f) => f.event === undefined && f.data !== undefined),
    async waitFor(pred, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs
      let from = 0
      for (;;) {
        for (; from < frames.length; from++) if (pred(frames[from]!)) return frames[from]!
        const left = deadline - Date.now()
        if (left <= 0)
          throw new Error(
            `Timed out waiting for an SSE frame; saw: ${JSON.stringify(frames.map((f) => f.raw))}`,
          )
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, left)
          waiters.push(() => {
            clearTimeout(t)
            resolve()
          })
        })
      }
    },
    ended,
    close: () => req.destroy(),
  }
}

function toHeaders(h: http.IncomingHttpHeaders): Headers {
  const out = new Headers()
  for (const [k, v] of Object.entries(h)) if (v !== undefined) out.set(k, Array.isArray(v) ? v.join(', ') : v)
  return out
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
