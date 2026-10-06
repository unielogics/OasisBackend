<!-- Reference material generated during planning (2026-10-06) from the three Claude Design prototypes. Source of truth for the build; see docs/plan.md. -->

# Oasis Auto Spa: Dashboard Design (Next.js, plan only, nothing changed)

The three fixed premises (Squarespace stays the card processor, SMS goes through the tablet on the tailnet with SMS Gate, the designs are the source of truth) are reflected in every section. Where they touch the dashboard, that is called out under "Integration-driven text changes" in §4.4.

I read the runtime, cross, cc-ui, pay-ui and set-ui reports in full and skimmed the three domain reports. I also spot-checked the bundles and the decoded runtime, and that changed some premises, so they come first.

## 0. Decisions at a glance, and premises the source corrected

| # | Decision | Reason |
|---|---|---|
| D1 | **Next 15.x Pages Router, React and ReactDOM exactly 18.3.1.** Fallback is Next 14.2.x Pages. | Next's App Router (13.4 through 14.x, and 15) renders with a React build that Next vendors (`next/dist/compiled/react`, a canary), not the project's `react` package. That defeats the 18.3.1 parity pin. The Pages Router uses `node_modules/react@18.3.1`. The screens are client-only, so Server Components add nothing. |
| D2 | The three screens are client-only. Pages use `dynamic(..., {ssr:false})`. | The designs read `localStorage` and the clock during state initialisation. |
| D3 | Compile each template to TSX at build time, with one design-patch layer. Keep the three logic classes as TypeScript ViewModel classes behind a `DCHost` shim. | See §2 and §3. |
| D4 | Fonts and CSS: one shared font set and one shared token and shell stylesheet. Per-screen "global CSS" is injected on mount and removed on unmount (a `ScreenStyle` helper). | Measured: see the bullets below this table. |
| D5 | Settings sections and `#emergency` use the URL hash on a single `/settings` route. | A dynamic path segment would remount the page and destroy unsaved Settings state. |
| D6 | Parity harness baseline = the original bundle with only the SMS copy-map applied, so pixel diffs stay at threshold 0. | §5. |

Measurements from the source that matter for the design:

- **Fonts:** all three bundles carry the same nine woff2 files, and the runtime JS is the same file in each. Fonts are Manrope (6 subsets) and Bricolage Grotesque (3 subsets). The 42 `@font-face` blocks are identical across designs, so one `fonts.css` serves everything.
- **Global CSS:** the second helmet `<style>` differs per design, but only slightly.
  - Tokens, `*`, `html,body`, scrollbar, `a` and `input::placeholder` are identical. Pay adds `--red`, `--redSoft`, `--amber`, `--amberSoft` (a superset that is harmless elsewhere).
  - cc alone has the `oa-*` keyframes, `::-webkit-scrollbar-thumb:hover`, and a `button` rule without `color:inherit`.
  - pay and set have `input:focus{border-color:var(--accent)!important}` and `button{color:inherit}`. pay also has `button:disabled`. set also has `textarea` rules.
  - Merging these into one global sheet could change cc buttons, which have no `color:inherit`. They are therefore scoped per screen (D4).
- **Comments:** the template source contains HTML comments (`<!-- ============ TOP NAV ============ -->`). They are dropped, and the whitespace text nodes around them stay.
- **`data-dc-tpl`:** the source template has none. The runtime stamps a pre-order element index over every element. That includes `sc-if`, `sc-for` and `sc-helmet` plus the helmet's children. The compiler reproduces the same numbering, so the original DOM and the port can be matched node for node (§2 and §5).
- **Icons:** the two icon bindings (`v.icon`, `t.icon`) are text-node interpolations that return React elements (`renderIcon`). They are not template attributes. The `interp` helper must keep the "React element becomes Fragment" path.
- **Wrapper:** `#dc-root > div.sc-host[data-sc-name]` sits above the template. pay and set also get `html,body{height:100%}#dc-root,#dc-root>.sc-host{height:100%}`. cc, which has `$preview`, does not.

---

## 1. App architecture

### 1.1 Stack and versions (all pinned exactly in the lockfile)
- **Runtime:** Node 22 LTS from `dnf`, installed with `sudo dnf install -y nodejs22 nodejs22-npm` (verify the exact package names). Use `npm ci`; the dashboard is a single package, not a monorepo.
- **Frameworks and libraries:**
  - `next@15.x` (Pages Router), `react@18.3.1`, `react-dom@18.3.1`, `typescript@~5.5`.
  - `@tanstack/react-query@5` for server state, `parse5@7` and `tsx` for tooling, `vitest` for unit tests.
  - `@playwright/test>=1.45` (needed for `page.clock`), `pixelmatch@5` and `pngjs`, `openapi-typescript` for API types.
- **React guard:** `scripts/assert-react.mjs` runs after install and in CI. It checks that `npm ls react react-dom` shows a single 18.3.1 copy and that `.next/static` contains no `canary` marker. If Next 15 with React 18 causes peer-dependency friction, drop to Next 14.2.x Pages. The architecture is identical.
- **Backend contract:** the dashboard imports no backend code. It generates `src/data/http/schema.d.ts` from the backend's OpenAPI document and commits it. CI regenerates it and fails on drift.
- **Same-origin topology:** a reverse proxy (Caddy or nginx) serves TLS, `/api/*` to the backend and everything else to Next. SSE bypasses Next's proxy. In dev, `next.config.js` `rewrites` proxies `/api/*`. Cookies are therefore host-only, and there is no CORS.

### 1.2 Routes (Pages Router)

| Route | File | Notes |
|---|---|---|
| `/` | `pages/index.tsx` | Redirect to `/operations`. |
| `/login` | `pages/login.tsx` | **Not in the designs.** Compose only from existing primitives: the Payments "locked" card, the Settings drawer input and the primary button. Needs user sign-off (§7). |
| `/operations` | `pages/operations.tsx` | Command Center. |
| `/payments` | `pages/payments.tsx` | |
| `/settings` | `pages/settings.tsx` | Section is held in the hash: `#hours` (default), `#closures`, `#emergency`, `#employees`, `#roles`, `#vip`, `#arrival`, `#services`. |
| `/settings/[section]` | `pages/settings/[section].tsx` | `getServerSideProps` redirect to `/settings#<section>`. This is a pretty-URL alias only, so it never mounts the screen. |

- **Hash handling:** `componentDidMount` runs `location.hash`, which the original only handled for `emergency`. The port handles all eight and ignores unknown values. A `hashchange` listener updates `section`. Every `section` change calls `history.replaceState(null,'','#'+section)`, which never touches the router, so there is no remount.
- **Auth gating, two layers:**
  - `middleware.ts` (matcher excludes `/login`, `/_next`, `/fonts`, `/api`) does a cheap check that the `oasis_sid` cookie is present, and redirects to `/login?next=<path>` if not. It does not validate the session.
  - `SessionProvider` in `_app.tsx` calls `GET /api/auth/session`. A 401 triggers `router.replace('/login?next=…')`. A 200 returns `{user, roles[], permissions, limits, isSuperAdmin, viewAs, prefs:{theme}, businessTz, serverTime}`.
  - `next` is validated to be a same-origin path.
- **Cookie and CSRF:** the cookie is httpOnly, Secure, SameSite=Lax. Every mutation sends `X-Oasis-Client: dashboard` plus an `Idempotency-Key`, and the API checks `Origin`.
- **No `pages/api`.** There is no BFF.
- **Sign-out:** the designs have no logout. Add one by reusing the Payments role-menu dropdown primitive (absolute, `top:52px`, 250px, `--shadowLg`) anchored to the user chip. It holds the name and email, and "Sign out". This is the only chrome addition (flagged in §7). If rejected, keep a `/logout` route only.
- **Navigation:** the `<a href>` elements stay plain anchors, so the DOM is identical. A capturing click handler on `#dc-root` intercepts internal links without modifier keys and calls `router.push`. Hash-only links on the same page are left to `hashchange`.
- **href rewrite map** (applied by the compiler, `design-patches/href-map.json`):

| Design href | Port href |
|---|---|
| `Oasis%20Command%20Center.dc.html` | `/operations` |
| `Oasis%20Payments.dc.html` | `/payments` |
| `Oasis%20Settings.dc.html#emergency` | `/settings#emergency` |
| `Oasis%20Settings.dc.html` (including the cc closed-day link "Manage hours & holidays →") | `/settings` (hours, replicating the original landing; optional improvement is `#closures`) |

### 1.3 Folder layout

