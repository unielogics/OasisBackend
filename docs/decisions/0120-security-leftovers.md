# 0120 Security leftovers: masked phone match, rate limits before authentication, audited invoice creation, probe detail, log redaction
Status: accepted (2026-10-08)

* **SEC-10, masked phone match.** `POST /customers` is a find-or-create by phone, so for a caller without `cli.contact` it was a
  phone-to-name oracle (the search route already refused phone tokens). Without `cli.contact`, a number that belongs to a live
  customer now answers `201 {created: false, masked: true, customer: {id: null, fullName: "L. C.", phone: null, email: null,
  vip: false, needsDetails: false, vehicles: []}}` and **writes nothing** to that record (no filled name or email, no vehicle):
  the caller cannot see the record, so it may not change it either. The "existing customer" signal stays, so the booking panel can
  say so; such a caller finds the person by name. No id is returned because every other route would read the record by it. A
  number nobody owns is created and returned as before; a caller with `cli.contact` sees the full record. The race where someone
  else creates the same number meanwhile is masked the same way.
* **SEC-14, rate limits before authentication** (`src/http/rate-limit.ts`). The global limit ran in `preHandler`, after the
  authentication hook, so floods ending in 401 or 403 were never counted. Now:
  1. an `onRequest` hook registered ahead of authentication caps every rate-limited route (and unmatched paths) per client
     address at `RATE_LIMIT_PER_MIN x 4` a minute, with no database work, so a garbage-cookie flood stops costing session
     lookups once over the cap; the factor leaves room for several staff behind one shop address;
  2. the per-caller budget (`RATE_LIMIT_PER_MIN`, per user when the session resolves, per address otherwise) is charged after the
     session lookup and **before** the 401/403 decision; public routes are charged per address;
  3. routes with their own `config.rateLimit` keep exactly that limit in `preHandler` (sign-in 30, invite accept 20, forgot 10,
     reset 20, `/events` 30, arrival ping 60); `rateLimit: false` (probes, webhooks, the dev object store) stays exempt.
  The plugin's in-memory store is per process, as before.
* **SEC-15, audited invoice creation.** `payments.invoice_created` and `payments.invoice_reopened` (from the gateway and from the
  deposit-settlement reopen) now carry the request's audit context: actor (user, employee, name, roles, view-as), request id,
  idempotency key, address. `EnsureInvoiceInput.audit` and the settlement `reopen` request take it; `ensureInvoiceFor` passes the
  booking's, reschedule's or reopen's actor. Seeds and jobs without a request still write the row with no actor.
* **Probe detail.** `/readyz` and `/healthz` return their `checks` (database error text, pending migration names, queue state) only
  when the socket peer is a loopback address and no `X-Forwarded-For`, `X-Real-IP` or `Forwarded` entry names another address;
  everyone else gets `{status}` with the same status code. nginx already restricts `/readyz` to the host; this holds even when a
  proxy is misconfigured or `TRUST_PROXY` is off, and `/healthz`, which nginx exposes, no longer leaks the database's error text.
* **Log redaction.** The PII masking hook used to flatten Fastify's request and reply into `{}` before their serializers ran, so
  request logs carried no method or URL at all (and dates logged as `{}`). The request and reply now reach their serializers
  (method, URL, host, address; status code) and the URL is redacted first: credential and search-term query values (`token`,
  `code`, `key`, `q`, `search`, `term`, `phone`, `email`, `name`, `plate`, ...), the path segment after `/a/`, `/invite/`,
  `/reset-password/` and similar link prefixes, and any other opaque 32+ character segment (UUIDs and Squarespace ids stay
  readable); the result is still PII-masked. Request bodies are never logged.
