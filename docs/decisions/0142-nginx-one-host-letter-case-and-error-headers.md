# 0142 nginx serves one host name, refuses other letter cases of /api, and puts HSTS and nosniff on its own answers
Status: accepted (2026-10-09)

* **Default servers.** Port 80 answers 444 (connection closed) and port 443 refuses the handshake (`ssl_reject_handshake on`) for any
  name but the domain, including bare IP addresses (review L3). The site's own servers are not default servers.
* **Letter case.** nginx prefixes are case-sensitive and Next.js rewrites are not, so `/API/v1/openapi.json` reached the API through
  the dashboard, past the deny rules and the rate zones (review M1). `location ^~ /api/` (the sign-in regex nested inside, so its
  tighter zone still applies) and `location ~* ^/(api|dev-storage|hooks)(/|$)` returning 404 close that. Lower-case `/api` gets
  nginx's own 301 to `/api/`. (The dashboard may also stop adding the rewrites in production; this does not depend on it.)
* **Headers on nginx's answers.** HSTS and `X-Content-Type-Options` are added at server level with `always`, and `proxy.conf` hides
  the upstream copies, so every answer (403, 404, 413, 429, 502, proxied pages and API answers) carries exactly one of each (review L2).
  `security-headers.conf` repeats them for the dashboard location, whose own `add_header` lines replace the inherited ones.
* Proven in a real nginx 1.30 (an unprivileged instance on loopback ports with stub upstreams) besides the structural tests.
