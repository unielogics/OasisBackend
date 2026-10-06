import { createHmac, timingSafeEqual } from 'node:crypto'

// Domain-separated HMAC-SHA256 over a canonical, newline-joined tuple. Upload and download tags can never be
// swapped because the first line names the purpose.

function tag(secret: string, parts: ReadonlyArray<string | number>): string {
  return createHmac('sha256', secret).update(parts.join('\n')).digest('base64url')
}

export const signUpload = (
  secret: string,
  p: { key: string; contentType: string; maxBytes: number; exp: number },
) => tag(secret, ['oasis-upload-v1', p.key, p.contentType, p.maxBytes, p.exp])

export const signDownload = (secret: string, p: { key: string; exp: number }) =>
  tag(secret, ['oasis-download-v1', p.key, p.exp])

export function tagsEqual(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}