```
dashboard/
  design/                      # IMMUTABLE reference (CI verifies checksums)
    original/{operations,payments,settings}.bundle.html     # the saved artifact HTML, byte-exact
    extracted/<screen>/{template.html, logic.original.js, meta.json,
                        helmet.fonts.css, helmet.global.css}
    extracted/fonts/{manrope-latin.woff2, ..., bricolage-grotesque-latin.woff2, manifest.json}
    extracted/runtime/{dc-runtime.js, react.production.min.js, react-dom.production.min.js}
    CHECKSUMS.sha256  README.md
  design-patches/              # OUR deviations (reviewed; not immutable)
    href-map.json  copy-map.json(SMS wording)  operations.patch.json  payments.patch.json  settings.patch.json
    DEVIATIONS.md              # one line per deviation: id, kind(copy|real-data|bugfix|new-surface), owner sign-off
  tools/
    extract-design.ts  verify-design.ts
    dc-compile/{index.ts, parse.ts, grammar.ts, emit.ts, patches.ts, css.ts, bindings.ts}
  src/
    pages/{_app,_document,index,login,operations,payments,settings}.tsx  settings/[section].tsx
    dc/{DCLogic.ts, DCHost.tsx, runtime.ts, ScreenStyle.tsx, types.ts}
    generated/{operations,payments,settings}.tsx  *.bindings.json  *.screen.css   # committed
    screens/{operations,payments,settings}/{Screen.tsx, Logic.ts, vm/*.ts}
    data/{ports.ts, store.ts, realtime.ts, session.tsx, perms.ts, command.ts, http/*, parity/*}
    lib/{tz.ts, money.ts, color.ts, invoice-math.ts, catalog.ts, sms.ts}
    styles/{shell.css, fonts.css}
  public/fonts/                # copied from design/extracted/fonts by dc:compile
  parity/                      # Playwright harness (§5)
  middleware.ts  next.config.js  tsconfig.json  vitest.config.ts  playwright.config.ts
```

### 1.4 Global CSS, fonts and theme

