<!-- Reference material generated during planning (2026-10-06) from the three Claude Design prototypes. Source of truth for the build; see docs/plan.md. -->

# Oasis Auto Spa: Delivery Plan (Dashboard + Backend)

This plan covers the dashboard and backend only. The customer app, online booking UI and public site come later, and the site repo is untouched.

Two adjustments from the user are built in throughout:
- **Squarespace stays the card processor.** Oasis owns the ledger and syncs from Squarespace.
- **SMS goes through a tablet running SMS Gate, reached over Tailscale.**

I read the cross and runtime reports in full. I read every other report's headings, plus the domain-report sections on commands, REST, ambiguities and risks. I also checked the host read-only. Findings that shaped the plan:
- `nodejs22`, `nodejs22-npm`, `postgresql15-server`, `postgresql15-contrib`, `fontconfig`, the Chromium shared libs and the Noto/DejaVu font packages are all in the dnf repos.
- `https://pkgs.tailscale.com/stable/amazon-linux/2023/tailscale.repo` returns 200.
- `/dev/net/tun` exists.
- Passwordless sudo works.
- `git config --global` already has user.name "Franco", user.email "franco@unielogics.com" and init.defaultbranch main.
- The backend and dashboard `origin` remotes already point at `git@github-oasis-backend:unielogics/OasisBackend.git` and `git@github-oasis-dashboard:unielogics/OasisDashboard.git`.

---

## 0. Guiding decisions

These make the plan executable.

1. **Two repos, one contract.**
   - The backend repo emits `docs/openapi.json` (generated from Zod schemas) as the contract.
   - The dashboard generates a typed client from it.
   - Both repos live on this box, so `pnpm gen:api` in the dashboard reads `../backend/docs/openapi.json` (override with `OASIS_BACKEND_PATH`), and the generated output is committed.
2. **Compiler and harness first on the UI side. Foundations first on the backend side. These run in parallel.** Every dashboard screen depends on the compiler and the parity harness, and every vertical depends on schema, auth and RBAC. Neither depends on the other.
3. **Settings is the first vertical.**
   - It feeds roles, hours, closures, catalog, employees and VIP/arrival to everything else.
   - Its screen has no timers, drag or pointer engine, so it is the safest first proof that compiled-UI, shim, API and parity work end to end.
   - Operations is the riskiest screen (1 s tick, gesture engine, 4 views, 106K-char UI spec), so it goes after the stack is proven.
4. **Parity is measured against the original bundle rendered offline in headless Chromium.** The original and the port render on the same machine, same browser, same fonts and same pinned clock. The target is zero difference, with an explicit allow-list for deliberate deviations.
5. **The port runs in two data modes.**
   - `fixture` mode loads a `design` seed profile that reproduces the frozen state (2026-06-13 10:36 ET). This is used only for parity runs.
   - `live` mode runs on real API data.
   - Parity proves the UI. Domain tests prove the data.
6. **Adapters sit behind ports, each with a built-in simulator.** Everything runs with no credentials. Real adapters are selected by `*_PROVIDER=sim|live` env vars.
7. **Squarespace and the tablet are I/O adapters, not the source of domain truth.**
   - Oasis owns invoices, the append-only ledger, approvals and store credit.
   - Squarespace feeds card facts into that ledger.
8. **Deliberate deviations.** The only visible changes from the designs are the ones listed here, tracked in a machine-readable manifest (`design/deviations.yaml`) that the parity harness consumes:
   - D1: "WhatsApp" becomes "SMS".
   - D2: fabricated or hard-coded numbers become real computations.
   - D3: clearly-buggy logic is fixed (for example the inverted Added/Removed toast).
   - D4: three screens the designs lack are added minimally from the design tokens: login, a "no access / session expired" state, and a 403 toast style. The Super-Admin "View as" reuses the existing Payments preview menu.
   - D5: the payment-link and Squarespace-confirmation states described in §M5, expressed in existing UI elements (status pills, toasts). No new chrome.
   - There is no hover state, no extra animation and no new layout anywhere.

---

## 1. Environment bootstrap (Amazon Linux 2023 aarch64)

Run as `ec2-user` with sudo. After every step, run the verify command. A script `scripts/bootstrap/NN-*.sh` in the backend repo (idempotent, `set -euo pipefail`) will wrap each block so the orchestrator can re-run it.

### 1.1 Base packages and Node 22

```bash
sudo dnf -y install nodejs22 nodejs22-npm git gcc-c++ make unzip jq tar xz
node --version && npm --version      # expect v22.x and 10.x
```

- `gcc-c++` and `make` are only a safety net. The dependency policy is pure-JS or prebuilt-arm64 only.
- If `node` is not on PATH (AL2023 versioned packages sometimes install `node-22`), run `sudo alternatives --list | grep -i node`, or fall back to the tarball. Download `node-v22.x-linux-arm64.tar.xz` from nodejs.org and extract to `~/.local/node`. Then add `~/.local/node/bin` to `~/.bashrc` and `~/.profile`.

pnpm (choose pnpm over npm for workspace-style dedupe, strict node_modules and speed on 2 vCPU):

```bash
mkdir -p ~/.local && npm config set prefix ~/.local
npm i -g pnpm@10
export PATH=$HOME/.local/bin:$PATH; echo 'export PATH=$HOME/.local/bin:$PATH' >> ~/.bashrc
pnpm --version
```

- Pin it per repo with `"packageManager": "pnpm@10.x.y"` and `.nvmrc`/`engines` of `>=22 <23`.
- pnpm 10 blocks dependency install scripts by default. Allow-list `esbuild` (and `@swc/*` if used) in `pnpm.onlyBuiltDependencies`. Do not add anything else without an ADR.
- Memory guard on a 7.8 GB box: set `NODE_OPTIONS=--max-old-space-size=3072` for `next build` and for tests.
- Optional 2 GB swap as OOM insurance during `next build` plus Chromium:
  ```bash
  sudo dd if=/dev/zero of=/swapfile bs=1M count=2048 && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
  ```

### 1.2 Postgres 15

```bash
sudo dnf -y install postgresql15 postgresql15-server postgresql15-contrib
sudo postgresql-setup --initdb
sudo systemctl enable --now postgresql
sudo -u postgres psql -c 'select version()'       # PostgreSQL 15.x aarch64
```

Switch local TCP auth from `ident` to scram:

```bash
sudo sed -i 's/^\(host\s\+all\s\+all\s\+\(127\.0\.0\.1\/32\|::1\/128\)\s\+\)ident/\1scram-sha-256/' /var/lib/pgsql/data/pg_hba.conf
echo "password_encryption = 'scram-sha-256'" | sudo tee -a /var/lib/pgsql/data/postgresql.conf >/dev/null
```

Tuning for 2 vCPU / 7.8 GB, appended to `postgresql.conf`:

```
shared_buffers=512MB
effective_cache_size=3GB
work_mem=16MB
max_connections=60
timezone='UTC'
```

Roles and databases (the dev password is generated and stored only in `.env`, never in git):

```bash
PW=$(openssl rand -hex 16)
sudo -u postgres psql -c "CREATE ROLE oasis LOGIN PASSWORD '$PW'"
sudo -u postgres createdb -O oasis oasis_dev
sudo -u postgres createdb -O oasis oasis_test
for d in oasis_dev oasis_test; do sudo -u postgres psql -d $d -c "CREATE EXTENSION IF NOT EXISTS citext; CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS btree_gist; CREATE EXTENSION IF NOT EXISTS pgcrypto;"; done
sudo systemctl restart postgresql
PGPASSWORD=$PW psql -h 127.0.0.1 -U oasis -d oasis_dev -c 'select 1'
```

- `citext` is for emails.
- `pg_trgm` is for customer/plate/phone search.
- `btree_gist` is for exclusion constraints on bay occupancy and employee shifts.
- `pgcrypto` is for random tokens.
- All four are "trusted" extensions in PG13+, so the database owner can create them.
- Test strategy: tests run against `oasis_test`. Each vitest worker clones a pre-migrated template database (`CREATE DATABASE test_N TEMPLATE oasis_test_template`), which is fast and isolated. Use one worker at a time for integration suites on this box (`--poolOptions.threads.singleThread`).

### 1.3 Tailscale (backend host joins the tailnet)

Fully automatable once the user supplies an auth key. Otherwise one interactive click.

```bash
curl -fsSL https://tailscale.com/install.sh | sh       # detects Amazon Linux 2023, adds dnf repo, installs
sudo systemctl enable --now tailscaled
sudo tailscale up --hostname=oasis-api                  # prints https://login.tailscale.com/a/... ; USER opens it and approves
# automated alternative: sudo tailscale up --hostname=oasis-api --auth-key=tskey-auth-XXXX   (reusable, tagged tag:oasis-server)
sudo tailscale set --operator=ec2-user
tailscale status && tailscale ip -4
```

One-time admin steps the user must do in the Tailscale admin console:
1. Enable MagicDNS.
2. Enable HTTPS Certificates (DNS page). This is required for `tailscale serve` to issue the `*.ts.net` Let's Encrypt cert.
3. Add the ACL below, tagging the server and the tablet.

```jsonc
// tagOwners: tag:oasis-server, tag:oasis-tablet -> the user
// acls:
{ "action":"accept", "src":["tag:oasis-server"], "dst":["tag:oasis-tablet:8080"] },   // backend -> SMS Gate local server
{ "action":"accept", "src":["tag:oasis-tablet"], "dst":["tag:oasis-server:443"] }     // SMS Gate webhooks -> backend
```

If staff laptops reach the dashboard over the tailnet, they also need access to `tag:oasis-server:443` (see §6 decision on exposure).

HTTPS webhook target for SMS Gate. The tablet must call an HTTPS URL with a valid cert for any non-127.0.0.1 target. Only the webhook path is served on the tailnet:

```bash
sudo tailscale serve --bg --https=443 --set-path /webhooks/smsgate http://127.0.0.1:4000/webhooks/smsgate
tailscale serve status         # https://oasis-api.<tailnet>.ts.net/webhooks/smsgate
```

Flag spellings vary slightly between Tailscale versions, so check `tailscale serve --help`. The verification is: from the tablet, `https://oasis-api.<tailnet>.ts.net/webhooks/smsgate` loads with a valid-cert indicator.

Outbound traffic (backend to the tablet) can be plain `http://<tablet-tailnet-ip>:8080`. WireGuard already encrypts it, and Basic auth rides inside the tunnel.

If Squarespace webhooks are enabled later (§M6a), they need a public HTTPS URL. Use polling as the baseline. For webhooks, either expose a separate tiny relay process via Tailscale Funnel (restricted to `/webhooks/squarespace`), or put the API behind a public domain.

The tablet setup is a user task and needs the physical device: install Tailscale for Android and join the same tailnet, install SMS Gate, and enable its Local Server (§M6b).

