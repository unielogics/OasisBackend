// Classifies `tailscale serve status --json` for deploy/scripts/tailscale-serve.sh.
//   node serve-check.mjs --port 8443 --path /hooks/smsgate --target http://127.0.0.1:3002/hooks/smsgate < status.json
// Prints "empty", "exact" or "other: <why>" and exits 0 for empty and exact, 1 for other.
// "exact" means this node serves nothing but the one mount: a single HTTPS port, a single path under it, proxied to the target,
// no Funnel (public internet), no other TCP forwarders, no services. The shape follows Tailscale's ServeConfig type
// (TCP, Web[host:port].Handlers[path].Proxy, AllowFunnel, Services, Foreground).
import { readFileSync } from 'node:fs'

const args = process.argv.slice(2)
const opt = (name) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const port = opt('port')
const mount = opt('path')
const target = opt('target')
if (!port || !mount || !target) {
  console.error('usage: serve-check.mjs --port N --path /p --target URL < status.json')
  process.exit(2)
}

const norm = (u) => u.replace(/\/+$/, '').replace('://localhost', '://127.0.0.1')
let cfg
try {
  const text = readFileSync(0, 'utf8').trim()
  cfg = text ? JSON.parse(text) : {}
} catch (e) {
  console.log(`other: the status is not JSON (${e.message})`)
  process.exit(1)
}

const nonEmpty = (v) => v && typeof v === 'object' && Object.keys(v).length > 0
if (!nonEmpty(cfg)) {
  console.log('empty')
  process.exit(0)
}

const why = []
for (const key of Object.keys(cfg))
  if (!['TCP', 'Web', 'AllowFunnel', 'Services', 'Foreground', 'ETag'].includes(key))
    why.push(`unknown section ${key}`)
if (nonEmpty(cfg.Services)) why.push('Tailscale Services are configured')
if (nonEmpty(cfg.Foreground)) why.push('a foreground (non-persistent) serve session exists')
for (const [hostport, on] of Object.entries(cfg.AllowFunnel ?? {}))
  if (on) why.push(`Funnel exposes ${hostport} to the internet`)
for (const [p, tcp] of Object.entries(cfg.TCP ?? {})) {
  if (p !== port) why.push(`TCP port ${p} is forwarded`)
  else if (!tcp?.HTTPS || tcp?.TCPForward || tcp?.TerminateTLS) why.push(`port ${p} is not plain HTTPS serve`)
}
const web = Object.entries(cfg.Web ?? {})
if (web.length !== 1) why.push(`${web.length} web hosts are served, expected 1`)
for (const [hostport, site] of web) {
  if (!hostport.endsWith(`:${port}`)) why.push(`${hostport} is not on port ${port}`)
  const handlers = Object.entries(site?.Handlers ?? {})
  if (handlers.length !== 1)
    why.push(`${hostport} has ${handlers.length} paths: ${handlers.map(([p]) => p).join(', ')}`)
  for (const [p, h] of handlers) {
    if (p !== mount) why.push(`path ${p} is served, expected only ${mount}`)
    else if (!h?.Proxy || norm(h.Proxy) !== norm(target))
      why.push(`${p} proxies to ${h?.Proxy ?? JSON.stringify(h)}, expected ${target}`)
    if (h?.Path || h?.Text || h?.Redirect) why.push(`${p} serves files or text instead of proxying`)
  }
}
if (!Object.keys(cfg.TCP ?? {}).includes(port)) why.push(`HTTPS port ${port} is not enabled`)

if (why.length) {
  console.log(`other: ${why.join('; ')}`)
  process.exit(1)
}
console.log('exact')