- **`styles/fonts.css`** (generated): `helmet.fonts.css` verbatim. It keeps the 42 blocks, the `unicode-range` descriptors, `font-display:swap` and `font-stretch:100%`. The family names stay exactly `'Manrope'` and `'Bricolage Grotesque'`. Each `url("<uuid>")` is rewritten to `/fonts/<family>-<subset>.woff2`. Imported in `_app.tsx`.
- **Do not use `next/font`.** It renames families, and the inline styles hard-code the names.
- **`_document.tsx`:** preload only the two latin files (`<link rel="preload" as="font" type="font/woff2" crossOrigin>`). The Google `preconnect` links are dropped, since they never affect the DOM under `#dc-root`.
- **`styles/shell.css`** (imported in `_app.tsx`): the shared tokens (light, dark, and pay's extras), `*{box-sizing}`, `html,body{margin:0;padding:0;height:100%;overflow:hidden}`, `body{background:var(--bg)}`, `#__next{height:100%}`, and the scrollbar thumb, placeholder and `a` rules.
  - A vitest test asserts that every token value equals the original helmet CSS in all three designs.
- **`ScreenStyle`:** on mount it appends `<style data-oasis-screen="…">` to `<head>` with the compiled `screen.css`. That file is the original global CSS, verbatim, plus `FULL_PAGE_CSS` for pay and set (the screens where the bundle has no `$preview`). It removes the element on unmount. This preserves the per-document semantics of the originals.
- **No Tailwind and no reset.** Pages Router only allows global CSS from `_app`, which is why `ScreenStyle` injects its CSS at runtime.
- **Theme.**
  - The root wrapper keeps `data-theme={theme}` (parity).
  - Also mirror it to `<html data-theme>`. That is invisible in practice because `html,body` have `overflow:hidden`, and it fixes the original's quirk where body used the light tokens.
  - The source of truth is the per-user server preference (`session.prefs.theme`).
  - `localStorage['oasis-theme']` is only a pre-hydration cache. An inline script in `_document` sets `document.documentElement.dataset.theme` before paint.
  - The server value wins after the session loads. `toggleTheme` is optimistic, followed by `PUT /api/me/preferences {theme}`.
  - The cache is cleared on logout.
  - Add `color-scheme:dark` on the wrapper in dark theme only. This fixes the native date input (a fix-list item).

### 1.5 Build tooling and scripts

```jsonc
// package.json "scripts"
"design:extract": "tsx tools/extract-design.ts",      // one-off; refuses to overwrite design/
"design:verify":  "tsx tools/verify-design.ts",       // sha256 vs design/CHECKSUMS.sha256
"dc:compile":     "tsx tools/dc-compile/index.ts",    // writes src/generated + public/fonts + styles/fonts.css
"dc:check":       "tsx tools/dc-compile/index.ts --check",  // recompile into memory; fail if differs from committed
"dc:compile:parity": "tsx tools/dc-compile/index.ts --variant=parity --emit-tpl-ids --out .generated-parity",
"gen:api":        "openapi-typescript $OASIS_OPENAPI -o src/data/http/schema.d.ts",
"typecheck": "tsc --noEmit", "lint": "next lint", "test": "vitest run",
"build": "npm run dc:check && next build",
"build:parity": "NEXT_PUBLIC_PARITY=1 DIST_DIR=.next-parity npm run dc:compile:parity && next build",
"parity:setup": "...", "parity:record": "...", "parity:dom": "...", "parity:pixels": "...", "parity:vals": "...", "parity:all": "..."
```

- **Memory:** the largest generated file (Operations) is a few hundred KB of TSX. Use `NODE_OPTIONS=--max-old-space-size=3072` for `next build` and `tsc` on the 7.8 GB box.
- **Production deploy:** `output:'standalone'` under a systemd unit, behind the reverse proxy.
- **Security headers:** `font-src 'self'`, `style-src 'self' 'unsafe-inline'` (the injected `<style>` needs it), `frame-ancestors 'none'`.
- **Lint and format:** ESLint ignores `src/generated` and `parity/out`. Prettier ignores generated files.
- **Parity build isolation:** `NEXT_PUBLIC_PARITY=1` compiles in the fixture `DataPort` and the `window.__oasisParity` hook. It is dead-code-eliminated in production. The parity build uses its own `distDir`, and the deploy script refuses to ship `.next-parity`.

---

## 2. The compiler (`tools/dc-compile`)

### 2.1 Extraction (`tools/extract-design.ts`, run once)
1. Read each `artifact-*.html`. Decode `__bundler/template` (a JSON string holding the full page HTML) and `__bundler/manifest`. Manifest entries are base64, with `compressed:true` meaning gzip.
2. `parse5.parse` the page HTML and find `x-dc`.
   - `template.html` = `parse5.serialize(x-dc)`. This is the same as the browser's `x-dc.innerHTML`, which is what the runtime sees (`&amp;` escapes, double-quoted attributes).
   - `logic.original.js` = the textContent of `script[data-dc-script]`.
   - `meta.json` = `{screen, name:"Oasis Command Center", dataProps, preview:{width,height}|null}`.
3. Split `<helmet>` into the two `<style>` blocks. Style 1 (fonts) goes to `helmet.fonts.css` with `url("<uuid>")` kept. Style 2 (global CSS) goes to `helmet.global.css`.
4. Write the fonts, named `<family-slug>-<subset>.woff2` from the `@font-face` family and the `/* subset */` comment. Record uuid, sha256 and bytes in `manifest.json`.
5. Copy the runtime and the React UMDs.
6. Save the original bundle HTML byte-exact. Write `CHECKSUMS.sha256` over every file in `design/`.
7. CI runs `design:verify`. Any diff under `design/` fails the build unless the PR is explicitly labelled `design-update`.
8. Do not include the `#__claude_design_branding` badge anywhere in the port.

### 2.2 CLI
```
tsx tools/dc-compile/index.ts
  [--screen operations|payments|settings|all]  [--check]  [--variant=prod|parity]
  [--emit-tpl-ids]  [--out src/generated]  [--allow-complex-expr]
```
Inputs per screen are `design/extracted/<screen>/template.html` and `meta.json`, plus `design-patches/{href-map,copy-map,<screen>.patch}.json`. Outputs:
- `generated/<screen>.tsx`, `<screen>.bindings.json`, `<screen>.screen.css`, and `fonts.css` (once).
- `public/fonts/*`.

Exit codes: 0 ok, 1 check mismatch, 2 grammar or unknown attribute, 3 patch guard failed.

### 2.3 Parse
- Pre-pass equal to the runtime's `encodeCase`: `helmet` becomes `sc-helmet`. The RAW_WRAP renames and camelCase-attribute encoding are no-ops here, because the source already contains `sc-camel-*`.
- `parse5.parseFragment(html)` with the default `<template>` context.
- Do not use JSX, jsdom or cheerio in xmlMode.
- Assign `tplId` as a pre-order counter over every element in the fragment. This includes `sc-if`, `sc-for`, `sc-helmet` and the helmet's children. It is identical to the runtime's `stamp()`.

### 2.4 Expression grammar (strict)
All 1,075 template expressions are an identifier or a dotted path.
```
expr := IDENT ('.' (IDENT | DIGITS))*      // IDENT = [A-Za-z_$][\w$]*
```
- Anything else (`===`, `!`, `[]`, literals, parentheses) fails the build with exit 2. The `--allow-complex-expr` flag instead emits `R($v,"src")`, a port of the runtime's `resolve()`, for future templates. `{{ true }}` and `{{ false }}` appear only inside `hint-placeholder-*`, which are ignored.
- Scope stack: `sc-for as="a"` pushes `a`. The first segment resolves to the innermost loop variable, else to the vals root `$v`.
  - Emission uses mangled names `$L<depth>_<as>` so the common loop names (`k v t g a ar b c q al s m d w r st cs ad p sl tp pr pk h ns`) cannot collide with `$v`.
  - `a.b.0` emits `$L1_a?.b?.[0]`.
- Whole-attribute binding regex `^\s*\{\{([\s\S]+?)\}\}\s*$`. The compiler errors if the attribute also contains a second `{{`. That is the lazy-regex misparse the original has, and it never occurs in these designs.

### 2.5 Node walk (`emit(node, scope)`)
- **Element** (not `sc-if`, `sc-for` or `sc-helmet`):
  - Tag name is the original (SVG stays lowercase).
  - Skip the attributes `sc-name`, `data-dc-tpl` and `hint-size`.
  - Decode `sc-camel-*` with `kebabToCamel` (`view-box` becomes `viewBox`, `on-pointer-down` becomes `onPointerDown`).
  - `class` becomes `className`, `for` becomes `htmlFor`.
  - `on*` becomes `EVENT_MAP[key] || on+Upper(key[2])+key.slice(3)`.
  - SVG and HTML renames: `stroke-width`, `stroke-linecap`, `stroke-linejoin` become camelCase, and `inputmode` becomes `inputMode`.
  - `data-*` and `aria-*` pass through. Any other hyphenated attribute fails the build.
  - Void elements (`input`) are self-closing.
- **`style`:**
  - Static: `cssToObj` at build time. Split on `;`, split each declaration at the first `:`, trim both sides.
    - Property names go through `kebabToCamel` (`-webkit-font-smoothing` becomes `WebkitFontSmoothing`). `--x` is kept as is.
    - Duplicate keys keep the first insertion position with the last value, matching JS object semantics.
    - The result is hoisted as a frozen `const S<tplId> = {…}` with the key order equal to source order.
  - Whole-value binding: `css($v.x)`, where `css(v) = typeof v === 'string' ? cssToObj(v) : v`. `cssToObj` is a verbatim port, exported from `dc/runtime`.
  - Mixed (for example `…background:{{ k.accent }};`, `grid-template-columns:{{ matrixCols }}`, `conic-gradient(var(--accent) {{ sel.checkPct }},var(--panel3) 0)`): `css(\`…${m(expr)}…\`)`, where `m(x) = String(x ?? '')`.
  - Never memoise or reuse a style object returned from `renderVals`. React diffs style keys against the previous object. cc's drag and swipe code mutates `el.style.transform` and `transition` directly, and that only survives re-renders if the prop objects keep the same keys and values.
- **`value` and `checked`:** emit `v === undefined ? '' : v` and `v === undefined ? false : v`. A bound `value` with no `onChange` also gets `onChange={NOOP}`. That is dev-warning hygiene only and adds no DOM. Keep `onInput`.
- **Other attributes:** whole-value binding emits the raw value. That covers handlers, `ref`, `disabled`, `title`, `data-drop`, `data-theme`, `placeholder`, and `value` after the rule above. Mixed and static values are strings.
- **Children:** each emitted in order.
- **Text:**
  - No `{{`, and `!trim() && !includes(' ')`: dropped. This is newline-only whitespace, and only 2 nodes per design.
  - Otherwise emit the static text as `{"…"}` (a `JSON.stringify` literal). Never use JSX text, because JSX trims lines.
  - With `{{`: split on `/\{\{([\s\S]+?)\}\}/` and emit `<>{"static"}{I(expr)}{"static"}</>`.
  - `I(v)`: `undefined` becomes `null` (plus a once-only dev warning `[oasis] <screen>: {{ x }} never resolved`, which CI treats as a failure). A React element or array becomes `<Fragment>{v}</Fragment>`. `null` or a boolean becomes `null`. Anything else (including `''` and `0`) becomes `<span className="sc-interp">{String(v)}</span>`.
  - Keep the `span.sc-interp` wrappers. They are 172, 56 and 106 nodes in cc, pay and set, and they change flex and grid item boundaries.
- **Comments:** dropped. **`sc-if`:** `{cond ? <>…</> : null}` with JS truthiness (`[]` and `'0'` are truthy).
- **`sc-for`:** `{asArray(list).map(($it, $i) => <Fragment key={$i}>…</Fragment>)}` with `asArray = v => Array.isArray(v) ? v : []`. Key by index, as the original does. Push `{as, $index}` onto the scope stack.
- **`sc-helmet`:** never emitted as JSX. The font CSS and global CSS go to the generated CSS files.
- **Raw interpolation (patch layer only):** `{{= path }}` emits `{path}` with no span. Patches use it to swap static text for data (for example the user chip) with a DOM identical to the original's static text node.
- **Parity variant:** `--emit-tpl-ids` also emits `data-dc-tpl="N"` on every element. The harness then compares original and port without stripping it, which verifies structure, order and numbering.

### 2.6 Generated file shape
```tsx
// AUTO-GENERATED by tools/dc-compile. DO NOT EDIT.
// source: design/extracted/operations/template.html sha256:… patches sha256:… compiler:1.0.0
/* eslint-disable */
import { Fragment } from 'react'
import { css, I, m, asArray, NOOP } from '@/dc/runtime'
const S0 = Object.freeze({ height:'100vh', overflow:'hidden', display:'flex', flexDirection:'column', /* … */ })
export default function render($v: Record<string, any>, $h: { }): JSX.Element {
  return (<>
    <div data-theme={$v.theme} data-screen-label="Oasis Command Center" style={S0}>…</div>
  </>)
}
```
`*.bindings.json` lists every root identifier and dotted path, with loop scoping. A vitest "bindings contract" test requires that `renderVals()` provides each one. This replaces the runtime's "never resolved" warnings.

### 2.7 Patch layer (`design-patches/*.patch.json`)
Patches are applied to the parsed tree before emission. The selector is `tplId` plus guards.
```json
{ "ops": [
  {"op":"wrap-if","tpl":42,"expectTag":"div","expectTextStarts":"Preview as","cond":"me.isSuperAdmin"},
  {"op":"replace-text","tpl":57,"expect":"Rafael M.","with":"{{= me.name }}"},
  {"op":"rewrite-href","tpl":18,"expect":"Oasis%20Settings.dc.html#emergency","to":"/settings#emergency"}
]}
```
- A mismatched guard fails the build (exit 3), so patches cannot silently drift.
- `copy-map.json` is the SMS relabel table (§4.4). It applies to template text and also to the logic strings that were extracted.
- Every patch has a line in `DEVIATIONS.md`.

### 2.8 Regeneration and commit policy
- Generated files are committed so diffs are reviewable. `npm run dc:check` is a required CI step, and `build` runs it.
- A compiler change that alters output must come with a parity run.
- Compiler unit tests use golden snippets for each rule: whitespace nodes, mixed style, `value` undefined, nested loops with shadowed names, event decoding and the `sc-interp` rules.

---

## 3. Logic layer

### 3.1 Evaluation

| | (a) Keep each `DCLogic` class verbatim behind `DCHost`, fed by an API data adapter | (b) Rewrite into typed selectors and hooks |
|---|---|---|
| Fidelity | Highest: the class is the executable spec for roughly 1,000 bindings and hundreds of computed style objects (the `hexA` alpha .12 vs .18 and `lighten` 45% maths, the half-pixel sizes). | A rewrite risks silent pixel drift in every computed style. |
| Mutations | The cc class mutates in place and embeds business rules (log text, message text, status flow) in `update()`. Those rules move server-side. Fixtures, localStorage and `Date.now()` are baked into class fields. | Clean, but expensive. |
| Sync semantics | `this.state` is updated synchronously. Handlers call `setState` then read `this.state`. | Hooks would break these handlers. |

**Recommendation: a staged hybrid, closest to (a).**
- **Stage 1 (parity mode):** `logic.original.js` runs unmodified under `DCHost` against a `FixtureDataPort`. This is the original behaviour and the node oracle for tests.
- **Stage 2 (live):** copy each class to a TypeScript ViewModel class (`screens/<screen>/Logic.ts`) with semantics-preserving edits only:
  - Remove fixtures and `localStorage` access. Reads go through `this.data` (a `DataPort`); mutations go through `this.cmd.*`.
  - Extract the pure helpers into `lib/` with unit tests: `money`, `parseT`, `fmtT`, `hexA`, `lighten`, `stMeta`, `dayInfo`, `calc`, `lim`.
  - Keep `renderVals()`, the gesture engine, the key handler and the imperative style code as is.
  - Port `renderVals()` regions into pure builders `(state, data, ctx) => RegionVM` over time. Each builder gets golden snapshots from the original oracle.
- **Migration path:** the class shrinks to a thin shell as builders are extracted. Hooks are never required. Typing is added by narrowing `Record<string,any>` to generated binding types per region.

### 3.2 `DCHost` shim (`src/dc/*`)
```ts
export abstract class DCLogic<S extends object = any> {
  props: any; state: S = {} as S; __host: DCHost | null = null
  constructor(props?: any) { this.props = props ?? {} }
  setState(update: Partial<S> | ((p: S) => Partial<S>), cb?: () => void) {
    const patch = typeof update === 'function' ? update(this.state) : update
    this.state = { ...this.state, ...patch }        // synchronous, like the original
    this.__host?.bump(cb)                           // no-op until attached
  }
  forceUpdate() { this.__host?.bump() }
  componentDidMount() {} componentDidUpdate(_p: any) {} componentWillUnmount() {}
  renderVals(): Record<string, any> { return {} }
}
```
- `DCHost` is a class component.
  - It constructs `new Logic(props)` in its constructor and sets `logic.__host = this`.
  - `bump(cb)` is `setState(s => ({v: s.v + 1}), cb)`.
  - It forwards `componentDidMount`, `componentDidUpdate(prev)` and `componentWillUnmount` in try/catch.
  - `render()` sets `logic.props` and computes `vals = {...props, ...logic.renderVals()}` on every render. It renders `<div id="dc-root"><div className="sc-host" data-sc-name="…">{render(vals, host)}</div></div>`.
  - A `renderVals` error renders a plain error card and logs it. It does not render the prototype's red `.sc-logic-error` box.
- `tsconfig` target is ES2022, so class-field initialisers run in the same order as in the original (`state = (() => …)()` uses earlier fields such as `this.SERVICES`).
- **StrictMode:** `reactStrictMode:true` in dev. The class constructors are side-effect free (they read data only). Timers and listeners are installed in `componentDidMount` and removed in `componentWillUnmount`, so a double mount is safe. Parity runs use a production build.
- **Hidden-tab tick:** skip the per-second `setState` when `document.hidden`, and do one catch-up `setState` on `visibilitychange`. There is no visible difference.

### 3.3 Replacing fixtures, localStorage and constants

**Operations (cc)**

| Original | Replacement |
|---|---|
| `SERVICES`, `ADDONS`, `ADDON_TASKS`, `oasis-checklists` | `GET /api/catalog`: packages (price, duration, ordered tasks) and add-ons. Seed without any "inspection" task, then delete the `/inspection/i` filter. |
| `DEF_HOURS`, `oasis-hours`; `DEF_CLOSURES`, `oasis-closures` | `GET /api/settings/hours` and `GET /api/closures`; `dayInfo` reads the store. |
| `oasis-emergency` | `GET /api/emergency` plus the SSE `emergency.changed` event. |
| `BASE = new Date(2026,5,13)`, `dateLabel`, `NOW` | `lib/tz.ts`: `businessToday()` from `Intl` with the session's `businessTz`. A civil-date `dateFor(o)` builds `new Date(y,m,d)` for pure calendar arithmetic. `BASE` is a getter that re-evaluates on the tick when the business date rolls over. |
| `nowClock()`, `Date.now()`, `startedAt` | A server-offset clock: `serverNow() = Date.now() + (session.serverTime − clientAtLoad)`. `nowClock()` formats with `Intl` in the business tz. Elapsed time is computed from the ISO `startedAt`. |
| `genDay`, `rng`, `POOL_*`, `dayCount`, `countFor` | `GET /api/ops/calendar?from&to` returns per-day `{date, closed?, reducedFrom/To, note, count}` plus appointments for the visible day. |
| `slotTimes`, `blocked`, `vipHeld`, the "48h" copy | `GET /api/availability?date&packageId` returns slots with `available`, `blocked` or `vip_held`. The release window text comes from the VIP setting. |
| Staff view: hard-coded Marco, Lena, Sofia plus Unassigned, roles and avatar colours | Employees on shift or with jobs in the window, plus "Unassigned". Colours from a stored `opsColor`, else the Settings palette by index. The `repeat(4,1fr)` grid wraps if there are more than four. |
| `late`, `eta`, `geoIn`, `prepped` | Server-owned flags and ingests. `late` = unarrived at start plus a grace period (an open setting, §7). |
| Membership (`memberMeta`, perks, `renewDate`, credits, months, retention) | From the Squarespace-subscription-mapped membership: tier id, `renewsOn`, credits left and used, months active. Badge colours key off the tier id, not the first word of a plan string. |
| History, `visits`, `lifetimeSpend=visits*148`, `avgFreq` | `GET /api/customers/:id/history` aggregates. |
| `payMethod: 'Visa ···· 4421'` | From the latest transaction's brand and last4, else the text "Managed in Squarespace". |
| `whatsapp:true` | `smsOptIn` on the customer. |
| Alerts | Appointment-derived alerts stay computed in the class (they depend on the ticking clock). The class merges `GET /api/ops/alerts` for system alerts: SMS device health, Squarespace sync, inbound replies, approvals. |

**Payments (pay)**

| Original | Replacement |
|---|---|
| `DEF_ROLES`, `oasis-roles`, the single-role `role` state | `session.permissions` and `session.limits` (union of roles, highest limit, `null` unlimited, default 25), plus per-person exceptions. |
| `calc(tx)`, `r2` floats, `TAX = 0.07` | The server's `computed` object in integer cents. `lib/invoice-math.ts` (cents, half-up tax) is used only for live sheet previews, with golden vectors from the 105-invoice validation table in pay-domain. |
| `txs`, the PRNG history, `selId` default `'INV-20603'` | `GET /api/payments/summary?range` (KPIs, chart buckets, by-method, filter counts, pending approvals). `GET /api/payments/invoices?range` lists rows with no pagination, since the design has none. `GET /api/invoices/:id` returns the detail. Default selection is the first row, which matches the original's `txs[0]` fallback. |
| `by:'Rafael M.'`, `byRole` | The actor and role from the session. |
| `nowT()`, range labels, `dateOf` | Business-tz computed. |
| `localStorage` role preview | Super-Admin "view as" (see below). |

**Settings (set)**

| Original | Replacement |
|---|---|
| All `oasis-*` keys | One snapshot `GET /api/settings/bundle` (hours, rules, closures, emergency state and history, employees, roles, perms, limits, VIP, arrival, catalog), then per-control commands. |
| `TODAY='2026-06-13'` | `businessToday()`. |
| `hash%4` and `hash%3` counts, `ncAffected`, `emRebooked`, `REMAINING` | `POST /api/closures/preview`, `GET /api/emergency/preview` (real affected appointments and rendered message), and real counters. |
| `'Rafael M.'` chip and the static idle banner "6 appointments left…" | Session user, and a computed banner from today's real counts. |

**Super-Admin "view as"** replaces the Payments "Preview as" menu.
- The button is shown only when `isSuperAdmin` (a compile-time `wrap-if` patch).
- Selecting a role calls `POST /api/auth/view-as {roleId}`. The server downgrades authority to that role, never escalates, and audits both the actor and the assumed role.
- The session payload is re-fetched, and the UI gates exactly as the design does.
- The menu text `refunds ≤ $N` comes from `GET /api/roles`.

### 3.4 Commands, optimistic updates and error states without new visuals

`data/command.ts` wraps every mutation:
```ts
command({ key, request: (idem) => api.post(...), optimistic?: (draft) => void,
          onOk?: (r) => void, onFail?: (e: ApiError) => ToastSpec })
```
- **Idempotency:** a UUID per user action, reused on network retry.
- **Optimistic (patch the query cache, roll back on failure):** checklist toggles, add-on toggle (recomputed with the pure helpers), pay and pickup chips, advance and assign-bay (status only), theme, and all Settings toggles and steppers.
- **Not optimistic:** every money action (refund, adjust, credit, collect, apply, approve, deny). The sheet's submit button uses its existing disabled style while the request is in flight. The refund-approval banner and totals only change from the server response.
- **Failure handling:** roll back, then reuse the existing toast component with the server's message (the design's toast text arrives as `error.message`). A 403 shows "Your role can’t …" using the pay-style wording. A 401 redirects to `/login`. A 409 conflict refetches the entity and shows its message.
- **Loading (the designs have none):** the screen mounts after the session and the first snapshot. A boot splash (logo tile and wordmark, existing styles) shows until then, which is a new surface and is flagged (§7). Later refetches keep stale data with no visual change.
- **Calendar and file modal:** while a window is loading, render the structure with empty or zero values using `keepPreviousData`. The file modal renders from the lean card at once. Messages, history and the full checklist arrive lazily, and are prefetched on pointer-down.
- **Offline or SSE down:** a toast "Connection lost · retrying" using the existing component. The 20 s poll fallback below runs while SSE is down.