### 1.4 Playwright + Chromium arm64 + fonts

This runs in the dashboard repo and can be automated fully:

```bash
sudo dnf -y install fontconfig dejavu-sans-fonts google-noto-sans-fonts google-noto-sans-symbols-fonts \
  google-noto-sans-symbols2-fonts google-noto-emoji-fonts nss atk at-spi2-atk cups-libs libdrm libxkbcommon \
  libXcomposite libXdamage libXfixes libXrandr mesa-libgbm pango alsa-lib
cd ~/oasis/dashboard && pnpm add -D @playwright/test@^1.49    # page.clock needs >=1.45
pnpm exec playwright install chromium                          # headless shell, linux-arm64
```

- Playwright warns that AL2023 is unsupported. It normally falls back to the Ubuntu arm64 build. If the download picks the wrong platform, set `PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-arm64`.
- Missing libs show up via `ldd $(find ~/.cache/ms-playwright -type f \( -name headless_shell -o -name chrome \) | head -1) | grep 'not found'`. Install each from dnf (`dnf provides '*/libXYZ.so.N'`).
- Do not use Google Chrome or Chrome-for-Testing. They have no linux-arm64 builds.
- **Determinism.**
  - Commit the exact fallback fonts (for the glyphs `⚠ ★ ‹ › − ✕ ↑ ↓ → ↩ ± ◆`, which the bundled fonts lack) under `design/fonts-fallback/` plus a `fonts.conf`. The harness runs with `FONTCONFIG_FILE` pointing at it, so original and port always resolve the same fallback.
  - Launch flags: `--disable-dev-shm-usage --force-color-profile=srgb --font-render-hinting=none --disable-lcd-text`. Use `deviceScaleFactor: 1`, one worker, and `--no-sandbox` only if the sandbox fails.
- Smoke test: open an extracted original bundle at 1480x1000 and screenshot it. The result must be non-blank, with Manrope rendering.

### 1.5 Git and repo hygiene

Git identity is already configured.

```bash
ssh -T git@github-oasis-backend ; ssh -T git@github-oasis-dashboard     # "Hi unielogics/..." (deploy keys; write access must be enabled)
cd ~/oasis/backend && git status && git remote -v                       # origin set, branch main (empty repo)
```

- Deploy keys must have write access (user check, §6).
- Add a repo-local pre-commit check (a plain `scripts/hooks/pre-commit`, installed via `git config core.hooksPath scripts/hooks`) that runs a secret regex scan, lint-staged, and typecheck on staged TS.

### 1.6 What needs the user versus automation

| Step | Automated | Needs user |
|---|---|---|
| Node, pnpm, Postgres, fonts, Playwright, swap | yes (sudo is passwordless) | none |
| Git remote + keys | verify only | confirm deploy keys are write-enabled |
| Tailscale install | yes | approve login URL (or supply an auth key); enable MagicDNS + HTTPS certs; ACL/tags |
| Tablet (SMS Gate + Tailscale app) | no | physical setup, then supply URL/user/password/signing key |
| AWS (SES, S3) | no | create IAM user/role, verify sender identity or domain, create bucket; supply keys |
| Squarespace | no | create API key (and OAuth app if needed), confirm plan tier; supply keys |
| `.env` generation | yes (secrets generated locally) | paste in the third-party credentials |

---

## 2. Repo layout and conventions

### 2.1 Backend (`~/oasis/backend`)

Stack:
- Node 22, TypeScript strict, ESM.
- Fastify 5 with `@fastify/cookie` and `@fastify/rate-limit`.
- Zod, plus `zod-to-openapi` for the contract.
- **DB layer: Kysely over `pg`.**
  - It gives typed SQL with no native code.
  - **Migrations are hand-written SQL files** (`db/migrations/YYYYMMDDHHMM_name.sql`, forward-only) applied by a small in-repo runner.
  - Timestamped names avoid collisions between parallel worktrees.
  - `db/schema.sql` is regenerated by `pg_dump -s` for review.
- **Jobs: `pg-boss`.**
  - It is Postgres-backed and pure JS, so there is no Redis.
  - It covers retries, scheduling, a singleton cron and dead-letter handling.
  - All integration retry and backoff goes through it.
- **Realtime: SSE.** Postgres `LISTEN/NOTIFY` fans out domain events to `GET /api/events` streams.
- **Password hashing: Node's built-in `crypto.scrypt`.** It adds no dependency.
- **Tests: vitest.** Add `fast-check` for money and ledger properties.
- **AWS: `@aws-sdk/client-sesv2`, `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`.**

```
src/
  app.ts server.ts worker.ts
  config/            # env schema (zod) + typed config, fail-fast
  platform/          # db, logger, errors, idempotency, audit, outbox, events(SSE), time, money, ids, authz
  modules/
    auth/ rbac/ settings/ hours/ closures/ emergency/ employees/ catalog/ vip/ arrival/
    customers/ appointments/ availability/ jobs/ checklists/ bays/ photos/ messaging/
    payments/ invoices/ ledger/ credit/ membership/ reports/ ops-read-models/
  integrations/
    ports/           # SmsProvider, EmailProvider, StorageProvider, CardProcessorSync
    sms/{smsgate,sim}/ email/{ses,sim}/ storage/{s3,fs}/ squarespace/{client,sync,webhooks,sim}/
  jobs/              # pg-boss handlers + schedules
  http/              # route registration, openapi, webhooks
db/migrations/ db/seed/{design,demo,empty}/
docs/ test/ scripts/
```

Conventions that matter:
- **Money lib.** `src/platform/money.ts` is the only place that does arithmetic. Integer cents. `taxCents(subtotal) = round_half_up(subtotal * rate_bp / 10000)` with `rate_bp = 700` stored in settings. Tip is added untaxed. Property tests pin the invariants (see §4).
- **Time lib.** UTC `timestamptz` in the database. Business-day logic uses `Intl` with the location's `timezone` setting (`America/New_York`). Closure dates are plain `date`. Hours are stored as minutes-from-midnight, Sunday = 0. No `new Date()` calls outside `platform/time.ts` (lint rule).
- **Every route declares its required permission in route metadata.** A boot-time check refuses to start if a route lacks `auth` metadata. The authz-matrix test is generated from that registry.
- **Every mutation** runs in one transaction, writes `audit_log`, and emits a domain event to the outbox. The outbox feeds SSE, the SMS queue and jobs.
- **Idempotency.** Mutating payment, message and webhook endpoints accept an `Idempotency-Key`. Webhooks dedupe on a provider event id in `webhook_inbox`.
- **`location_id` on every location-scoped table** from day one. One seeded row now. Adding a second location is then a migration plus a policy, not a rewrite.

Scripts (`package.json`):

```
dev            tsx watch src/server.ts  (+ worker via concurrently)
build          tsc -p tsconfig.build.json
lint, typecheck, test, test:int, test:contract
migrate        up | status | new <name>
seed           --profile design|demo|empty
openapi        emits docs/openapi.json and docs/api-spec.md
sim:smsgate    starts the SMS Gate device simulator (HTTP API + webhook sender)
sim:squarespace starts the Squarespace API/webhook simulator
check          lint + typecheck + test + openapi diff clean
```

### 2.2 Dashboard (`~/oasis/dashboard`)

Stack: Next.js 14.2 (latest patch), App Router, React 18.3.1 (exact pin), TypeScript, with no Tailwind and no CSS-in-JS. The reasons are the compiler report's warnings: Next 15 App Router requires React 19, the original runtime is React 18.3.1, and a CSS reset would break parity. Re-check security patch status of 14.2 at M1 and record the choice as an ADR.

```
design/
  originals/*.html          # the 3 original bundles, offline-renderable (used only by the harness)
  extracted/{cc,pay,set}/   # template.html, logic.js, fonts/*.woff2, global.css, manifest.json
  fonts-fallback/ fonts.conf
  deviations.yaml
tools/
  extract-design/           # unpack bundle -> template/logic/fonts/css
  dc-compiler/              # parse5 -> TSX codegen (build-time)
  parity/                   # harness: original renderer, port renderer, diff, reports
src/
  dc/                       # DCHost shim, DCLogic base, interp(), css(), ports of runtime helpers
  generated/{cc,pay,set}.tsx  # compiler output, committed, never hand-edited
  screens/{operations,payments,settings}/   # logic ports (verbatim classes, then data-wired)
  data/                     # API client (generated), stores, SSE client
  app/                      # login, /operations, /payments, /settings, layout (client-only screens)
public/fonts/
parity-reports/             # gitignored output
```

Scripts:

```
dev, build, start
gen:api              # openapi-typescript from ../backend/docs/openapi.json
extract:design       # regenerates design/extracted from originals
compile:design       # regenerates src/generated/*
lint, typecheck, test (vitest), test:e2e (Playwright)
parity               # all screens/states; parity:dom, parity:px, parity:logic
parity:update        # refuses without PARITY_ALLOW_BASELINE=1
check                # compile:design clean diff + lint + typecheck + unit + parity
```

Routing:
- `/operations`, `/payments`, `/settings` replace the `Oasis%20…dc.html` hrefs. The compiler rewrites them.
- `Oasis%20Settings.dc.html#emergency` becomes `/settings#emergency`, and the Settings logic keeps its `location.hash === '#emergency'` check.
- The closed-day link in Operations goes to `/settings` (landing on Working hours, as in the design).
- Screens render client-only (`dynamic(..., {ssr:false})`) because their initial state touches the clock and storage.
- `html, body` get `overflow:hidden` and `height:100%` exactly as the global CSS says. `data-theme` goes on the `<html>` element.
- Theme: `localStorage['oasis-theme']` is retained as the first paint source. It is also persisted per user via `PUT /api/me/preferences`.

### 2.3 Commit conventions

- Small commits directly to `main` (no PRs), imperative subjects with a scope prefix, such as `feat(settings): …`, `fix(ledger): …`, `test(parity): …`, `docs: …`, `chore(bootstrap): …`, `refactor`, `perf`.
- Each commit passes `pnpm check` locally.
- Every commit message ends with the trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Push after each green milestone sub-step:
  ```bash
  git -C ~/oasis/backend push origin main
  git -C ~/oasis/dashboard push origin main
  ```
  These use the SSH aliases through each repo's `origin`.
- Parallel workstreams run in isolated git worktrees, for example `git worktree add ../wt/ws-m3-settings -b ws/m3-settings`.
- The orchestrator integrates with `git rebase main` in each worktree, then `git merge --ff-only`, then re-runs `pnpm check`, then pushes.
- Workstreams own disjoint directories. The shared files that cause conflicts are listed in the dependency notes below. Only the orchestrator edits them during integration.

### 2.4 Docs to generate into the repos

