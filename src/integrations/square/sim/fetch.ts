import type { SquareSimApi } from './api.js'

/**
 * A fetch that hands the request to the simulator in this process (SQUARE_PROVIDER=sim): no socket, the same client, retries,
 * wire parsing and errors as live. A simulated hang becomes the TimeoutError fetch raises when AbortSignal.timeout fires.
 */
export function simFetch(api: SquareSimApi): typeof fetch {
  return async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const headers: Record<string, string | undefined> = {}
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v
    })
    const text = typeof init?.body === 'string' ? init.body : undefined
    const out = await api.handle({
      method: init?.method ?? 'GET',
      path: url.pathname,
      query: url.searchParams,
      headers,
      body: text ? (JSON.parse(text) as unknown) : undefined,
    })
    if (out.hang) throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    return new Response(JSON.stringify(out.body), { status: out.status, headers: { 'content-type': 'application/json', ...out.headers } })
  }
}