### 3.5 Preserved behaviours (kept verbatim)
- **1 s tick:** `setInterval` bumping `tick`. It drives the bay timers, progress bars and the "Live · h:mm AM" label.
- **Gesture engine** (cc): thresholds are kept exactly.
  - 380 ms long-press for touch drag.
  - 6 px mouse drag start.
  - Touch intent: `|dx|>12 && |dx|>1.4|dy|`, otherwise cancel past 12 px.
  - Swipe commit at ±90 px, card clamp ±150 px.
  - Calendar swipe: 70 px, ratio 1.5, within 800 ms.
  - Click suppression for 450 ms after a gesture.
  - `navigator.vibrate(12)`, `document.body.style.userSelect`, a non-passive `touchmove` guard on `document`.
  - `touch-action` values stay inline: `pan-y`, `pan-x`, `manipulation`.
- **Drop targets:** `document.elementFromPoint(x,y).closest('[data-drop]')`, with `data-drop="bay:N"` and `"hr:H"`. The ghost is `pointer-events:none`, positioned through `ghostRef.current.style.transform`.
- **Imperative style on the dragged or swiped card:** kept. The generated style objects keep the same keys and values (§2.5).
- **Keyboard (window `keydown`):** `/`, `Esc`, `n`, `←`, `→`, `t`, and `m`, `p`, `s`, `r` with the modal open.
  - Fix: ignore the keys when `ctrl`, `meta` or `alt` is held. Today Ctrl+R advances a job and also reloads the page.
  - Fix: `n` resets the title to "New Appointment".
  - Fix: `m` also switches to the Messages tab.