**Backend `docs/`:**
- `design-spec.md` is the domain spec: entities, state machines, exact formulas, the cross-design contract table, and the deviations list. It is derived from cc-domain, pay-domain, set-domain and cross.
- `api-spec.md` is generated from OpenAPI plus a hand-written narrative of error shapes, idempotency, SSE events, auth, and the webhook contracts.
- `decisions/NNNN-title.md` are ADRs, with an index at `decisions.md`. Initial ADRs:
  - 0001 stack
  - 0002 money
  - 0003 time
  - 0004 RBAC
  - 0005 invoice model
  - 0006 Squarespace boundary
  - 0007 SMS Gate
  - 0008 realtime
  - 0009 React 18 pin
  - 0010 deviations policy
- `integrations/{squarespace,smsgate,ses,s3}.md`, `env.md`, `runbook.md` (start/stop, backups, tablet health, rotate secrets).
- `seed-fixtures.md` and `ambiguities-and-defaults.md` (the §6.3 table).

**Dashboard `docs/`:**
- `design-spec.md` is the UI spec: tokens, per-region component specs, interaction maps, and fidelity risks (from the three `*-ui` reports plus the runtime report). It is the compiler and harness contract.
- `compiler.md`, `parity.md` (how to run, thresholds, baselines policy), `deviations.md` (human-readable mirror of `deviations.yaml`), `decisions/`.

---

## 3. Env contract

`.env.example` committed in each repo. Missing required variables fail fast at boot (Zod). `*_PROVIDER=sim` needs no other variables for that integration.

### 3.1 Backend `.env.example`

```ini
# --- core ---
NODE_ENV=development
PORT=4000
LOG_LEVEL=info
DATABASE_URL=postgres://oasis:CHANGE@127.0.0.1:5432/oasis_dev
DATABASE_URL_TEST=postgres://oasis:CHANGE@127.0.0.1:5432/oasis_test
SESSION_SECRET=            # >=32 random bytes, base64
SESSION_COOKIE_NAME=oasis_sid
SESSION_TTL_HOURS=168
COOKIE_SECURE=false        # true behind HTTPS
PUBLIC_API_URL=http://localhost:4000
PUBLIC_DASHBOARD_URL=http://localhost:3000
CORS_ORIGINS=http://localhost:3000
TRUST_PROXY=false
BUSINESS_TZ=America/New_York          # initial value for the settings row only
BOOTSTRAP_ADMIN_EMAIL=                # creates first Super Admin on empty db
BOOTSTRAP_ADMIN_PASSWORD=
SEED_PROFILE=empty                    # empty|demo|design
FIXED_NOW=                            # test/parity only: ISO instant, ignored in production

# --- Squarespace (card processor + commerce source) ---
SQSP_MODE=sim                         # sim|live
SQSP_API_BASE=https://api.squarespace.com
SQSP_API_KEY=                         # Commerce APIs key (Orders/Transactions/Profiles)
SQSP_OAUTH_CLIENT_ID=                 # only if webhook subscriptions / OAuth are used
SQSP_OAUTH_CLIENT_SECRET=
SQSP_OAUTH_REDIRECT_URI=
SQSP_WEBHOOK_SECRET=                  # signing secret returned when a subscription is created
SQSP_WEBHOOK_PUBLIC_URL=              # public HTTPS URL if webhooks are enabled
SQSP_POLL_INTERVAL_SECONDS=120        # polling is the baseline, webhooks an optimization
SQSP_CHECKOUT_LINK_TEMPLATE=          # e.g. https://<site>/pay?ref={invoice} (staff-managed payment link base)
SQSP_TIER_PRODUCT_MAP=                # optional JSON seed: {"<productId>":"Premium",...}; canonical copy lives in DB

# --- SMS (SMS Gate on a tablet over Tailscale) ---
SMS_PROVIDER=sim                      # sim|smsgate
SMSGATE_DEVICE_URL=                   # http://100.x.y.z:8080 or http://<tablet>.<tailnet>.ts.net:8080
SMSGATE_API_PATH=/messages            # verify against the installed app's Swagger
SMSGATE_USERNAME=
SMSGATE_PASSWORD=
SMSGATE_WEBHOOK_SECRET=               # HMAC-SHA256 signing key configured in the app
SMSGATE_WEBHOOK_PUBLIC_URL=           # https://oasis-api.<tailnet>.ts.net/webhooks/smsgate
SMSGATE_DEVICE_ID=
SMSGATE_SIM_SLOT=                     # 1|2, blank = device default
SMSGATE_RATE_PER_MINUTE=12            # single physical device; carrier-safe default
SMSGATE_MAX_CONCURRENCY=1
SMSGATE_TIMEOUT_MS=15000
SMSGATE_HEARTBEAT_STALE_SECONDS=900
SMS_DEFAULT_COUNTRY=US
SMS_SHOP_NUMBER=                      # display only
SMS_QUIET_HOURS=21:00-08:00           # automated non-urgent sends are held; blank disables

# --- Email (AWS SES) ---
EMAIL_PROVIDER=sim                    # sim|ses
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=                    # or use an instance role
AWS_SECRET_ACCESS_KEY=
SES_FROM_ADDRESS=
SES_FROM_NAME=Oasis Auto Spa
SES_REPLY_TO=
SES_CONFIGURATION_SET=
SES_EVENTS_QUEUE_URL=                 # SES -> SNS -> SQS; backend polls (no public endpoint needed)

# --- Storage (photos, documents) ---
STORAGE_PROVIDER=fs                   # fs|s3
STORAGE_FS_ROOT=./.data/files
S3_BUCKET=
S3_REGION=
S3_PREFIX=oasis/
S3_PRESIGN_TTL_SECONDS=300
S3_MAX_UPLOAD_MB=15
```

### 3.2 Dashboard `.env.example`

```ini
API_ORIGIN=http://localhost:4000        # Next rewrites /api/* and /events to this: first-party cookies, no CORS
NEXT_PUBLIC_APP_ENV=development
OASIS_BACKEND_PATH=../backend           # gen:api source
PARITY_VIEWPORT_CC=1480x1000
PARITY_VIEWPORT_PAY=1480x1000
PARITY_VIEWPORT_SET=1480x1000
PARITY_FIXED_NOW=2026-06-13T10:36:00-04:00
PARITY_TZ=America/New_York
PARITY_LOCALE=en-US
```

Viewports for pay and set are our choice (the designs only give 1480x1000 for Operations). Use 1480x1000 for all and record this as an ADR.

---

## 4. Milestone plan

### 4.1 Dependency graph

```
M0 Bootstrap
 ├─► M1 Design import + compiler + harness (dashboard) ───────────────┐
 ├─► M2 Backend foundations (schema core, auth, RBAC, libs, ports) ───┤
 └─► M6a-d adapters + simulators (need only the M0/M2-start port       │
        interfaces; independent of each other and of M1/M2 internals)  │
                                                                       ▼
                                   M3 Settings vertical (needs M1 + M2)
                                                                       │
                      ┌────────────────────────────────────────────────┤
                      ▼                                                ▼
        M4 Operations vertical                            M5 Payments vertical
        (needs M3; appointment schema is its first step)  (needs M3; needs appointment table from M4-step1,
                                                           so starts after that migration lands)
                      └────────────────────┬───────────────────────────┘
                                           ▼
                  M6e Wire real adapters into verticals (needs M4, M5, M6a-d)
                                           ▼
                  M7 Realtime, jobs, scheduled automation
                                           ▼
                  M8 Hardening, seed profiles, docs, acceptance
```

**Independent workstreams, safe to fan out in worktrees:**

| WS | Work | Can start when | Owns |
|---|---|---|---|
| WS-1a | Extractor: unpack the 3 bundles | after M0 | `tools/extract-design`, `design/extracted` |
| WS-1b | Compiler (parse5 to TSX) and DC shim | after WS-1a first output | `tools/dc-compiler`, `src/dc` |
| WS-1c | Parity harness | after WS-1a and Playwright | `tools/parity` |
| WS-2a | Backend repo, config, db runner, logger, errors, OpenAPI plumbing | after M0 | `src/platform`, `db/migrations` (first files) |
| WS-2b | Auth, sessions, RBAC engine, audit | after WS-2a schema stub | `src/modules/{auth,rbac}` |
| WS-2c | Money/time/ids libs plus property tests | after M0 | `src/platform/{money,time}` |
| WS-6a | Squarespace client, sync, simulator | after M0 (interfaces in `integrations/ports`) | `integrations/squarespace` |
| WS-6b | SMS Gate adapter, simulator, queue, opt-out | after M0 | `integrations/sms`, `modules/messaging` core |
| WS-6c | SES adapter and sim | after M0 | `integrations/email` |
| WS-6d | Storage fs and S3 adapters | after M0 | `integrations/storage` |
| WS-D | Docs generation from the reports | after M0 | `docs/*` |

Within M4 and M5 the UI ports are independent files (`screens/operations` vs `screens/payments`), so they parallelize. Their shared files are the app shell, the API client and `deviations.yaml`, which the orchestrator edits only.

**Shared-file hot spots** (orchestrator-only edits): `db/migrations` ordering, `docs/openapi.json`, the generated `src/data/api`, `design/deviations.yaml`, the root `package.json` dependency lists, and the route registry file.

### M0: Bootstrap

- **Deliverables.**
  - All §1 steps applied, with the bootstrap scripts committed.
  - Both repos scaffolded: package.json, tsconfig, eslint (flat config, a `no-restricted-globals` rule on `Date` and `Math.random` outside the time lib), prettier, `.nvmrc`, `.env.example`, a README, and `docs/` stubs.
  - The initial commits pushed.
  - The port interfaces written as `integrations/ports/*.ts`: `SmsProvider`, `EmailProvider`, `StorageProvider`, `CardProcessorSync`. This is what unblocks WS-6.
- **DoD.**
  - `node -v` is 22, `psql` connects, `pnpm check` is green on an empty skeleton in both repos, and Playwright screenshots a blank page.
  - `tailscale status` shows the host (or this is explicitly deferred with the exact user steps recorded).
  - `git push` works on both repos.
- **Tests.** Only a skeleton smoke test plus `scripts/bootstrap/verify.sh`, which asserts every §1 verify command.
- **Demo.** `verify.sh` prints all green. Playwright renders an extracted original bundle screenshot once WS-1a lands.
- **Why first.** Everything else needs the toolchain, and the ports must exist before adapters can be built in parallel.

### M1: Design import, compiler and parity harness (dashboard)

