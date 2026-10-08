// Test-only preload for the spawned API process (node --import): stands in for the Amazon SNS certificate server, so /hooks/ses
// verifies notifications signed by the test CA's certificate in OASIS_TEST_SNS_CERT_FILE. The application is not changed: it
// fetches https://sns.<region>.amazonaws.com/<...>.pem exactly as in production and gets the test certificate. Any other https
// request made with fetch from that process is refused, so nothing reaches a real AWS endpoint.
import { readFileSync } from 'node:fs'

const pem = readFileSync(process.env.OASIS_TEST_SNS_CERT_FILE ?? '', 'utf8')
const realFetch = globalThis.fetch
const SNS_CERT = /^https:\/\/sns\.[a-z0-9-]+\.amazonaws\.com\/[^?#]+\.pem$/

globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (SNS_CERT.test(url)) return new Response(pem, { status: 200, headers: { 'content-type': 'application/x-pem-file' } })
  if (url.startsWith('https://')) throw new Error(`test process: outbound https request to ${url} refused`)
  return realFetch(input, init)
}