- **Cleanup:** `componentWillUnmount` removes all timers and listeners.

### 3.6 SSE realtime
- **Channel:** `GET /api/events` (same-origin `EventSource`, cookie auth). The server sends `id:` on every event and keeps a ring buffer, so `Last-Event-ID` resumes after a reconnect.
- **Event types:** `appointment.updated`, `appointment.moved`, `message.received`, `message.status`, `invoice.updated`, `refund.requested`, `settings.changed`, `emergency.changed`, `arrival.eta`, `sms.device`, `squarespace.sync`.
- **Client (`data/realtime.ts`):** exponential-backoff reconnect.
  - Events carry entity id and `version`. Stale versions are ignored.
  - Small events patch the query cache with `setQueryData`. Others `invalidateQueries`, coalesced in a 250 ms window.
  - Store notifications are batched with `requestAnimationFrame` before they bump the `DCHost`.
  - A 20 s poll of the board, KPIs and unread alerts runs while SSE is down.
- **Host wiring:** the `DCHost` subscribes through the logic's `__host`, so a store change re-renders the screen with no logic-class changes.

### 3.7 Permissions drive locked and disabled states
- **Payments, exactly as designed:**
  - `locked = !perms['pay.reports']` comes from the session, not from a 403. The page shows the "No payment access" card with the role name.
  - Disabled actions use the design's `title` reasons: "Role can’t collect payments", "Role can’t issue refunds", "Nothing left to refund", "Role can’t adjust invoices", "Role can’t issue credits".
  - The approve control keeps its not-allowed style. Clicking it when not allowed shows the toast "Your role can’t approve $X".
  - `canApprove = has refund && limit >= amount`.
- **Operations and Settings:** the designs gate nothing. Rules without changing visuals:
  - A disallowed action does not call the API. It shows an existing-style toast ("Your role can’t …"). The server enforces the same rule.
  - A disallowed whole screen or section shows the Payments-style locked card (new surface, flagged).
- **Server contract:** the session carries the 27-key map and the three limits. The permission-to-UI map is in §4.5.

---

## 4. Per-screen work breakdown

Notation: VM = a `renderVals` field. Acceptance means DOM equality plus pixel parity (zero diff) in the listed scenarios, except the allow-listed deviations.

### 4.1 Operations (Command Center)

| Region | Data (VM to API) | Commands | States and edge cases | Acceptance |
|---|---|---|---|---|
| Header (brand, nav, search, New Appointment, Walk-in, theme, bell, user chip) | `theme`, `me.initials/name/role` (via `{{= }}` patches), bell dot from `alerts.unreadCount`, `search` is local | `PUT /me/preferences` | The dot is hidden when there are no alerts (a real-data deviation; it is always on in the design). The chip opens the sign-out menu. Nav href rewrite. | The initial header is pixel-identical (Rafael M. fixture). The nav click is SPA. `/` focuses search. |
| Emergency banner | `emergencyOn`, `emergencyText` from `/api/emergency` plus SSE | none (Manage link to `/settings#emergency`) | It appears or disappears live. It sits between the header and KPIs with no layout shift beyond the banner. | Appears when the fixture sets it active. |
| KPI strip (7) | `kpis[]` from `/api/ops/kpis` | none | See the formulas below this table. Values do not follow search or range. | The seven values equal the fixture's original except the allow-listed sub-labels. |
| View and range tabs, live clock, date | `clockLabel` from the offset clock in the business tz, `dateLabel` real date | none | `next24` = today and tomorrow, `week` = 7 days, `today`, `tomorrow`. | Tabs switch. The clock updates each second (clock-pinned in tests). |
| Timeline column 1 | `groups[].items[]` card VM from `/api/ops/appointments?from&to` | `POST /appointments/{id}/advance`; swipe right advances, swipe left opens Messages | The "Today" divider is fixed to the real day label. Drag, long-press and swipe are preserved. | Drag-to-bay and swipe scenarios pass. |
| Active Bays and arrivals | `bays[]`, `arrivals[]`; elapsed, progress and ETA computed from `startedAt` and duration | `POST …/assign-bay`, `…/prep-bay`, `…/arrive` (manual) | "Simulate arrival" stays as a dev action, shown only if `config.devTools` (else it calls the real manual arrive). The busy-bay dashed outline, the hover cue and the free-bay drop zone are unchanged. | Occupied and free bay visuals match. |
| Ready & Completed | `completedJobs[]` | `POST …/payments/mark-paid`/`mark-unpaid` (unpaid requires `pay.void`), `POST …/pickup` | The pay chip routes through the ledger. For card payments confirmed in Squarespace, "unpaid" is refused with a toast. | Both chips toggle correctly. Empty state text matches. |
| Bay Board: bays, Up Next, Needs Attention | `queue[]`, `alerts[]` from the class plus `/api/ops/alerts` | `prep-bay`, `notify-ready`, send reminder, mark picked up, redeem credit | System alerts (SMS device, Squarespace sync, replies) use the existing alert card in red, amber or violet tones. | Alert order and tones match the fixture. |
| Staff view | `staffCols[]` from employees plus Unassigned | none | More than four columns wrap. | Matches with the three fixture staff. |
| Calendar day, week, month | `calRows`, `calWeek`, `calMonth` from `/api/ops/calendar`; hours, closures and emergency via `dayInfo` | `POST …/reschedule` on drop | Closed days, reduced hours and emergency days render the closed notice. The reschedule server check (open hours, bay capacity) returns 409 and a toast. | All three modes and drag reschedule pass. |
| File modal: header, stage tracker, 8 tabs, action bar | `sel.*` from `GET /appointments/:id` plus SSE | advance, checklist (single, section, all), add-on toggle (price from the catalog), photo add, send message, mark paid, payment link, redeem credit | The Added/Removed toast is fixed. Photos upload through S3 presigned URLs. The Messages tab shows inbound customer bubbles and per-message delivery state (§4.4). | Every tab is identical for the fixture. |
| New Appointment and Walk-in slide-over | `newServices[]` (the first five packages as designed), `newSlots[]` from `/api/availability` | `POST /appointments` (source `dashboard` or `walk-in`; the SMS opt-in chip sets `smsOptIn`) | The design's text fields are static divs. Making them real inputs is a required addition, using the Settings input style (flagged in §7). Blocked slots stay greyed. Holders of `sched.override` can still select one (a toast only). | Open and close, service and slot selection, blocked and VIP toasts. |
| Ghost and toast | `ghost*`, `toast*` | none | The toast animation quirk is replicated (§6). | Toast text and lifetime (3200 ms) match. |