- **Deliverables.**
  1. **Extractor.**
     - Reads the three bundles and decodes the `__bundler/template` JSON.
     - Writes `design/extracted/<screen>/template.html` (the serialised `x-dc.innerHTML`, which is what the runtime sees), `logic.js` (the `DCLogic` class), the 9 woff2 fonts per design, and the helmet CSS split into fonts CSS and global CSS.
     - Strips the "Made with Claude Design" badge.
     - Records `data-props`.
  2. **Compiler.** The algorithm in the runtime report §4:
     - `parse5.parseFragment` on the exact template string.
     - `sc-if`/`sc-for` with a scope stack.
     - Text emitted as `{"…"}` literals, keeping whitespace-only nodes that contain a space.
     - `interp()` wrapper spans (172/56/106 per screen).
     - Style strings parsed at build time in source order (`cssToObj`).
     - `value`/`checked` defaulting.
     - The SVG attribute renames.
     - `ref`, `data-drop` and href-to-route rewriting.
     - Fragment keys by index.
     - The `sc-camel-*` decode table.
     - Outputs `src/generated/{cc,pay,set}.tsx`, which are committed and never hand-edited.
  3. **Shim.** `DCHost` extends `React.Component`, with the same sync `setState` semantics as `DCLogic`.
     - `this.state` is updated immediately, then a React bump re-renders.
     - Lifecycle hooks are forwarded in try/catch.
     - A logic error renders the `sc-logic-error` box.
     - The shim is marked `'use client'`.
  4. **Global CSS and fonts.** `design/extracted/*/global.css` becomes a single `globals.css`, verbatim, with `@font-face` `src` pointing at `/fonts/*.woff2` and unchanged family names. `data-theme` lives on `<html>`.
  5. **Logic classes** copied verbatim into `src/screens/*/logic.ts`, still running on in-class fixtures. This is the "mechanical baseline".
  6. **Parity harness**, per §5.
  7. **App shell.** Next routes, the minimal login page (D4), and the top-bar nav links, with theme toggle behaviour unchanged.
- **DoD.**
  - For all three screens, in baseline mode (verbatim logic with the original in-class fixtures), the DOM snapshot, computed-style and bounding-rect checks and the screenshot diff all pass at threshold zero for the initial render in light and dark themes.
  - The `renderVals()` diff between original and port is empty with functions stripped.
  - `compile:design` is deterministic: re-running yields no git diff.
- **Tests.** Compiler unit tests (every construct in the §1 reference table: whole-value versus mixed bindings, nested loops with repeated `as` names, `sc-if` inside `button`, `<input value+onInput>`, entities, non-ASCII glyphs). Parity as above.
- **Demo.** Three URLs, `/operations`, `/payments`, `/settings`, rendering visually identical to the originals side by side. A side-by-side diff report under `parity-reports/` with 0 differing pixels.
- **Why this order.** The compiler and harness are the foundation of the pixel-for-pixel requirement. Every later milestone just swaps the data source behind a screen the harness already verifies.
- **Risks.** The extractor and compiler depend on the original bundle format, which can only be spot-checked. Mitigation: test against all three bundles from day one.

### M2: Backend foundations

- **Deliverables.**
  - **Migration 0001 (core).**
    - `locations` (timezone, currency, `tax_rate_bp`, `invoice_seq`), `settings`.
    - `users`, `employees` (a user is an employee; `status` invited/active/inactive), `sessions`.
    - `roles`, `role_permissions` (27 permission keys as a seeded `permissions` table), `role_limits` (`refund|adjust|credit`, nullable meaning unlimited), `employee_roles`, `employee_permission_overrides` (allow/deny).
    - `audit_log`, `idempotency_keys`, `webhook_inbox`, `outbox`, `files`.
  - **Auth.**
    - Email and password via scrypt, httpOnly+Secure+SameSite=Lax cookie sessions with rotation, login rate limit with lockout backoff, logout, and `GET /api/me` (user, roles, effective permissions, limits).
    - CSRF defense: custom `X-Requested-With`/`Origin` check on mutations.
    - Invite and password-reset token flow (the SMS invite from the design, an email fallback via the Email port, and sim in dev).
  - **RBAC engine**, which is the single function `effective(employee)`:
    - Permissions are the union of the employee's roles.
    - `deny` overrides win over role grants, and `allow` overrides win over missing grants.
    - Limits are the highest across roles, with `null` winning.
    - An override `allow` with no role limit gets the default 25.
    - The Super-Admin "view as" is a header honored only for `super` and recorded in the audit log.
  - **Libs:** money (cents, half-up), time (business-tz helpers, `FIXED_NOW`), stable ids and ULIDs, and the invoice-number allocator.
  - **HTTP platform:** error shape (`{error:{code,message,details}}`) where `message` carries the design's toast text for guard violations (409/403/422), Zod validation, OpenAPI emission, request ids and structured logs, the SSE endpoint with a Postgres LISTEN/NOTIFY bus, and the pg-boss worker bootstrap.
  - **Test infrastructure:** template-DB cloning, factories, an HTTP inject helper, and the authz-matrix generator.
