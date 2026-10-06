// Runs the SMS Gate device simulator: the app's local-server API plus /__sim/* control endpoints.
//
//   pnpm sim:smsgate
//   SMSGATE_DEVICE_URL=http://127.0.0.1:8080 SMSGATE_USERNAME=sim SMSGATE_PASSWORD=sim \
//   SMSGATE_WEBHOOK_SECRET=sim-signing-key SMS_PROVIDER=smsgate pnpm dev   # point the backend at it
//
// Environment: SIM_PORT (8080), SIM_HOST (127.0.0.1), SIM_USERNAME (sim), SIM_PASSWORD (sim), SIM_SIGNING_KEY
// (sim-signing-key), SIM_AUTO (instant|manual, default instant), SIM_STRICT_HTTPS (true refuses http:// webhook URLs).
import { SimServer } from '../src/integrations/smsgate/sim-server.js'

const env = process.env
const port = Number(env.SIM_PORT ?? 8080)
const host = env.SIM_HOST ?? '127.0.0.1'
const username = env.SIM_USERNAME ?? 'sim'
const password = env.SIM_PASSWORD ?? 'sim'
const signingKey = env.SIM_SIGNING_KEY ?? 'sim-signing-key'
const auto = env.SIM_AUTO === 'manual' ? 'manual' : 'instant'

const server = new SimServer({ host, port, username, password, signingKey, autoProgress: auto, strictWebhookUrls: env.SIM_STRICT_HTTPS === 'true' })
const url = await server.start()

const ctl = `${url}/__sim`
console.log(`SMS Gate simulator listening on ${url}
  device API   Basic ${username}:${password}   POST /messages  GET /messages/{id}  GET /health  /webhooks
  signing key  ${signingKey}   (X-Signature = hex HMAC-SHA256(key, body + X-Timestamp))
  lifecycle    ${auto === 'instant' ? 'messages go Pending -> Delivered immediately' : 'manual: drive messages with the control endpoints'}

control endpoints (no auth), all POST with a JSON body unless noted:
  ${ctl}/inbound        {"from":"+17865550151","message":"C"}      inject an inbound text
  ${ctl}/sent/{id}  ${ctl}/delivered/{id}  ${ctl}/failed/{id} {"reason":"Radio off"}
  ${ctl}/outage         {"mode":"off|down|error5xx|hang|hang_after_accept","once":false}
  ${ctl}/duplicate      {"count":1}     next deliveries are sent twice (same envelope id)
  ${ctl}/hold  {"on":true}   then ${ctl}/flush   release held webhooks newest first (out of order)
  ${ctl}/ping  ${ctl}/app-started  ${ctl}/health {"status":"warn","battery":18,"charging":false}
  ${ctl}/signing-key    {"key":"rotated"}
  GET ${ctl}/state  GET ${ctl}/deliveries
`)

const stop = async (): Promise<void> => {
  await server.stop()
  process.exit(0)
}
process.on('SIGINT', () => void stop())
process.on('SIGTERM', () => void stop())