**KPI formulas (all server-side, integer cents):**
1. Appointments 24h = non-cancelled appointments for today and tomorrow. The sub-label is `N booked`. Default `N` = appointments in status `booked`, and this is an open decision (§7). The original hard-codes `12 booked`, which is coincidentally equal to the value.
2. Active jobs = status `cleaning`.
3. Ready for pickup = completed and not collected.
4. Pending payments = today's not-paid, not-cancelled appointments, with `$sum` of the balances.
5. Bay time free = Σ over bays of max(0, remaining open minutes − remaining durations of that bay's jobs), shown as `x.yh` rounded to 0.1 (the original hard-codes `3.5h`).
6. Members today = day-0 appointments with an active membership tier.
7. Revenue today = Σ paid grand totals today. Money shows whole dollars unless the amount is not whole, then cents (the decision above).

### 4.2 Payments

| Region | Data | Commands | States | Acceptance |
|---|---|---|---|---|
| Header (brand, nav, Preview-as, theme) | `roleName`, `roleOpts[]` from `/api/roles`, `locked` | `POST /auth/view-as` | The Preview-as button appears for Super Admin only. For everyone else the flex spacer keeps the layout. | The menu lists each role's limit text. |
| Locked state | `locked`, `roleName` | none | The card is rendered when `pay.reports` is missing. | Matches the design card. |
| Toolbar | `ranges[]`, `rangeLabel` (business tz) | Export CSV `GET /api/payments/export.csv` | A real CSV download replaces the toast-only design, and the toast still shows with the count. | Four ranges and labels. |
| KPI cards (6) | `kpis[]` from `/api/payments/summary` | none | `Credits issued` counts distinct clients (matching its label). Singular forms are fixed ("1 invoice"). | Values match the fixture. |
| Pending-approval banner | `hasPending`, `pendingText` (first pending), plural fixed | Review (selects the invoice, sets the range, and clears filter and search) | Hidden if none. | Matches the fixture text except the plural fix. |
| Charts | `bars[]`, `methods[4]` | none | Integer-cent aggregation. The bucket labels follow the business tz. | Bars and methods match. |
| Transactions table | `filters[5]` with server counts, `rows[]` (client-side search over id, client, vehicle and item names) | none | Empty state text. Status pills, including a pending-Squarespace variant (§4.4). | All filter, search and sort cases. |
| Invoice detail | `d.*` from `GET /api/invoices/:id` | Collect, Apply credit, Refund, Adjust, Issue credit, Send receipt | Disabled titles per the permission rules. Ledger event meta may append "Awaiting Squarespace". | Detail renders for each status in the fixture. |
| Ledger pending refund controls | `canApprove`, `approveNote` | `POST …/refunds/:eventId/approve`, `…/deny` | Approve uses the permission and limit. Deny requires `pay.refund`. Self-approval is blocked by the server (an open decision). | Approve and deny scenarios. |
| Action sheets (refund, adjust, credit, collect, apply) | `sh.*`; live previews from `lib/invoice-math.ts` | `POST …/refunds`, `…/adjustments`, `…/credits`, `…/payments`, `…/credit-applications` | A refund over the limit becomes pending. Over-limit adjust and credit stay blocked. The submit is disabled while in flight. | Each sheet's summary and validation text. |
| Toast | `toast` | none | 3000 ms. | Matches. |

### 4.3 Settings

| Region | Data | Commands | States | Acceptance |
|---|---|---|---|---|
| Header, user chip | session user and role names (patch) | none | The chip shows the real name and role titles. | Chip text. |
| Rail (8 items, ACTIVE pill, employee count) | `nav.*`, `emActive`, `empCount` | `replaceState` on the hash | Items for sections the user cannot access show the locked card on click. | Rail states. |
| Working hours, rules, summary, dirty bar | `hourRows`, `ruleRows`, `weekHours` | `PUT /settings/hours` on Save; rules `PUT /settings/rules` immediately | Dirty state is in memory and survives leaving the section. A from-after-to check is added, with a toast. | Edit, Discard, Save, copy Monday. |
| Holidays and closures | `upcoming[]`, `past[]` with real affected counts | `POST /closures`, `PATCH /closures/:id` (notify), `DELETE /closures/:id`, `PUT /settings/auto-federal-holidays` | A duplicate date shows the form error. Past and upcoming split by business date. | Add, validate, notify, remove. |
| Emergency | `emSummary`, `emNotified` and `emRebooked` (real), `emAffected[]`, `confirmText` | `POST /emergency/close`, `POST /emergency/reopen` | Confirm adds a history row and a closure-list entry with the `emergency` tag. The preview recipient is the first affected customer. | Idle and active states, dialog, history. |
| Employees and drawer | `empRows[]`, `dr.*` | `POST /employees`, `PUT /employees/:id`, `…/deactivate`, `…/reactivate` | Reactivate restores the prior status. `team.edit` and `team.roles` gate saving and the access tab. | Search, filters, three tabs, validation. |
| Roles and permissions | `roleCards`, `roleCols`, `permGroups` | `POST /roles`, `PUT /roles/:id/permissions/:key`, `PUT /roles/:id/limits/:key`, `DELETE /roles/:id` | Locked role toast. Custom role names are auto-suffixed ("Shift Lead 2"). The employee role filter resets to All after a role removal. | Matrix toggles, limit chip cycle. |
| VIP | `vipHolds`, `vipClients`, steppers, toggles | `/vip` and `/vip/holds` and `/vip/clients` | VIP clients resolve by name to a customer id. | All controls. |
| Arrival | `arrToggles`, segs, `arrSteps` | `PUT /arrival-settings` | Immediate save. | Step text updates. |
| Packages and checklists | `svcList`, `tasks` | `PUT /packages/:id/checklist` and `/addons/:id/checklist` (whole ordered array; debounced) | Checklist state is keyed by stable task ids on live jobs. | Edit, reorder, add with Enter. |
| Confirm dialog, toast | `confirmOpen`, `toast` | n/a | 2800 ms toast. | Matches. |

### 4.4 Integration-driven text changes (SMS, Squarespace)

**SMS relabels (the only deliberate copy deviation, applied by `copy-map.json`)**

| Screen | Place | Original | New |
|---|---|---|---|
| Operations | Modal header chip | `WhatsApp opted-in` | `SMS opted-in` |
| Operations | Payments tab | `Receipt sent via WhatsApp + email` | `Receipt sent via SMS + email` |
| Operations | New-appointment button | `WhatsApp` | `SMS` |
| Operations | Toast on `m` key | `WhatsApp to {name}` | `SMS to {name}` |
| Operations | Toast on reschedule | `{name} notified via WhatsApp` | `{name} notified via SMS` |
| Operations | Toast on confirm | `Reminder via WhatsApp` | `Reminder via SMS` |
| Operations | Toast on message send | `Delivered via WhatsApp` | `Delivered via SMS` (strict relabel; optional later correction to "Sent via SMS") |
| Operations | Toast on notify | `Ready-for-pickup sent via WhatsApp` | `Ready-for-pickup sent via SMS` |
| Operations | Toast on payment link | `Secure link via WhatsApp` | `Secure link via SMS` |
| Operations | Alert "Message customer" toast | `WhatsApp to {name}` | `SMS to {name}` |
| Operations | Message channel tags | `Automated · WhatsApp`, `Automated · Email + WhatsApp` | `Automated · SMS`, `Automated · Email + SMS` |
| Payments | Send-receipt toast | `… via WhatsApp + email` | `… via SMS + email` |
| Payments | Collect sheet permission box | `Receipt goes out by WhatsApp and email.` | `Receipt goes out by SMS and email.` |
| Settings | Emergency option sub | `WhatsApp, with SMS fallback` | `Sent by SMS` |
| Settings | Preview label | `Preview · WhatsApp to Liam` | `Preview · SMS to {first name}` |

The Settings label "They’ll get an SMS invite to set up their login." is already SMS.

**SMS delivery states (text-only, in existing slots)**
- A failed or queued message appends " · Failed" or " · Queued" to the bubble's time text.
- A customer who sent STOP shows `SMS opted-out` in the header chip slot, with the dot and text in `var(--ink3)`.
- Device health and inbound replies appear as Needs Attention alert cards.
- SMS Gate device offline appears as a red alert card (bell dot on).

**Squarespace (card actions are recorded, then flagged until confirmed)**
- An event not yet matched to the Transactions feed appends " · Awaiting Squarespace" to the ledger meta line and uses the amber pill text "Payment pending" or "Refund pending".
- The Collect sheet "Card on file" records the payment as confirmed by staff, with the same wording. The Collect sheet "Payment link" attaches a Squarespace checkout or invoice link and texts it. If no link template exists for the appointment, the sheet shows one extra input in the existing Settings input style ("Squarespace invoice or checkout URL"). This is a flagged addition (§7).
- A sheet permission box can carry a second line, for example "Card refunds are completed in Squarespace after approval". That is a text-only deviation.
- Card-on-file display derives from the latest transaction, else "Managed in Squarespace". The Operations Membership tab displays Squarespace subscription data (renewal date, credits). The designs have no connection-status screen (`set.billing` has no UI). Sync health surfaces as a Needs Attention alert, and a dedicated Integrations screen is an open question (§7).

### 4.5 Permission key to UI map (all 27 keys)

| Key | UI effect |
|---|---|
| `sched.view` | Operations route access (else the locked card). |
| `sched.edit` | New Appointment, Walk-in, reschedule drag, create. |
| `sched.cancel` | Reserved (no UI in the designs). |
| `sched.override` | Select a blocked slot (toast). |
| `jobs.status` | Advance, assign to bay, swipe, drag. |
| `jobs.checklist` | Checklist toggles, photo add. |
| `cli.view` | The appointment file modal. |
| `cli.contact` | Phone and email display (masked text if missing). |
| `cli.edit`, `cli.export` | Reserved. |
| `cli.member` | Membership actions, Settings VIP. |
| `pay.collect` | Collect, Apply credit, Mark Paid, payment link. |
| `pay.refund` | Refund, approve and deny (with limit). |
| `pay.adjust` | Adjust (with limit). |
| `pay.credit` | Issue credit (with limit). |
| `pay.void` | Mark unpaid. |
| `pay.reports` | The whole Payments screen. |
| `msg.send` | Template pills and message send. |
| `msg.auto`, `msg.broadcast` | Reserved. |
| `team.view` | Employees list. |
| `team.edit` | Add and save employees. |
| `team.roles` | Roles matrix, drawer access tab. |
| `set.hours` | Hours and closures. |
| `set.emergency` | Emergency. |
| `set.services` | Packages and checklists. |
| `set.billing` | No UI in the designs (reserved for an Integrations or Billing screen). |

---

## 5. Fidelity verification harness

### 5.1 Environment (AL2023 aarch64)
```bash
sudo dnf install -y nss atk at-spi2-atk cups-libs libdrm libxkbcommon libXcomposite \
  libXdamage libXfixes libXrandr mesa-libgbm pango alsa-lib fontconfig dejavu-sans-fonts
# + a Noto sans and a color emoji font (verify names with `dnf search noto emoji`)
PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-arm64 npx playwright install chromium
```
- **Vendored fonts for determinism:** also vendor DejaVu and Noto Emoji TTFs under `parity/fonts/`, with a `parity/fontconfig/fonts.conf`. Point `FONTCONFIG_FILE` at it so both pages resolve the same fallback glyphs (⚠ ★ ↩ ± ◆ ↑ ↓ ‹ › ✕ − → ⭐) regardless of the host.
- **Browser flags:** one worker, `--disable-dev-shm-usage --force-color-profile=srgb --font-render-hinting=none --disable-lcd-text`, deviceScaleFactor 1, `--no-sandbox` if needed.
- **Original baseline:** `parity/serve-original.ts` serves `design/original/*.bundle.html`, rewritten with only the copy-map (§5.3), at `http://127.0.0.1:4310/orig/<screen>.html`. The original runs offline (all assets are inside the bundle).
- **Network:** `context.route('**/*')` aborts everything except the two local origins.

### 5.2 Determinism
Pin before every page load: `timezoneId:'America/New_York'`, `locale:'en-US'`, `page.clock.install({time:'2026-06-13T10:36:00'})`, a fresh `localStorage` per context, an explicit URL hash, and viewport 1480×1000 for all three (a gate), plus 1280×800 and 1920×1080 (informational). Disable CSS animations. Hide `#__claude_design_branding` on the original. Wait for `#dc-root .sc-host`, then `document.fonts.ready` and `document.fonts.check('800 14px Manrope')`, then one animation frame. Advance time only with `page.clock.runFor(ms)`.

### 5.3 Feeding the port the same fixtures
- **Fixture capture (`parity:record`):** run the original, then capture its logic instance by patching `Logic.prototype.renderVals` (the class is reachable from `window.__dcRegistry`, a Map of entries) and kicking the entry's `subs` so it re-renders. Dump `logic.state` and the `renderVals()` result (functions replaced with `"[fn]"`, React elements serialised) to `parity/golden/<screen>.json`.
- **Parity data port:** `NEXT_PUBLIC_PARITY=1` builds `data/parity/*` and a `window.__oasisParity` hook. A `legacyToApi` mapper (test code) converts the dump to API-shaped read models.
  - The parity build skips auth. The session is injected with `addInitScript` (`window.__PARITY_BOOT__` = the session, the fixtures and the clock config).
  - There are no extra routes, and the production build contains none of this.
- **Record and replay for interactions:**
  - Scenario run on the original: after each action, dump `state`. The port replays the same actions with a `ReplayPort` whose command responses are `legacyToApi(snapshot[i])`.
  - This tests presentation parity given the same server state. Business-logic correctness is tested in the backend repo. The same `legacyToApi` fixtures also seed backend integration tests, which supports the "seed demo data" decision.
- **Deviation handling (no masking where avoidable):**
  - The SMS copy: the baseline is the original with the copy-map applied before boot (decoded template and logic strings, re-encoded). Pixel diffs therefore stay at threshold 0, including layout shifts from the changed word widths.
  - Real-data fields (fabricated numbers): allow-listed by path or selector in `parity/allowlist.json`: `kpis[0].sub`, `kpis[4].value`, `renewDate`, `lifetimeSpend`, `avgFreq`, "4 visits in 60 days", `payMethod`, closure counts, `ncAffected`, `emRebooked`, the "Rafael M." chip if the fixture user differs, and the emergency history detail.
  - Bug fixes are allow-listed per scenario step with a reason: the Added/Removed toast, singular and plural copy, the Review jump, the `n` title reset, and the date-input `color-scheme` in dark mode.
  - Each entry has `{id, screen, scope, matcher, kind, reason}` and appears in `DEVIATIONS.md`. CI fails if an entry matches nothing (stale) or matches more nodes than declared.

### 5.4 Checks per step
1. **DOM snapshot equality.** `#dc-root` outerHTML is read from both pages, re-serialised through `parse5`, and compared. The parity variant includes `data-dc-tpl`, so original and port are compared with that attribute present. Strip only `data-sc-name`. `style` attribute strings must be byte-equal, which holds when key order is preserved.
2. **Per-node computed style and bounding box.** Pair elements by `data-dc-tpl` and loop index. Compare `getBoundingClientRect` (0.01 px tolerance) and a curated list of about 60 layout and paint properties. Compare the full property set only at the initial step.
3. **Pixel diff.** `page.screenshot({animations:'disabled', caret:'hide'})` on both pages, `pixelmatch(a, b, diff, w, h, {threshold:0, includeAA:true})`. The default tolerance is 0 mismatched pixels. Any tolerance lives in `parity/tolerances.json` with a rationale (for example `backdrop-filter` regions if software rasterisation proves nondeterministic).
4. **renderVals parity.** Both sides expose `renderVals()` (the original through the patched prototype, the port through `__oasisParity.getVals()`). Serialise with ordered `JSON.stringify` (key order matters for style objects), after applying the copy-map to the original and applying the allow-list, then compare.
5. **Binding warnings.** The port logs any unresolved binding in dev builds, and CI fails on it. The original's `[dc-runtime] … never resolved` console warnings are recorded once as a baseline.

### 5.5 Scenarios

**Operations (O):**
- O01 initial light and dark.
- O02 range tabs, and O03 the four view tabs.
- O04 search typing and clearing.
- O05 each of the eight modal tabs.
- O06 checklist (single, section, all).
- O07 add-on on and off.
- O08 all seven message templates.
- O09 Mark Paid.
- O10 membership member and non-member.
- O11 modal keys m, p, s, r, Esc.
- O12 New Appointment and Walk-in: service, slot, blocked and VIP toasts, Book.
- O13 the advance chain: confirm, arrive, start, complete, collect.
- O14 mouse drag to a free and to a busy bay.
- O15 touch long-press drag (via CDP `Input.dispatchTouchEvent`, with `clock.runFor(380)`).
- O16 swipe right and left on a timeline card.
- O17 Up Next drag.
- O18 calendar day, week, month, with prev, next, Today and the keys `←`, `→`, `t`.
- O19 chip drag to an hour row (reschedule).
- O20 calendar touch swipe.
- O21 emergency banner.
- O22 closed day.
- O23 each alert action.
- O24 Ready & Completed chips.
- O25 toast lifetime (3200 ms).
- O26 live clock and bay elapsed (`runFor` 1000 and 60000).
- O27 "Assign next vehicle" with nothing queued.

**Payments (P):**
- P01 initial, and P02 theme.
- P03 the four ranges, and P04 the five filters and counts.
- P05 search.
- P06 select one invoice per status (Paid, Unpaid, Partially paid, Partially refunded, Refunded, Canceled · refunded).
- P07 the pending banner Review jump.
- P08 refund (full, by item, custom; destinations; over-limit approval; blocked).
- P09 adjust (discount and surcharge, $ and %, settle, over-limit blocked).
- P10 issue credit.
- P11 collect (three methods).
- P12 apply credit.
- P13 approve and deny, as an allowed and a not-allowed role.
- P14 Preview-as menu for each role, including the locked state.
- P15 Export CSV toast, and P16 toast timing (3000 ms).
- P17 sheet close paths (scrim, X, Cancel).
- P18 disabled-action tooltips (`title`).

**Settings (S):**
- S01 initial (hours), light and dark.
- S02 each of the eight sections via the rail.
- S03 hours: day toggle, steppers, copy Monday, dirty bar, Discard, Save; booking-rule segs.
- S04 closures: reduced-hours form, both validation errors, add, notify toggle, remove, federal toggle.
- S05 emergency: reasons, durations (until and days), message edit and preview, toggles, confirm dialog, active state, reopen, history, and the `#emergency` deep link.
- S06 employees: search, role filters, open drawer (existing and new), three tabs, role toggles, Role/Allow/Deny, schedule steppers, validation errors, save, deactivate.
- S07 roles: card counts, matrix toggle, limit chip cycle, locked toast, custom role add and remove.
- S08 VIP: holds (add, duplicate, remove), steppers, toggles, segs, cadences, clients.
- S09 arrival: toggles, segs, step text.
- S10 services: kind seg, select, edit task, up, down, remove, add with Enter.

**Harness self-tests:**
- Original versus original with two fresh loads must give zero diff (the determinism gate).
- A deliberately injected 1 px change in the compiled output must fail the run (the sensitivity gate).

### 5.6 Commands, tags and artifacts
```
npm run parity:setup      # fonts check, Playwright install check, serve-original smoke
npm run parity:record     # writes parity/golden/**
npm run build:parity && npm run parity:all
npm run parity:dom | parity:pixels | parity:vals       # per check, with --grep @smoke | @full | O13
```
- **Tags:** `@smoke` (initial, theme and one modal per screen) runs on each push. `@full` runs nightly or on a labelled PR.
- **Artifacts** in `parity/out/<screen>/<scenario>/<step>/`: `orig.png`, `port.png`, `diff.png`, `dom.diff.txt`, `vals.diff.json`, plus the Playwright HTML report. CI uploads the whole folder. No baselines are stored: both renders happen live on the same machine, so there is no cross-machine drift.

---

## 6. Risks, mitigations, and replicate-versus-fix list

### 6.1 Risks

| Risk | Mitigation |
|---|---|
| App Router would silently use a vendored canary React | Pages Router plus `assert-react.mjs`. |
| SSR and hydration mismatches (localStorage and the clock at init) | `ssr:false` dynamic import, plus mounting providers after `useEffect`. |
| Fonts and glyph fallback | Self-hosted, `document.fonts.ready` gating in the harness, vendored fallback fonts, preload of the latin subsets. |
| Imperative style mutation fighting React | Preserve style-object keys and values and never memoise them (§2.5). |
| Gesture and touch behaviour regressions | Verbatim engine with CDP touch tests (O15, O16, O20). |
| Dark-mode fixed colours | Replicated (§6.2). The harness covers dark mode on every screen. |
| Toast animation quirk | Replicated (§6.2). |
| Huge generated TSX (compile time, memory) | `--max-old-space-size`, region sub-functions if needed, and `dc:check` to avoid hand edits. |
| `color-mix(in oklab, …)` support | Chromium 111 or newer. Confirm the target browsers. |
| Next 15 plus React 18 peer-dependency friction | Fallback to Next 14.2.x Pages. |
| Next security-patch cadence | Pin, run audit in CI, upgrade behind the parity suite. |
| Two renders per scenario on 2 vCPU | One worker, `@smoke` and `@full` tags. |
| Unmatched Squarespace or SMS state on screen | Alerts and ledger text (§4.4), plus server health endpoints. |

### 6.2 Replicate versus fix (default recommendation)

| Quirk | Default |
|---|---|
| Toast `oa-rise` animation overriding `translateX(-50%)` (the toast jumps during 220 ms) | **Replicate** for parity. Backlog the fix after sign-off. |
| Unused `oa-pulse`, `oa-spin`, `oa-toast` keyframes (the last has a typo) | **Replicate** (dead CSS, harmless). |
| Dark-mode fixed colours (warning box, retention "watch", member badge default, swipe underlay, WhatsApp-style green, notification dot, closure warning) | **Replicate**. |
| `alertCount` unused, photo grid 4 columns with 3 slots, free-bay UI differs between views, Needs Attention only on Bay Board, no hover states | **Replicate**. |
| Mouse swipe unsupported, role menu not closing on outside click | **Replicate**. |
| "Assign next vehicle" only opens the file | **Replicate**. |
| Inverted Added/Removed toast | **Fix**. |
| Timeline "Today" divider on a day-1 first group | **Fix**. |
| `n` hotkey not resetting the title; hotkeys firing with Ctrl or Cmd (Ctrl+R advances and reloads) | **Fix**. |
| `m` toast without a tab switch | **Fix**. |
| Range tabs "Next 24h" and "Week" that filter nothing | **Fix** (real windows, §4.1). |
| Reschedule without hour or capacity checks | **Fix** server-side. |
| Membership alert matching only the exact string `Premium` | **Fix** (tier id). |
| Singular and plural bugs ("1 refund", "1 invoices", "1 clients", "1 customers", "1 people") | **Fix**. |
| "Credits issued" counting invoices instead of clients | **Fix**. |
| Banner Review leaving the selected invoice hidden | **Fix** (clear filter and search). |
| Self-approval of refunds, Deny with no permission check, settlement refund bypassing limits | **Fix** server-side (open decisions, §7). |
| Adjust ledger amount shown unsigned in red | **Replicate**. |
| `togglePay` unpaid bypassing the ledger | **Fix** (through the ledger and `pay.void`). |
| Hard-coded card (Visa ••4421), KPI sub-labels, renewal date, lifetime spend, cadence, closure counts, "6 appointments left" | **Real data**. |
| Deactivate then Reactivate turning "invited" into "active" | **Fix**. |
| Role filter staying after the role is removed | **Fix**. |
| Native date input unthemed in dark mode | **Fix** (`color-scheme`). |
| Matrix sticky `top:-22px` depending on body padding | **Replicate**. |
| Prototype branding badge | **Drop**. |

---

## 7. Delivery order and what the user must supply or decide

**Order of work**
1. Extract the design and verify checksums.
2. Build the compiler with golden tests.
3. Build the `DCHost` shim and the three screens running the original logic in parity mode.
4. Build the harness and reach zero diffs.
5. Add the live `DataPort`, commands and SSE.
6. Apply the SMS and Squarespace text deviations.
7. Fix the bug list.

**Credentials and environment the dashboard needs**
- `NEXT_PUBLIC_API_BASE` and the OpenAPI document location (`OASIS_OPENAPI`).
- The public dashboard hostname and TLS (needed for Secure cookies).
- The `OASIS_SESSION_COOKIE_NAME` value agreed with the backend.
- Nothing else is dashboard-side. SES, S3, Squarespace and SMS Gate keys belong to the backend.

**Decisions and sign-offs needed**
1. New surfaces: the login page, the boot splash, the sign-out menu, the locked card for sections a user cannot access, real inputs in the New Appointment panel, and the Squarespace-link input in the Collect sheet.
2. An Integrations or Billing screen for Squarespace sync and SMS device health. Default: alerts only.
3. The "N booked" definition, the "late" grace period, and the Bay-time-free formula.
4. Self-approval of refunds, and whether the settlement refund counts against the refund limit.
5. VIP client resolution: a free-text name that matches no customer.
6. Whether Customer Support (refund, adjust and credit but no `pay.reports`) should see Payments.

I wrote one scratch copy of the set-ui report to the session scratchpad so I could page through it. I wrote no other files, and I changed nothing in the repos or the design bundles.

### Critical Files for Implementation
- /home/ec2-user/oasis/dashboard/tools/dc-compile/index.ts
- /home/ec2-user/oasis/dashboard/src/dc/DCHost.tsx
- /home/ec2-user/oasis/dashboard/src/screens/operations/Logic.ts
- /home/ec2-user/oasis/dashboard/parity/playwright.config.ts
- /home/ec2-user/oasis/dashboard/design/extracted/operations/template.html