- **DoD.**
  - Login, logout, session expiry and `/me` all work.
  - The RBAC engine passes the full rule table in `cross §1.6` plus the Settings multi-role cases (Rafael: mgmt+acct, Sofia's `sched.override` allow).
  - `pnpm openapi` produces a valid spec, and the migration runner is idempotent from an empty DB.
- **Tests.**
  - RBAC unit tests are table-driven, including the 25 default, null-wins, deny-over-grant and the 27 keys.
  - Property tests: `taxCents` is monotone and half-up (`x.5` goes up), `total = sub + tax + tip`, and a division-free split.
  - Auth integration tests: cookie flags, brute-force limit, CSRF rejection.
- **Demo.** `curl` login, then `/api/me`, then a 403 from a route that requires a missing permission.
- **Why.** Every vertical needs identity, permissions, money and time. Defining the ports early lets M6 proceed in parallel.

### M3: Settings vertical

- **Backend deliverables.**
  - **Hours and booking rules**, with `PUT /api/settings/hours` validating `from < to` and the 30-minute grid. It also warns when employee schedules fall outside the new hours.
  - **Closures**, with real `affectedCount` and `POST /api/closures/preview`, and a uniqueness rule per date. Add a federal-holiday generator (all 11 US federal holidays with observed-date shift, as an ADR) plus an annual January job (wired in M7).
  - **Emergency closure state machine**, with history rows created on both close and reopen, an optional linked closure row (default: yes, tagged emergency), and the real affected-booking list. Notification fan-out is wired in M6e. Until then, messages go through the outbox with the sim provider.
  - **Employees**, covering invites, schedules, skills, per-person exceptions, statuses, and validation (unique email, phone to E.164, schedule inside business hours as a warning).
  - **Roles and permissions matrix**, with limit chip cycling stored per role/key and custom roles (the design's "Shift Lead" default name, but renamable server-side).
  - **Catalog:** packages and add-ons with stable `task_id`s on checklist tasks and a `catalog_version` for price snapshots (price and duration editable server-side since `set.services` says "pricing", even though the UI only edits tasks).
  - **VIP and arrival settings,** with VIP clients linked to customer records (a `customers.vip` flag, plus the settings list as a view).
  - All endpoints are permission-gated: `set.hours`, `set.emergency`, `set.services`, `team.edit`, `team.roles`, `cli.member`.
- **Dashboard deliverables.**
  - Settings screen wired to the API.
  - The `oasis-roles`, `-hours`, `-closures`, `-emergency`, `-checklists` and `-vip` localStorage reads and writes are replaced by API calls.
  - The fabricated values are replaced: affected counts from `/closures/preview`, `TODAY` from the server, `emRebooked` from real data, and the idle banner counts ("6 appointments left today, 3 vehicles on site") from real data (D2).
  - Persistence for the items the prototype never saved (booking rules, the federal-holiday toggle, employees, emergency history).
  - The Save/Discard bar is preserved on hours only, as designed.
  - 403 toasts follow D4.
- **DoD.**
  - Every Settings action works against a real DB and survives reload.
  - Parity for Settings passes in fixture mode across every section and interaction script, in both themes (every section nav, hours editor, add closure, emergency flow, employee drawer, roles matrix, VIP, arrival, packages).
  - The effective-permission display in the employee drawer matches the engine exactly.
- **Tests.**
  - API tests for every endpoint including authz (matrix entries for each `set.*`/`team.*` route).
  - Closure and emergency integration tests that create appointments and verify counts.
  - Contract test: the generated client typechecks against the dashboard.
  - The parity interaction script for Settings.
- **Demo.** Change Saturday hours, add a closure, add an employee with an exception, change a refund limit chip, edit a checklist task. Reload and see everything persisted. Log in as a Crew user and see the 403 toast on a restricted action.
- **Why Settings first.**
  - It is the data root for the others.
  - It is the lowest-risk screen to prove the full stack.
  - Roles and limits are needed by Payments.
  - Hours, closures, catalog and VIP are needed by Operations.

### M4: Operations vertical

- **Backend deliverables.**
  - **Step 1 (first, so M5 can start): migration for the domain core.**
    - `customers` (E.164 unique phone, `sms_opt_in`, VIP flag, notes, special instructions) and `vehicles`.
    - `bays` (seeded: Bay 1 and Bay 2).
    - `appointments` with `status` enum (booked, confirmed, arrived, cleaning, completed, canceled, noshow), `bay_id`, `scheduled_start`/`end` `timestamptz`, `estimated_duration`, `source`, `late` (derived), `pickup`, deposit, and a `tip_cents`.
    - `appointment_addons` (price snapshot).
    - `checklist_items` (snapshotted from templates at booking, with stable task ids and completed_by/at).
    - `appointment_status_history`, `photos`, `messages` and `conversations`, and `activity_log`.
    - An exclusion constraint on `bay_id` + time range for `cleaning` occupancy.
  - **Pricing function** (shared with Payments): `price(appointment) = sum(lines) - adjustments`, with tax and tip per the money lib. Operations shows cents only when an amount is not whole. Membership discount perks stay display-only (default §6.3).
  - **State machine** with explicit guards (the design's toasts as error messages), the transitions table from cc-domain §2.1, and the legal side effects (log row, outbound SMS template, toast copy).
  - **Commands from cc-domain §4:** advance, assign bay, reschedule, pickup, add/remove add-on (price from catalog, not client), checklist toggle and bulk, send message, photos (presigned upload to the Storage port), prep bay, arrival ingest, create appointment/walk-in, cancel/no-show, notify ready, and membership-credit redeem.
  - **Availability** (`GET /api/availability?date&packageId&vip`), which combines hours, closures, emergency pause, booking rules (slot, buffer, cutoff applied to the start time by default), bay capacity, VIP holds and release, and staff schedules. It replaces the hard-coded `slotTimes`/`blocked`/`vipHeld`. This is the contract the customer app and online booking will consume.
  - **Read models.**
    - Board (timeline, bays, staff, calendar day/week/month) and the 7 KPIs, computed in the business tz: "booked" count and "Bay time free" from open-window minus bay occupancy.
    - Modal read model (overview, checklist, add-ons, photos, messages, invoice rows, membership, history with real visit count, lifetime spend and average cadence).
    - Alerts generated server-side (the cc-domain §3.9 rules, with a defined late rule: `now > start + grace(10m)` with no arrival, auto-clearing).
  - **Arrival and geofence ingest:** `POST /api/appointments/:id/arrive` (manual, `source` field), plus a signed device-ingest endpoint for the future customer app that applies `arrival.radius`/`prepAt` thresholds.
  - **Reschedule links:** a token endpoint (`/api/r/:code`) stubbed for the customer app. The short-link domain is a config value (`oasis.spa` is a placeholder).
  - **SSE events:** appointment changed, bay changed, inbound message, arrival and alert changes.
- **Dashboard deliverables.**
  - Operations screen wired.
  - The DCLogic class is kept, with in-class fixture builders replaced by a store hydrated from the read-model endpoints.
  - `NOW`, `BASE`, `dateLabel`, the `genDay` RNG, `visits*148`, `avgFreq`, the hard-coded renewal date, `Visa ···· 4421`, and the "Rafael M." user all become server data (D2).
  - The toggle toast bug is fixed (D3).
  - The 1 s tick is retained, now computing elapsed time from server `startedAt`.
  - Optimistic updates with server reconciliation, and 409 errors shown as the design's toast text.
  - WhatsApp becomes SMS (D1), including the "WhatsApp opted-in" field, template labels, and "Delivered via SMS".
- **DoD.**
  - Every cc-domain §4 command has an end-to-end test, and the parity scripts pass (timeline, bay board, staff, calendar day/week/month, modal tabs, new-appointment drawer, drag-to-bay, keyboard shortcuts, theme).
  - Two browsers see each other's changes within 2 s via SSE.
- **Tests.**
  - State-machine table tests.
  - Availability property tests (no booking can overlap beyond bay capacity, cutoff, closures, and the weekday-0 indexing).
  - Gesture parity driven by Playwright pointer events (380 ms long-press, 6 px drag threshold, 90 px swipe commit).
  - KPI reconciliation against raw SQL.
- **Demo.** Book a customer, confirm, mark arrived (simulated geofence), drag to Bay 1, tick checklist items, add an add-on, complete, collect payment (hand-off to M5's collect path).
- **Risks.** Largest UI, and the biggest source of design ambiguity (see cc-domain §8).

### M5: Payments vertical

- **Backend deliverables.**
  - **Invoice issuance (default, §6.3):** one invoice per appointment, issued (numbered, gap-free from a per-location counter in the same transaction) at the first of deposit, payment, start-cleaning, or completion. The numbering format is `INV-NNNNN`, starting after the seeded range. Line items are price snapshots. The invoice becomes immutable except through ledger events.
  - **Append-only ledger** with event types `pay`, `adjust`, `refund_request`, `refund_decision`, `credit_issue`, `credit_apply`, `squarespace_sync`.
    - A DB trigger rejects UPDATE and DELETE on `ledger_events`.
    - "Pending" is derived from the latest decision event, so nothing is mutated in place.
    - Each event stores the actor, a role snapshot, the approver, the reason and the note.
  - **Exact formulas from pay-domain §2** reimplemented in integer cents (`calc`, status derivation in the exact order, KPIs, chart bucketing, by-method, filters, search and sort), plus validation vectors: the 105 invoices of pay-domain §6.4 become golden tests, with the duplicate-ID collision fixed by renumbering (A1).
  - **Commands from pay-domain §5.2:** refund (full, by item, custom), approve, deny, adjust (discount or surcharge, % or $), issue credit, apply credit, collect payment, send payment link, send receipt, and CSV export.
  - **Governance fixes (D3), recorded as ADRs:** approver must hold `pay.refund` and a limit at least the amount, the requester cannot approve their own request (unless they are Super Admin with no limit and there is only one approver), approval re-validates `refundable` and `toOrigMax`, and deny requires `pay.refund`. Over-limit adjust and credit stay hard-blocked, as designed.
  - **Store credit** keyed by `customer_id`, with real expiry, FIFO consumption by earliest expiry, and expired entries leaving the balance.
  - **Squarespace-aware states.** A card payment or card refund recorded in Oasis is created with `processor_status = awaiting_squarespace`. The ledger event exists immediately (Oasis owns the ledger), and the invoice shows the existing "Refund pending" or an amber pending pill until either (a) staff click a confirmation, or (b) the M6a sync matches a payment or refund in the Squarespace Transactions feed, which then flips the event to `confirmed` with the processor reference. Cash and store-credit events are `confirmed` immediately. Revenue KPIs count `awaiting_squarespace` events, with an `unconfirmed` count shown only in an API field (no new UI).
  - **Payment link.** There is no Squarespace API for creating a link, so the "Payment link" collect option attaches a staff-managed link: the config-driven `SQSP_CHECKOUT_LINK_TEMPLATE`, a per-invoice reference token (`OAS-INV-20608`) appended as a query parameter, or a note-matching convention. It is sent by SMS. No ledger event is created until the sync finds the matching order, matched by invoice reference, then customer email, then amount and time window. Unmatched Squarespace orders land in a `reconciliation_queue` table for a future UI (API-only for now).
  - **Card on file.** Derived from the latest Squarespace transaction's card brand and last4 when present, else shown as "Card on file · managed in Squarespace". The hard-coded `Visa ••4421` is gone (D2).
  - **Membership** (display and entitlement only in this milestone): `memberships` rows keyed to a Squarespace subscription id and tier, status from subscription orders. Credits and perks per the defaults in §6.3. The full sync lands in M6a.
  - **Reports:** `pay.reports` gating, CSV with the proposed columns (UTF-8 with BOM, RFC 4180, money as plain decimals), asynchronous for large ranges and synchronous otherwise.
- **Dashboard deliverables.**
  - Payments screen wired.
  - `by:'Rafael M.'` becomes the real actor.
  - The "Preview as" menu becomes the Super-Admin "View as" (it uses the existing menu element), and for everyone else it is hidden.
  - Error and locked states per the design.
  - The tax display and the U+2212 minus sign are preserved.
  - Fabricated values are replaced: range labels derive from the server date (D2), and event timestamps are real instants formatted as "Today h:mm AM / Yesterday / Mon D".
- **DoD.**
  - Golden-vector tests pass to the cent.
  - Parity scripts pass in fixture mode (filters, ranges, sheets for refund/adjust/credit/collect, amount inputs, role menu locked and unlocked).
  - No UPDATE is possible on ledger rows (trigger test).
  - Approval flows work with two real users.
- **Tests.**
  - Property tests: the sum of ledger events equals invoice state, `refundable >= 0`, `toOrigMax` respected, half-up tax, and idempotent replays of the same command with the same key.
  - Concurrency test: two simultaneous refunds on one invoice (row lock serializes).
  - Authz matrix for `pay.*`.
  - Squarespace-sim end-to-end: record a card payment, see it `awaiting_squarespace`, run sync, see it `confirmed`.
- **Demo.** Collect cash and a simulated card payment. Request an over-limit refund as Support, approve as Management, and watch the Squarespace-simulator confirm it. Export a CSV.
- **Why after M4 step 1.** Invoices need appointments, customers and the catalog.

### M6: Integrations (adapters, then wiring)

Sub-milestones 6a to 6d are independent and start right after M0. 6e wires them into the verticals after M4/M5.

**M6a: Squarespace (WS-6a).**
- **Client.** Typed wrapper over Orders (list with `modifiedAfter/Before` and cursor, including subscription orders and payment states), Transactions (read-only, per-payment refunds and card brand), and Profiles. Use the API key first. Handle 429 with `Retry-After` and backoff.
- **Sync engine (pg-boss).**
  - Cursor-based incremental polling every `SQSP_POLL_INTERVAL_SECONDS`.
  - Idempotent upserts into `sqsp_orders`, `sqsp_transactions` and `sqsp_profiles`, with raw JSON retained.
  - Matcher that links to invoices, customers and memberships, and flips ledger events from `awaiting_squarespace` to `confirmed`.
  - Refund detection: a refund appearing in the Transactions feed confirms a pending card refund or creates a "processor-originated refund" ledger event when staff refunded directly in Squarespace.
- **Memberships:**
  - Squarespace subscription products map to Oasis tiers through a DB table `membership_product_map`, seeded from `SQSP_TIER_PRODUCT_MAP`.
  - Subscription orders and webhooks drive membership status, renewal date and credits.
  - Credits per cycle follow the defaults in §6.3.
- **Webhooks.** If a verified OAuth path exists, `POST /webhooks/squarespace` verifies the signature (HMAC with the subscription secret, constant-time compare, timestamp window), writes to `webhook_inbox` (dedupe on notification id) and enqueues a sync. Polling stays on regardless.
- **Verify before building (research tasks for WS-6a, recorded as ADR 0006):**
  1. Whether the Orders and Transactions endpoints are available with a plain API key on the user's plan. Squarespace documents API keys as available on certain Commerce plans.
  2. Whether Webhook Subscriptions require OAuth (the working assumption is yes), and what approval an OAuth app needs for a single-site private integration.
  3. Exactly which fields subscription orders expose.
  4. Whether card brand and last4 appear on transactions.
  5. Rate limits.
- **Explicit gaps and fallbacks.**

| Capability the user asked for | What the Squarespace Commerce APIs allow | What Oasis does | Fallback or later option |
|---|---|---|---|
| Charge a card | Not possible | Staff take payment in Squarespace (checkout or Squarespace's own tools). Oasis records the event as `awaiting_squarespace` and confirms from the Transactions feed. | Connect the user's own Stripe account to Squarespace and use Stripe's API for charges. This would be a future `CardProcessorSync` implementation, not the plan. |
| Issue a refund | Not possible | Oasis records the refund request, runs the approval and limits, then flags "complete in Squarespace". It is confirmed by staff or by the refund appearing in the feed. | Stripe API refunds (same Stripe-connect option). |
| Payment link or invoice link | Not creatable | Staff-managed link template plus reference token, sent by SMS. Matched on the order. | Stripe Payment Links, or Squarespace invoicing done manually. |
| Saved card or card on file | Not exposed | Brand and last4 derived from the latest transaction when available, else "managed in Squarespace". | Stripe customers and saved payment methods. |
| Membership billing | Subscription orders and webhooks are readable. Billing management is not. | Read-only sync drives status, renewal and credits. Plan changes and cancellations stay in Squarespace. | Stripe Billing. |
| Member Areas billing | Not exposed | Out of scope | Revisit if the user sells memberships through Member Areas instead of subscription products |

**M6b: SMS Gate (WS-6b).**
- **`SmsProvider` interface:** `send(message) -> {providerMessageId}`, `health()`, `registerWebhooks()`, and a normalized `InboundEvent` type. A `sim` provider and the `smsgate` adapter both implement it.
- **Adapter.**
  - `POST {SMSGATE_DEVICE_URL}{SMSGATE_API_PATH}` with Basic auth.
  - Our `sms_outbox.id` is passed as the SMS Gate message id, so retries cannot duplicate.
  - SIM slot is selectable.
  - The exact local-server path and body are confirmed against the installed app's built-in docs (`SMSGATE_API_PATH` is configurable for that reason).
- **Outbound queue** (`sms_outbox`): states `queued, sending, sent, delivered, failed, undeliverable, suppressed`. Concurrency is 1 per device.
  - Token-bucket rate limit (`SMSGATE_RATE_PER_MINUTE`, default 12).
  - Retries with exponential backoff on network and 5xx errors only (not on a 4xx).
  - The segment counter handles GSM-7 versus UCS-2 and strips or replaces emoji (the design's review-request star forces UCS-2).
  - A quiet-hours hold for automated non-urgent sends, and per-message priority (transactional bypasses the hold).
- **Inbound webhooks** at `POST /webhooks/smsgate` (served over the tailnet through `tailscale serve`).
  - Verify `X-Signature` as HMAC-SHA256 over the raw body plus `X-Timestamp` using `SMSGATE_WEBHOOK_SECRET`.
  - Constant-time compare, with a ±5 minute skew window.
  - Dedupe on `(deviceId, messageId, event)` in `webhook_inbox`.
  - Enqueue and return 2xx immediately (far under the device's 30 s limit).
  - The device retries with exponential backoff, default 14 tries, so handlers must be idempotent.
  - Events handled: `sms:received`, `sms:sent`, `sms:delivered`, `sms:failed`, `system:ping`, `app:started`.
- **Opt-out lives in Oasis.**
  - `sms_consents` keyed by E.164 phone, with source and timestamp.
  - Inbound `STOP`, `STOPALL`, `UNSUBSCRIBE`, `CANCEL`, `END`, `QUIT` set opted-out.
  - `START`, `YES`, `UNSTOP` set opted-in.
  - `HELP` gets an auto-reply.
  - STOP is honored for all categories, including transactional.
  - The per-customer `sms_opt_in` flag replaces "WhatsApp opted-in" and mirrors this table. Sending to an opted-out number produces a `suppressed` outbox row, never a device call.
  - The reply `C` to a reminder confirms the appointment.
- **Device health.**
  - `sms_devices` holds `last_seen_at` (updated by `system:ping`/`app:started` and by a 60 s active `GET` on the device through the tailnet), battery if exposed, and `status` online, degraded or offline.
  - Offline for longer than `SMSGATE_HEARTBEAT_STALE_SECONDS` raises an email alert to Super Admins (SES) and a warning in `GET /api/system/health`.
  - Messages queue while offline and flush on recovery, with an expiry per message class (a "you're checked in" message expires after 15 minutes rather than arriving late).
  - There is no new dashboard chrome (D4/D5 policy). Failed sends show in the conversation as the design's existing message status.
- **Simulator (`pnpm sim:smsgate`).** Emulates the device API (auth, `/messages`, `/webhooks` registration, health) and a controllable console to inject inbound texts, delivery receipts, failures, an outage, and out-of-order or duplicate webhooks. Contract tests run against both the simulator and recorded real payloads from the device once available.
- **Tablet and tailnet runbook:**
  - Keep the tablet plugged in, disable battery optimization for SMS Gate and Tailscale, enable Always-on VPN for Tailscale, and set Wi-Fi to stay on during sleep.
  - Use a dedicated SIM and a number the shop publishes.
  - Set the signing key and username/password in the app.
  - The backend registers webhooks idempotently (fixed webhook ids) at boot and on a schedule.
  - Re-registration on `app:started`.

**M6c: SES (WS-6c).** `EmailProvider` with SES v2 `SendEmail`, templated plain HTML and text parts (receipts, invites, password reset, device alerts). SES events (bounces, complaints, deliveries) flow SES to SNS to SQS and are polled by a job, so no public endpoint is required. Bounced addresses are suppressed. The sim provider writes to an `email_outbox` table and `.data/mail/*.eml` for inspection.

**M6d: Storage (WS-6d).** `StorageProvider` with `fs` (dev and sim) and `s3`. Private bucket only. Presigned PUT URLs with a content-type allow-list, `Content-Length` limit and a key prefix per appointment (`appointments/{id}/{category}/{ulid}`). Presigned GET with a short TTL for display. Thumbnails are generated client-side before upload (avoids native image libs). Metadata is stored in `photos` and `files`. Uploads are verified via `HEAD` before the DB row is committed.

**M6e: Wiring.** Replace the simulators with real adapters per template trigger (confirmation, reminder, check-in, in-progress, ready, receipt, reschedule, emergency, late nudge, staff invite). Run real-credential smoke tests behind `LIVE_*` env guards, and never in CI.

### M7: Realtime, jobs, scheduled automation

- **Deliverables.**
  - Full SSE event catalog and client reconnection with `Last-Event-ID` replay from the outbox.
  - pg-boss schedules:
    - Reminders, and the confirmation request 48 h before.
    - VIP-hold release at `slot - release`.
    - Late detection.
    - Waitlist offers with the `offerMin` timer.
    - Standing-appointment materialization and auto-confirm.
    - Auto-reopen at an emergency's `until` or `through` date.
    - Annual January federal-holiday insertion.
    - Membership cycle reset and renewal.
    - Store-credit expiry.
    - Review-request after completion.
    - Squarespace poll.
    - SMS device health poll.
    - Outbox retention.
  - The job dashboard is API-only (`GET /api/system/jobs`), with dead-letter alerts by email.
- **DoD.** Every job has an idempotency key, a test with `FIXED_NOW`, and a failure/retry test. SSE survives a server restart without losing events.
- **Why here.** It touches all verticals, so it is easier once they exist. The infrastructure (bus, boss bootstrap) was laid in M2.

### M8: Hardening, seed profiles, docs, acceptance

- **Deliverables.**
  - Three seed profiles:
    - `design`: replicates the frozen fixtures with the invoice-ID collisions fixed.
    - `demo`: realistic data relative to today (the day's appointments are generated around the current date).
    - `empty`: bootstrap admin only.
  - All docs from §2.4 complete.
  - Security pass (§5.6).
  - Performance pass (§5.7).
  - systemd user units and `loginctl enable-linger ec2-user` for `oasis-api`, `oasis-worker`, `oasis-dashboard` (production builds), logs to journald.
  - Nightly `pg_dump` to `~/backups` with 14-day retention (optional S3 upload).
  - A runbook.
  - The acceptance checklist (§5.8) executed and recorded.

---

## 5. Verification plan

### 5.1 Per-milestone gates

| Milestone | Gate (all must pass) |
|---|---|
| M0 | `verify.sh` green. `pnpm check` green in both repos. Push works. |
| M1 | Parity at zero for initial render of 3 screens x 2 themes (DOM, computed style, rects, pixels, `renderVals` diff). Compiler is deterministic. |
| M2 | RBAC table tests. Auth integration tests. Money property tests. OpenAPI valid. Migrations idempotent. |
| M3 | Settings API tests plus authz matrix. Settings parity script (all sections). Persistence-after-reload e2e. |
| M4 | State-machine and availability tests. Operations parity scripts. KPI SQL reconciliation. Two-browser SSE test. |
| M5 | Golden vectors (105 invoices). Ledger property and concurrency tests. Payments parity scripts. Trigger blocks UPDATE/DELETE. |
| M6 | Adapter contract tests on simulators. Webhook signature/replay tests. Opt-out tests. Live smoke tests gated and run once credentials exist. |
| M7 | Job tests with `FIXED_NOW`. SSE replay test. |
| M8 | Final acceptance checklist (§5.8). |

### 5.2 Visual-parity thresholds

- **Baseline for comparison:** the original bundle rendered offline with `page.clock.install({time: PARITY_FIXED_NOW})` then paused, `timezoneId: America/New_York`, `locale: en-US`, a fresh storage context, `animations: 'disabled'`, `document.fonts.ready` plus one frame, network blocked except localhost, branding badge hidden, and `FONTCONFIG_FILE` pinned.
- **Checks per state (in order):**
  1. DOM `outerHTML` of `#dc-root` equal after stripping `data-dc-tpl` and `data-sc-name`, with `style` attribute strings byte-equal. **Threshold: exact.**
  2. Computed style and `getBoundingClientRect` for every element. **Threshold: exact (0 px).**
  3. Screenshot diff with `pixelmatch` at threshold 0. **Threshold: 0 differing pixels in the baseline and fixture modes.** If antialiasing nondeterminism is ever observed on this box, the documented fallback is at most 0.01% of pixels with no more than 1 channel level of difference. It requires an ADR and is never used silently.
  4. `renderVals()` object diff with functions stripped. **Threshold: exact**, except for keys on the deviation allow-list.
- **Deviation handling.** Before diffing, the harness applies `design/deviations.yaml` to the original DOM: D1 text replacements ("WhatsApp" to "SMS" in the listed strings), then compares. D2 and D3 items are listed per field with the original and replacement values and have explicit unit tests. An unlisted difference fails the build.
- **Matrix, by screen:**
  - Operations: timeline, bay board, staff, calendar day/week/month, every range tab, search typing, the client-file modal and each of its tabs, new-appointment and walk-in drawer, drag-to-bay mid-gesture (ghost, drop cues), swipe states, toast, emergency banner, closed-day panel, and the empty states.
  - Payments: every range, every filter chip, the selected-invoice panel states (paid, unpaid, partially paid, refunded, canceled-refunded, partially refunded, refund pending), the four action sheets, the locked state for each role, and the toast.
  - Settings: all 8 sections, hours dirty and clean (Save/Discard bar), closure add form with and without a conflict warning, emergency idle and confirm dialog and active, employee drawer (every tab), roles matrix with a custom role, VIP, arrival, and packages/checklists.
  - Each in light and dark. Viewport 1480x1000.
- **Fixture mode.** Parity runs with the `design` seed profile and `FIXED_NOW`. Live-data screenshots are reviewed manually (the demo walkthrough), not diffed.

### 5.3 Backend suites

- **Unit** (vitest): money, time, RBAC, state machines, formula ports, SMS segmenting, STOP-keyword parsing, signature verification.
- **Integration** (real Postgres, template-cloned DBs): every route, transaction rollbacks, ledger immutability, availability, closures and emergency counts, sync matching.
- **Property tests** (fast-check): money and ledger invariants, availability never exceeds bay capacity, half-up rounding.
- **Golden vectors:** the 105 pay invoices, plus KPI and chart vectors, plus cc calendar day counts for the `design` seed.
- **Concurrency tests:** simultaneous refunds, simultaneous bay assignment (exclusion constraint), duplicate webhooks, duplicate `Idempotency-Key`.

### 5.4 Contract tests

- **API contract.** `pnpm openapi` output is diffed in CI-equivalent (`pnpm check`), and the dashboard typechecks against the regenerated client. Responses are validated against Zod in test.
- **Webhook contracts.** Recorded real SMS Gate payloads and Squarespace payloads (once available) are stored under `test/fixtures/recorded/` and replayed.
- **Adapter ports.** One shared contract suite runs against each provider implementation (`sim` and live-shape mocks).

### 5.5 Simulators and demo with real API data

- `sim:smsgate`, `sim:squarespace`, the fs storage adapter and the email file sink make a full demo possible with zero credentials.
- To demo with real API data:
  1. `pnpm seed --profile demo`.
  2. Start API, worker and dashboard.
  3. Log in as the bootstrap Super Admin.
  4. Run through the milestone demos.
  5. Switch providers one at a time to `smsgate`, `ses`, `s3` and `live` as credentials arrive, each gated by a smoke script that sends one SMS to a number the user supplies, sends one email to a verified address, round-trips one photo, and runs one Squarespace poll.

### 5.6 Security checks

- **Webhooks:**
  - HMAC verification with constant-time compare and a timestamp window.
  - Replay and duplicate rejection.
  - Wrong-signature and stale-timestamp tests.
  - Body size limit.
  - Raw-body capture.
  - Webhook routes are never reachable without a valid signature.
- **Authz matrix test.** The route registry enumerates every route and its required permission. For each route, the test runs a user without the permission (expect 403), without a session (expect 401), and with it (expect non-403). It also covers the Super-Admin "view as" boundary: only Super Admins can send the header, and it is audit-logged.
- **Sessions:** cookie flags (`HttpOnly`, `Secure` in prod, `SameSite=Lax`), rotation on login, revocation on password change, CSRF checks, and login throttling.
- **Data handling:** parameterized queries only (lint rule against string-built SQL), PII redaction in logs (phone, email, message text), presigned URL constraints (content type, size, key prefix, short TTL), secrets only from env, and a pre-commit secret scan.
- **Dependencies:** `pnpm audit` at M8 and on each dependency change, an install-script allow-list, and a lockfile committed.
- **SMS compliance:** STOP honored everywhere, HELP reply, consent log, and quiet-hours behavior (the US A2P and TCPA considerations are in the risk register).

### 5.7 Performance sanity (2 vCPU, 7.8 GB)

- Seed 20k appointments and 15k invoices.
- Targets on this box with `autocannon` (pure JS): board read-model p95 under 150 ms, `GET /api/payments/invoices` (page of 50) p95 under 150 ms, summary under 250 ms, availability for one day under 100 ms, a mutation under 100 ms, and 50 concurrent SSE clients under 10% CPU.
- Check for N+1 queries via query counting in tests, and look at `EXPLAIN` on the hot paths (trigram search, status filters, date ranges).
- `next build` must complete within the 3 GB heap with the swap fallback. Steady-state memory for API plus worker plus dashboard plus Postgres stays under 4 GB.
- Playwright runs with one worker.

### 5.8 Final acceptance checklist

1. `pnpm check` is green in both repos on a fresh clone plus `bootstrap` plus `migrate` plus `seed --profile design`.
2. Parity report: all screens, states and both themes at zero difference, with only the deviations listed in `deviations.yaml` present. The report is attached under `docs/parity-final.md`.
3. Authz matrix covers every route, and all pass. All 27 permission keys are enforced somewhere server-side or are documented as having no surface yet (`msg.auto`, `msg.broadcast`, `set.billing`, `cli.export`, `pay.void` per the design-gap list).
4. Money: the golden vectors pass to the cent. 7% half-up on cents. Tip untaxed. Operations shows cents only when needed.
5. Time: hours, holidays and "today" respect `America/New_York`. A DST-boundary test passes (March and November).
6. Ledger: UPDATE/DELETE on `ledger_events` is rejected, every money action is audited with actor and role, and the approval rules are enforced.
7. Squarespace: simulator end-to-end passes. With real credentials, one live poll syncs orders and transactions and matches at least one payment (if the user has test data). Every gap in the §M6a table is documented in the UI-adjacent docs and the runbook.
8. SMS: simulator end-to-end passes (send, delivered, failed, inbound, STOP and START, duplicate webhook, offline queue and flush). With the real tablet, one outbound SMS is delivered, one inbound reply is received through the HTTPS tailnet webhook, and one STOP is honored.
9. Email via SES sandbox sends one message to a verified address. Photos round-trip via S3 with presigned URLs.
10. Realtime: two sessions stay in sync, and SSE replay works after a restart.
11. Roles: a Crew account can do crew actions only and sees the correct 403 toasts. A Super Admin can use "View as" and it is audit-logged.
12. Docs: `design-spec.md` (both repos), `api-spec.md`, decisions log, `env.md`, integration guides and the runbook all exist and match the code.
13. Backup, restore and a systemd restart are exercised once.
14. The acceptance run is recorded in `docs/acceptance-YYYY-MM-DD.md`.

---

## 6. Risk register

Probability and impact use L/M/H.

| # | Risk | P | I | Mitigation |
|---|---|---|---|---|
| R1 | Squarespace API plan and credential limits. API keys may need a Commerce plan tier. Webhook Subscriptions likely need OAuth, and a private single-site OAuth app may need Squarespace approval. | M | H | Polling baseline needs only an API key. Webhooks are an optimization behind a flag. Verify plan, scopes and field availability in WS-6a before building (ADR 0006). Ask the user for the plan tier at the start (§6.1). |
| R2 | The designed money actions cannot execute through Squarespace (charge, refund, link, card on file, Member Areas billing). | H (certain) | H | Ledger-first design with `awaiting_squarespace` states, staff confirmation, feed-based confirmation, reconciliation queue, and the gap table in §M6a. Stripe-connect is a documented future adapter, not the plan. Set expectations with the user explicitly. |
| R3 | Matching Squarespace orders to Oasis invoices is heuristic. A mismatch could confirm the wrong event. | M | M | Reference token first, then email, then amount and time window. Confidence levels. Ambiguous matches go to the reconciliation queue, never auto-confirm. Audit every match. |
| R4 | SMS Gate single-device reliability: the tablet sleeps, loses network, runs out of battery, or the app is killed. | M | H | Heartbeat health, queue with per-class expiry, email alert, charger and battery-optimization runbook. The provider interface supports multiple devices, so a second tablet is a config change. |
| R5 | HTTPS requirement for non-localhost webhook targets. | M | M | Tailscale HTTPS certs via `tailscale serve` (needs MagicDNS and HTTPS certs enabled by the user). Verify from the tablet before building on it. If it fails, fall back to polling the device for incoming messages (if the app's API supports it) and document it. |
| R6 | Tailscale on EC2: DNS or MagicDNS conflicts, ACL mistakes, or the tablet losing the VPN. | M | M | Use tailnet IPs in config as a fallback to hostnames. ACL snippet in §1.3. Always-on VPN on the tablet. |
| R7 | Carrier filtering and US A2P 10DLC. Sending business traffic from a personal or consumer SIM can be throttled or blocked, and carriers may flag volume. | M | H | Conservative rate limit (12 per minute), opt-out honoring, no marketing blasts in v1, a short, identifiable template set, and a dedicated SIM. Document that a registered A2P campaign through a CPaaS is the long-term path, and that the `SmsProvider` interface keeps that swap cheap. Not a blocker for this phase. |
| R8 | SMS content: emoji or non-GSM characters double the segment cost, and "Reply C to confirm" needs inbound parsing. | M | L | Segment counter, emoji replacement, a tested inbound keyword parser. |
| R9 | arm64 Chromium or font nondeterminism on Amazon Linux. | M | M | Pinned Playwright, `PLAYWRIGHT_HOST_PLATFORM_OVERRIDE` fallback, committed fallback fonts and `fonts.conf`, fixed flags. An ADR-gated tolerance is the last resort. |
| R10 | React 18 and Next 14.2 pin. Next 14 is not the latest line, so security patch cadence needs watching, and React 19 changes ref and attribute behavior. | M | M | ADR 0009. Run `pnpm audit` and track Next 14.2 patches. The parity suite is the migration safety net if the stack is moved later. |
| R11 | Scope size. Three large screens, a full backend and four integrations. | H | H | Vertical slices, parallel worktrees, parity and golden tests as definitions of done, and a deviations manifest to stop scope creep. Cut line if needed: M7 scheduled jobs beyond reminders and late detection, and CSV async. |
| R12 | Fabricated design data hides real rules, such as KPI formulas, late rule, membership credits and capacity. | H | M | Defaults in §6.3 recorded as ADRs and covered by tests. Replacements flagged as D2 in `deviations.yaml`. |
| R13 | Design ambiguities and internal contradictions (Support has refund limits but no `pay.reports`; Settings and Payments permission defaults differ slightly; the closure and emergency semantics; the cc/pay tax rounding difference). | H | M | The default table in §6.3. The five truly blocking decisions are in §6.1. |
| R14 | The compiler and shim miss a runtime semantic (synchronous `setState`, key behavior, `sc-interp` spans, whitespace nodes, controlled inputs with only `onInput`). | M | H | The mechanical port approach, DOM-snapshot equality from day one, and the `renderVals` diff. |
| R15 | Gesture fidelity (drag, swipe, long-press) is hard to test on a headless box. | M | M | Playwright pointer-event scripts at the exact thresholds from the cc-ui report. Manual verification on a touch device by the user before acceptance (not a blocker for desktop-first). |
| R16 | Ledger correctness under concurrency, and the approval governance changes (D3) the user may not expect. | M | H | Row locks, append-only trigger, property tests, ADRs for each governance change, and a demo of each. |
| R17 | 7.8 GB RAM. `next build`, Postgres and Chromium together could OOM. | M | M | Swap file, heap caps, one Playwright worker, and builds run sequentially. |
| R18 | SES sandbox limits (verified recipients only) and domain verification delays. | M | L | The sim provider covers development. Request production access early (§6.1). |
| R19 | Public versus tailnet-only exposure of the dashboard is undecided, which affects cookies, certs and Squarespace webhooks. | M | M | Dashboard proxies `/api` through Next rewrites, so cookies are first-party in either case. Decision requested at M3 (§6.1). |
| R20 | Dead code in the design that users may expect to work (void flow, `msg.*` surfaces, billing screen, standing appointments UI). | M | L | Documented as "enforced server-side, no UI in the design" in the acceptance list. No UI is invented (D4 limits additions). |

---

## 6. Items required from the user, defaults for open questions, and sizing

### 6.1 Needed from the user, with timing

**Decisions needed before work starts (blocking or shaping the first milestones):**

1. **Squarespace account facts.**
   - Which plan is the site on (determines API key availability)?
   - Are memberships sold as Squarespace subscription products (readable) or via Member Areas (not readable)?
   - Does the user already have an API key or want to create one?
   - Needed at M0 to start the verification in WS-6a, and a key at M6a.
2. **Permission to install system software on this box**, including Tailscale and the swap file. Needed at M0.
3. **Confirm the deploy keys have write access** to both repos. Needed at M0.
4. **Confirm the default stack deviation: Next 14.2 and React 18.3.1** (recommended, ADR 0009). Needed at M1.
5. **How staff will reach the dashboard:** public domain, or tailnet only (needs staff devices on the tailnet). Not blocking until M3, but it shapes cookies, TLS and Squarespace webhooks.

**Credentials and accounts, by milestone:**

| Item | Needed at | Used for |
|---|---|---|
| Tailscale login approval (or reusable tagged auth key); MagicDNS and HTTPS certs enabled; ACL tags | M0 or M6b | Host on tailnet, webhook HTTPS cert |
| Tablet with SMS Gate and Tailscale installed, local server enabled; device URL, username, password, signing key, SIM slot | M6b (live demo at M6e) | Real SMS |
| A phone number to receive test SMS | M6e | Smoke tests |
| AWS IAM user or role with SES send and SQS receive on one queue, S3 on one bucket; region | M6c, M6d | Email and photos |
| SES verified sender (domain preferred) and a request to leave the sandbox | M6c (production access takes days, so ask early) | Receipts, invites, alerts |
| S3 bucket (private, block public access) | M6d | Photos |
| Squarespace API key (and OAuth app details if webhooks are wanted); a few test orders and a test subscription product | M6a | Sync |
| Squarespace product ids or names for each membership tier | M6a | Tier mapping |
| Checkout/invoice link template for the "payment link" | M5 | Payment links |
| Shop phone number, address and coordinates | M4 and M7 | Geofence thresholds and welcome messages |
| Domain for the dashboard/API, and a short-link domain for reschedule links (placeholder `oasis.spa`) | M8 | Production URLs |
| Real staff list, roles and sample catalog edits | M3 | Seed/real data |

### 6.2 What the user does not need to decide now

Everything in §6.3 has a recommended default and will proceed unless the user objects.

### 6.3 Recommended defaults for the open questions

(Cross §7 plus the ambiguities in the domain reports. Each default is recorded as an ADR.)

| Topic | Default |
|---|---|
| Invoice creation | One invoice per appointment, issued at the first of deposit, payment, start-cleaning or completion; gap-free `INV-NNNNN` sequence from a counter row (A1/cross #2). |
| Invoice ID collisions in seed | Renumber the generated history; keep the explicit fixtures' ids. |
| Tax and tip | 7% stored as `tax_rate_bp=700`, half-up to the cent. Tip untaxed and not part of net revenue. Tip refundable only via a "full" refund. |
| Operations money display | Show cents only when the amount is not whole. |
| "Revenue today" (cc) vs "Net revenue" (pay) | Both computed server-side from the ledger. Document the difference in the KPI tooltips only if the design has them (no new UI). |
| Pending vs Outstanding (today) | Operations "Pending payments" = unpaid balances of today's appointments (estimated where no invoice exists). Payments "Outstanding" = open invoice balances. Two labeled computations. |
| Refund over limit | Pending approval (as designed). Adjust and credit over limit are hard-blocked (as designed). |
| Approval governance | Approver needs `pay.refund` and a sufficient limit. Requester cannot self-approve. Re-validate at approval. Deny requires `pay.refund`. Multiple pending refunds all appear, though the banner still describes the first. |
| Support role and Payments | Support keeps its permissions. A user without `pay.reports` sees the locked state (as designed). No new Payments entry point for Support. Flag to the user as a design gap. |
| Roles | Role identity by id. Only `super` has the default-unlimited rule. Custom roles are renamable. Removing a role cleans its overrides. Employees may not be left with zero roles. |
| Limits semantics | Per transaction, not cumulative. |
| Money-limit default | 25 when unspecified. |
| `pay.void` | Seeded and enforced when a void flow exists. No flow in this phase. |
| Permissions with no UI (`msg.auto`, `msg.broadcast`, `set.billing`, `cli.export`) | Seeded, role-assignable, enforced on the API when the related endpoints exist. |
| Time zone | `America/New_York`, a settings value. Design date 2026-06-13 is fixture-only. |
| Cutoff semantics | "Last booking before close" applies to the start time. A job may finish after closing only if its duration fits (conservative: the end must be at or before close). Record as an ADR and flag it. |
| Slot, buffer, bays | Capacity = number of bays (2). Buffer applies between jobs on the same bay. The bay is advisory at booking and fixed on start-cleaning. `sched.override` can book into a blocked slot with a reason. |
| Start Cleaning without a bay | Auto-pick a free bay. If none, 409 with the design's overbook message (overridable with `sched.override`). |
| Late rule | `now > start + 10 min` with no arrival logged. Auto-clears on arrival or reschedule. |
| "Arriving soon" | ETA at or below 15 min, using `arrival.prepAt` (the setting wins over the hard-coded 15). |
| Emergency closure | Creates a closure row tagged emergency, pauses online booking, builds the affected list from real bookings, and notifies via SMS (with email fallback for customers who opted out of SMS is NOT sent: STOP is honored, so email is only used if the customer has an email and prior consent). Auto-reopen at `until` or after `through`. "Protect member credits" means a missed visit during the closure does not consume a credit. |
| Partial-day closures and the Feb outage fixture | Supported as `reduced` closures. |
| Federal holidays | All 11 US federal holidays, with observed-date shift, "closed" by default, added every January when the toggle is on. Existing closures can be edited (type and hours). Past closures are read-only. |
| Closure notify toggle | The toggle controls the pending send. Toggling later never retracts a sent message. Reopen or removal notifies only if the toggle is on. |
| Catalog management | Price and duration editable server-side (permission `set.services`). Create, retire and rename packages and add-ons allowed server-side, UI only edits tasks (as designed). "Final inspection" stays removed. Add-ons have no duration. |
| Checklist keys | Stable `task_id`s, snapshotted at booking. Renaming a task never orphans checks. Completion is not mandatory before "Mark Complete" (no gate in the design). |
| Membership | Tiers Essential, Premium, Executive, Exotic, mapped from Squarespace subscription products. "Premium Care" is normalized to Premium. Credits per cycle follow the design (1 left, unlimited for Executive and Exotic). Percent-off perks are display-only in this phase (no invoice discount). Retention flags computed from real visit history. Renewal date from the subscription order. |
| Store credit vs member credit | Separate concepts and tables. |
| VIP | A customer attribute linked to records. Aisha Rahman is VIP in the `design` seed because Settings says so (cc has no flag, so the seed sets it). VIP holds and thresholds are read from Settings. |
| Customer identity | `customer_id` (E.164 phone unique, optional email). Vehicles unique by plate per customer. Credit and VIP join by id, never by name. |
| Staff display names | "First L." derived, with a collision suffix. Operations staff columns come from active crew employees plus "Unassigned". |
| Employee pay data | Stored, no payroll. |
| Hours Save/Discard | Preserved on Hours only. Booking rules ride in the hours save (single transaction). |
| Cadence options | Weekly, every 2 weeks, every 3 weeks, monthly (four options available, three offered by default). |
| Geofence | Shop coordinates from Settings (a field added server-side, no new UI: set via API or seed). ETA from the customer app. |
| Photos | Max 15 MB, JPEG/PNG/HEIC allowed, retained for 24 months. Category from the design (arrival, before, after, issue). |
| Retention | Messages 24 months, audit log indefinitely, webhook inbox 30 days. |
| Notifications to crew | Push notifications are out of scope. In-app via SSE only, and the toggle is stored. |
| CSV | The proposed column set, UTF-8 with BOM, one row per invoice, with the range and filter from the screen. A second ledger-events export is available through the API. |
| Receipts | SMS plus email (the design says "WhatsApp and email"). Resend limited to 3 per invoice, audited. |
| Seed | The `design` profile reproduces the fixtures for demos and parity. |
| Persistence of previously unsaved Settings | All persisted. |
| Payment methods | Enum (card with brand/last4, wallet, cash, store_credit, link). |
| Cash refunds | Allowed, and counted against the original-payment cap as in the design. The over-cap message names the actual original method (D3). |
| Canceled invoices | Excluded from gross sales (D3) and flagged. |

### 6.4 Sizing

| Milestone | Size | Notes |
|---|---|---|
| M0 Bootstrap | S | Mostly automation. Tailscale and tablet are user-paced. |
| M1 Design import, compiler, harness | XL | Highest leverage and highest unknowns. |
| M2 Backend foundations | L | |
| M3 Settings vertical | L | Many small endpoints, one big RBAC surface. |
| M4 Operations vertical | XL | Largest UI and most ambiguity. |
| M5 Payments vertical | L | Heavy domain math, but well specified. |
| M6a Squarespace | L | Research-dependent. |
| M6b SMS Gate | L | Queue, opt-out and simulator. |
| M6c SES, M6d storage | S each | |
| M6e Wiring | M | |
| M7 Realtime and jobs | M | |
| M8 Hardening, seed, docs, acceptance | M | |

### 6.5 Suggested first working session

**Goal: leave the box fully provisioned, both repos scaffolded and pushed, and the first screen provably pixel-identical.**

1. **M0 in full** (about an hour of agent time): packages, Postgres, fonts, Playwright, repo scaffolds and the port interfaces, `verify.sh`, and the first pushes. Start Tailscale install and print the login URL for the user (or use an auth key if supplied). Defer the tablet.
2. **In parallel, three worktrees:**
   - **WS-1a then WS-1b/1c:** the extractor for all three bundles, then the compiler and the parity harness on the **Settings** screen only (the smallest, with no timers). Exit criterion: Settings initial render passes at zero in both themes, with the `renderVals` diff empty.
   - **WS-2a/2c:** the backend repo skeleton, config, the migration runner and migration 0001, the money and time libs with property tests, and the OpenAPI plumbing.
   - **WS-D:** generate `design-spec.md` for both repos and the first ADRs from the reports.
3. **If time remains,** start WS-2b (auth and RBAC engine with its rule table) and WS-6b (the SMS Gate simulator and the `SmsProvider` contract tests), since both need only the M0 interfaces.
4. **Questions to put to the user at the start of the session,** the five items in §6.1: Squarespace plan and membership mechanism, permission to install, deploy-key write access, the Next 14/React 18 pin, and dashboard exposure.

### Critical Files for Implementation

- /home/ec2-user/oasis/backend/src/integrations/ports (to be created in M0: `SmsProvider`, `EmailProvider`, `StorageProvider`, `CardProcessorSync`)
- /home/ec2-user/oasis/backend/db/migrations (to be created: core schema, RBAC, ledger append-only trigger)
- /home/ec2-user/oasis/dashboard/tools/dc-compiler (to be created: parse5 to TSX codegen, the heart of pixel parity)
- /home/ec2-user/oasis/dashboard/tools/parity (to be created: original-versus-port harness, deviations manifest consumer)
- /home/ec2-user/oasis/dashboard/design/deviations.yaml (to be created: single source for D1 to D5 deviations)