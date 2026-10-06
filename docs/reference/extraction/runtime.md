<!-- Reference material generated during planning (2026-10-06) from the three Claude Design prototypes. Source of truth for the build; see docs/plan.md. -->

# DC runtime semantics and mechanical port strategy for the Oasis designs

Sources:
- The saved bundles at `.../tool-results/artifact-{1f91dadc (cc), 7b5d00b0 (pay), 0adf91e6 (set)}*.html`.
- The decoded dc-runtime, which is identical in all 3 files. It was built from `dc-runtime/src/*.ts`: react, parse, boot, expr, encode, compile, logic, component, bundled, cdn, external, atomics, helmet, pseudo, registry, runtime, stream-state and index.
- All counts below were measured on the template text, not estimated.

## 1. Template language reference

### 1.1 File and bundle structure
- The design file is `<x-dc> …template… </x-dc>` followed by `<script type="text/x-dc" data-dc-script data-props='…'>class Component extends DCLogic {…}</script>`.
- `boot()` reads `x-dc.innerHTML` as the template and `script[data-dc-script].textContent` as the logic source.
- It then replaces `<x-dc>` with `<div id="dc-root">` and renders `<Root>` with React 18 `createRoot(hostEl).render(...)`.
- Only `cc` has `data-props='{"$preview":{"width":1480,"height":1000}}'`.
  - `$preview` is design-time only: it is the frame size hint for the editor.
  - When `$preview` is present, the runtime does not append `FULL_PAGE_CSS`.
- `pay` and `set` have no `data-props`, so they get `html,body{height:100%;margin:0}#dc-root,#dc-root>.sc-host{height:100%}` appended to `<head>`.
- Props other than `$`-prefixed keys would become `propsMeta` defaults. None exist in any design, and `this.props` is never read in any script.
- Fixed `<head>` of every bundle: `<meta charset>`, `<meta viewport width=device-width, initial-scale=1>`, and `<script src=runtime>`.

### 1.2 Elements
| Construct | Runtime behaviour |
|---|---|
| `<helmet>` | Encoded to `<sc-helmet>`. `host.helmet(el)` returns a builder that renders `null` but appends its children to `document.head`. |
| `<sc-if value="{{ expr }}">` | Renders `Fragment(kids)` if the resolved value is JS-truthy, else `null`. |
| `<sc-for list="{{ expr }}" as="name">` | Resolves `list`. If it is not an array, it renders `[]` (a warning is logged unless the value is null or undefined). For each item `i` it renders `Fragment key=i`, wrapping the kids with scope `{...vals, [as]: item, $index: i}`. |
| `hint-placeholder-val`, `hint-placeholder-count`, `hint-size` | Used only while the editor is streaming (`__streamingNow`). They are inert at runtime. |
| `sc-else`, `x-import`, `dc-import` | `x-import`, `dc-import` and `sc-else` are not used in these designs. `x-import` and `dc-import` exist in the runtime, and `sc-else` is only referenced in a regex. |

`<helmet>` handling by child type:
- `<script>`, `<link>` and `<meta>` are appended once, deduplicated by key.
- Every other child (here `<style>`) becomes a live `<style>` element in `<head>`, with `textContent` copied verbatim.
- `{{ }}` inside `<style>` is not interpolated. The helmet in all 3 designs contains only:
  - `<link rel=preconnect href=https://fonts.googleapis.com>`
  - `<link rel=preconnect href=https://fonts.gstatic.com crossorigin>`
  - `<style>` #1, the 42 `@font-face` blocks
  - `<style>` #2, the global CSS

### 1.3 `{{ expr }}` is NOT JavaScript
This is the `resolve(vals, src)` grammar:
- Trim the source. If the whole thing is wrapped in matching `(…)`, recurse on the inside.
- Find a top-level `===`, `!==`, `==` or `!=` (outside `[]` and `()`). If one exists, resolve both sides and compare.
- A leading `!` negates the resolution of the rest.
- Literals: `true`, `false`, `null`, `undefined`, numbers matching `^-?\d+(\.\d+)?$`, and `'…'` or `"…"` strings.
- Otherwise it is a path: `IDENT(\.IDENT|\.digits|\[expr\])*`, resolved with null-safe navigation against the flat `vals` object.
- There is no `&&`, `||`, `?:`, `+`, arithmetic, function calls, or `.length`.
- Functions are not called. If `{{ fn }}` is used in an attribute, the function itself is passed. In text, a function would print as `String(fn)`.

Forms actually used (all 1,075 expressions across the three templates):

| Design | Total | Bare ident (`theme`) | Dotted path (`a.b`) | Equality, `!`, `[]`, literals, parens |
|---|---|---|---|---|
| cc | 488 | 142 | 346 | 0 |
| pay | 190 | 50 | 140 | 0 |
| set | 397 | 181 | 216 | 0 |

- `{{ true }}` and `{{ false }}` appear only as `hint-placeholder-val` values: cc 50 true and 16 false, pay 1 and 18, set 6 and 32.
- `$index` is available in loop scope but is never used in any template.
- Consequence: every string, label, colour and boolean must be precomputed in `renderVals()`. The template does no logic.

### 1.4 Where `{{ }}` is evaluated

**Attribute values** (`compileAttr`):
- A whole-value binding `^\s*\{\{([\s\S]+?)\}\}\s*$` returns the raw resolved value. That value can be a function, object, boolean, number, undefined or a ref.
- A mixed value splits on `{{…}}` and joins with `resolve(...) ?? ''`. Booleans become the strings `"true"` or `"false"`.
- Static values stay strings.
- Edge case: the lazy whole-value regex misparses `"{{a}} x {{b}}"`. This does not occur in these designs.

**Text nodes** (`walkText`):
- A text node without `{{` and with `!trim() && !includes(" ")` (newline-only, no space) renders `null` and is dropped.
- All other static text is returned verbatim, including whitespace-only text that contains a space.
  - Because indentation contains spaces, nearly all inter-element whitespace is kept as a text node.
  - Counts of kept versus dropped whitespace-only nodes: cc 793 kept and 2 dropped, pay 222 and 2, set 556 and 2.
- A text node with `{{` becomes `Fragment(key)` containing, for each part:
  - Static parts as raw strings, whitespace preserved.
  - `undefined` renders `null`, with a once-only console warning: `[dc-runtime] <name>: {{ x }} never resolved — rendered as empty`.
  - A React element or array renders `Fragment(v)`.
  - `null` or boolean renders `null`.
  - Anything else renders `<span class="sc-interp" key=i>{String(v)}</span>`. This includes `''` (an empty span) and `0` (`"0"`).
- Consequence: every interpolated text value is wrapped in an extra `<span class="sc-interp">`.
  - It occurs 172 times in cc, 56 in pay and 106 in set.
  - It changes the DOM, and it changes flex and grid item boundaries. For example, `Mark Paid · {{ sel.payBig }}` inside a flex parent gives two flex items.
- For pixel-identical output the port must keep the wrapper spans.

### 1.5 Attribute name transforms
- The source templates already contain the encoded forms: `sc-camel-view-box` (cc 28, pay 6, set 21), `sc-camel-on-click` (cc 51, pay 25, set 91), `sc-camel-on-input`, `sc-camel-on-pointer-down`, `sc-camel-on-pointer-up`, `sc-camel-on-context-menu`, and `sc-camel-on-key-down` (set 1).
- Encoding step (`encodeCase`): `CAMEL_ATTR_RE = /(\s)([a-z]+[A-Z][A-Za-z0-9]*)(\s*=)/g` rewrites a camelCase attribute `fooBar=` to `sc-camel-foo-bar=`.
  - The HTML parser would otherwise lowercase it.
  - The regex runs over the whole template string, including text.
- Decoding (`collectProps`): for a name starting with `sc-camel-`, strip the prefix and apply `kebabToCamel` (`-x` becomes `X`). This gives `view-box` → `viewBox` and `on-click` → `onClick`.
- For DOM elements (`kind === "dom"`):
  - `class` → `className` and `for` → `htmlFor` (neither is used in these designs).
  - A key starting with `on` becomes `EVENT_MAP[key] || "on" + key[2].toUpperCase() + key.slice(3)`.
  - So `onClick`, `onInput`, `onKeyDown`, `onPointerDown`, `onPointerUp` and `onContextMenu` pass through unchanged.
  - Other lowercase events map through `EVENT_MAP` (`onclick`→`onClick`, `ondoubleclick`→`onDoubleClick`, and so on).
- Everything else is passed to React as written:
  - Hyphenated names stay as-is: `stroke-width`, `stroke-linecap`, `stroke-linejoin`, `data-*`.
  - Lowercase names stay lowercase: `inputmode`, `placeholder`, `rows`.
  - The production React UMD sets unknown attributes as attributes, so the resulting DOM attributes are identical.
- `sc-name` and `data-dc-tpl` are skipped.
- `style-<pseudo>` attributes (generated pseudo-class rules, `!important`-ified) are supported by the runtime but not used here.
- `hint-size` is dropped.

### 1.6 Style handling
- At render, if the `style` prop is a string, `cssToObj` is applied:
  - Split on `;`.
  - Split each declaration at the first `:`.
  - Trim both parts.
  - Convert the property with `kebabToCamel`; a property starting with `--` is kept as-is.
  - `-webkit-x` becomes `WebkitX`.
  - There is no `!important` handling and no quote-aware splitting. React ignores `!important` values on `style[prop] =`.
- If the `style` prop is an object, it is passed straight to React. In every dynamic style binding in the scripts it is a camelCase object with string values.
  - The only numbers are unitless: `fontWeight`, `flex`, `zIndex`, `opacity`, `lineHeight`, and `left:0`. No `px` is added or needed.
- Measured counts:
  - Elements with a `style` attribute: cc 509, pay 168, set 410.
  - Pure `style="{{ x }}"` bindings: cc 69, pay 28, set 57.
  - Mixed static and `{{ }}` style strings: cc 10, pay 4, set 2. Example: `…background:{{ k.accent }};`.
  - `grid-template-columns:{{ matrixCols }}` in set.
  - `conic-gradient(var(--accent) {{ sel.checkPct }},var(--panel3) 0)` in cc.
- No static style contains `!important`, `url(`, a CSS comment, or a `;` inside parentheses. No static style uses a `--var` declaration (the `var()` uses are references).
- The only vendor properties are `-webkit-font-smoothing` (all three, on the root div), plus `-webkit-user-select` and `-webkit-touch-callout` in cc.
- A `<style>` string never reaches the runtime's pseudo-class path (no `style-hover`).
- `value` and `checked` props that resolve to `undefined` become `''` and `false`.
  - All 5 pay inputs, 10 of the set inputs and the cc search input are `value` plus `onInput`, with no `onChange`.
  - This is a controlled input with `onInput` only. In production React it works silently.

### 1.7 Other details
- `<style>` and `<script>` in the template are not scoped. They are copied to `document.head`.
- Entities: the template is serialised from the DOM (`x-dc.innerHTML`) and then re-parsed. Only `&amp;` appears: cc 5, pay 3, set 5. They decode to `&` in text.
- Non-ASCII characters appear as literals:
  - cc: `… · → — ⚠ ★`
  - pay: `→ … ·`
  - set: `· ‹ › – … ✕ − ↑ ↓`
- Text containing `'` and `"` appears raw, for example `The {{ roleName }} role doesn't include "View payment reports"...`.
- `ref="{{ ghostRef }}"` is passed straight to React (`props.ref`). The value is `React.createRef()` from the logic class.
- `data-drop="{{ b.drop }}"` is a plain attribute. Values look like `bay:N` and `hr:N`, and they are read by `elementFromPoint(...).closest('[data-drop]')`.
- `<a href="Oasis%20Command%20Center.dc.html">` and its Payments and Settings equivalents are cross-design navigation, plus `Oasis%20Settings.dc.html#emergency`. These hrefs need remapping to real routes.
- `RAW_WRAP` renames `select, table, tbody, thead, tfoot, tr, td, th, caption` to `sc-raw-*` before parsing, to avoid HTML foster-parenting. None of these tags occur in the designs.
- Parsing runs through `<template>.innerHTML`, so it follows the HTML5 fragment parser with `template` as the context element. That matters for the port parser (§4).
- The runtime stamps `data-dc-tpl="N"` (the element's template-order index) on every element, and `data-sc-name` on the host. These are DOM noise to strip when comparing.
- On the DOM, the original structure is `#dc-root > div.sc-host[data-sc-name][data-dc-tpl] > [template children]`.
  - `.sc-host` has no CSS in the designs except through `FULL_PAGE_CSS` (`height:100%`).
  - If `renderVals` or the constructor throws, it renders `div.sc-logic-error` (red box).

## 2. Logic runtime

### 2.1 `DCLogic` (alias `StreamableLogic`) API
- `constructor(props)` sets `this.props = props||{}` and `this.state = {}`.
- Subclass class fields run after the base constructor. This matters because the scripts use `state = (() => {…})()` and field initialisers such as `ghostRef = React.createRef()` and `_gm = (e) => {…}`.
- `setState(update, cb)`:
  - `update` is an object or `(prev) => patch`. It is applied synchronously: `this.state = {...prev, ...patch}` happens immediately.
  - `this.state` is therefore up-to-date on the very next line.
  - The re-render is a React `setState` bump. `cb` is the React setState callback and fires after the commit.
  - It is a no-op until `__host` is attached after construction.
- `forceUpdate()`.
- Lifecycle hooks: `componentDidMount()`, `componentDidUpdate(prevProps)` and `componentWillUnmount()`, all in try/catch.
- `renderVals()` returns the flat object the template renders against. At render, `vals = {...userProps, ...renderVals()}`, so `state` is not visible to the template unless `renderVals` exposes it.
- `renderVals` runs on every render, including every second in cc (see `tick` below).
- Logic source is eval'd with `new Function("DCLogic","StreamableLogic","React", src + '\n;return Component')`. `React` and `DCLogic` are in scope as free variables, so scripts can call `React.createElement` and `React.createRef`.
- Errors:
  - A constructor error falls back to the no-op base class.
  - A `renderVals` error logs and renders a red `.sc-logic-error` banner.
  - A render crash is caught by `getDerivedStateFromError`.

### 2.2 Events and handlers
- Handlers are the resolved function values. React 18 calls them as `fn(syntheticEvent)` with `this` undefined.
- All handlers are arrows defined in `renderVals` or in class fields, closing over `this` and loop data. Examples: `onClick: () => this.setState(...)`, `onPointerDown: (e) => this.gStart(e, a, 'tl')`.
- Handlers read `e.target.value`, `e.currentTarget`, `e.key`, `e.clientX/Y`, `e.pointerType`, `e.button`, and call `e.preventDefault()` and `e.stopPropagation()`.
- React's delegated listeners attach to `#dc-root`. The scripts also use native listeners on `window` and `document` (§2.3).
- The runtime does not use StrictMode. Next.js dev defaults to StrictMode, which double-mounts. The cleanup in `componentWillUnmount` makes that safe.

### 2.3 Browser APIs used by the scripts
- **cc:**
  - `localStorage` keys: `oasis-theme`, `oasis-checklists`, `oasis-hours`, `oasis-closures`, `oasis-emergency`. Reads are wrapped in try/catch.
  - `setInterval` every 1,000 ms to bump `tick`, which forces a re-render every second. One `setTimeout` of 380 ms for touch long-press-to-drag, plus a toast timeout.
  - `window` listeners: `keydown`, `pointermove`, `pointerup` and `pointercancel`. A `document` `touchmove` listener with `{passive:false}`.
  - Direct DOM use: `document.getElementById('oa-search').focus()`, `document.elementFromPoint`, `closest('[data-drop]')`, `document.body.style.userSelect`, `navigator.vibrate`, and imperative `el.style.transform` and `transition` on the dragged element and on `ghostRef`.
  - Keyboard shortcuts: `/` focuses search, `Escape`, `n`, `←` `→` `t` in the calendar, and `m`, `p`, `s`, `r` in the modal.
  - Time: `BASE = new Date(2026,5,13)`; `NOW = 10*60+36` is a constant; `Date.now()` is used for `startedAt` and elapsed time; `nowClock()` reads the real clock. `dateLabel:'Saturday, June 13'` is hard-coded. `toLocaleString('en-US')` is used.
  - `rng()` is a seeded mulberry32. There are no `Math.random` calls.
  - `dangerouslySetInnerHTML` spans for icons: `renderIcon(svg)` is used by `v.icon` and `t.icon`, two template bindings in cc. They render as a plain `<span>` containing the raw SVG, inside an outer inline-flex span.
- **pay:**
  - `localStorage` keys: `oasis-theme`, `oasis-roles`.
  - `nowT()` uses the real clock (`'Today h:mm AM'`).
  - `dateOf(off) = new Date(2026,5,13+off)`.
  - `toLocaleString('en-US',{minimumFractionDigits:2,…})`.
  - `toLocaleDateString('en-US',{month:'short',day:'numeric'})`.
  - Constant `TAX = 0.07`.
  - One 3 s toast timeout.
  - No keyframes or animations at all.
- **set:**
  - `localStorage` keys: `oasis-theme`, `oasis-emergency`, `oasis-vip`, `oasis-hours`, `oasis-roles`, `oasis-closures`, `oasis-checklists`.
  - `componentDidMount` checks `location.hash === '#emergency'`.
  - `TODAY='2026-06-13'`.
  - `Date.now()` is used for ids (`'c'+Date.now()`, `'e'+Date.now()`, `'custom'+Date.now()`).
  - `new Date(date+'T12:00:00')` and `toLocaleDateString('en-US',{weekday:'long',…})` are used.
  - No keyframes or animations.
- `theme` comes from `localStorage.getItem('oasis-theme') || 'light'` and is exposed as `data-theme="{{ theme }}"` on the root div. The CSS variables for light and dark are keyed on `[data-theme]`.
- Not used anywhere: `fetch`, `sessionStorage`, `Intl.*` directly, `Math.random`, `matchMedia`, `ResizeObserver`.

### 2.4 Re-render model
- `StreamableComponent` is a React class component. `setState` bumps `__v`, which re-runs `render()`, `renderVals()` and the whole compiled template into React elements. React then diffs.
- There is no memoisation. The scripts rely on React's diff, and in cc the whole tree re-renders every second.

## 3. Inventory across the three templates

| Construct | cc | pay | set |
|---|---|---|---|
| Elements: `div` | 383 | 121 | 244 |
| `button` | 52 | 23 | 87 |
| `span` | 82 | 25 | 69 |
| `svg` | 28 | 6 | 21 |
| `path` | 30 | 7 | 24 |
| `circle`, `rect` | 6, 2 | 1, 1 | 5, 1 |
| `input` | 1 | 5 | 9 |
| `textarea` | 0 | 0 | 1 |
| `a` | 5 | 3 | 3 |
| `header` / `nav` / `main` / `section` / `aside` | 1/1/1/2/2 | 1/1/1/0/1 | 1/1/1/1/1 |
| `<sc-if>` | 66 | 19 | 38 |
| `<sc-for>` | 33 | 22 | 39 |
| Max `sc-for` nesting | 2 | 1 | 3 |
| Max `sc-if` nesting | 3 | 4 | 3 |
| Max DOM depth | 16 | 14 | 15 |
| `{{ }}` total | 488 | 190 | 397 |
| Text bindings (nodes) | 172 | 56 | 106 |

- `sc-for` parents are only `div`, `section` and `sc-if` (and `sc-for` in set). `sc-if` parents are `div`, `button`, `span`, `main`, `section` and `sc-if`. No `<sc-if>` or `<sc-for>` is nested inside `<svg>`.
- `as=` names are short, for example `k v t g a ar b c q al s m d w r st cs ad p sl tp pr pk h ns` in cc. Some names repeat across sibling loops, so the compiler needs a scope stack.
- Attribute bindings:
  - Event handlers: cc has `onClick` 51, `onPointerDown` 4, `onContextMenu` 3, `onInput` 1 and `onPointerUp` 1. pay has `onClick` 25 and `onInput` 5. set has `onClick` 91, `onInput` 10 and `onKeyDown` 1.
  - Style, whole or mixed: cc 79, pay 32, set 59.
  - Also: `data-theme` (1 per design), `value` (cc 1, pay 5, set 10), `data-drop` (cc 3), `ref` (cc 1), `title` (pay 2), `disabled` (pay 2), `placeholder` (set 2).
- Non-trivial `{{ }}` forms: there are none. Everything is an identifier or dotted path, so no equality, negation, brackets or literals occur.
- Static attributes present and their handling:
  - SVG: `width`, `height`, `fill`, `d`, `stroke`, `stroke-width`, `stroke-linecap`, `stroke-linejoin`, `cx`, `cy`, `r`, `x`, `y`, `rx`, and `viewBox` (via `sc-camel-view-box`).
  - HTML: `title`, `placeholder`, `rows`, `inputmode`, `type="date"` (set 2), `id="oa-search"` (cc), and `disabled="{{…}}"`.
  - Each rename (`stroke-width` → `strokeWidth` and so on) produces the same DOM attribute.
  - There is no `class`, `for`, `aria-*` or `style-*` attribute anywhere.
- Fonts are 42 `@font-face` blocks per design.
  - Manrope: 400, 500, 600, 700 and 800, in 6 unicode-range subsets (cyrillic-ext, cyrillic, greek, vietnamese, latin-ext, latin).
  - Bricolage Grotesque: 500, 600, 700 and 800, in 3 subsets (vietnamese, latin-ext, latin). The `font-stretch:100%` descriptor is present.
  - There are 9 woff2 files per bundle (variable fonts, shared across weights). They are embedded as `data:` URIs.
- Global CSS in each helmet's second `<style>`:
  - `*{box-sizing:border-box}` and `html,body{margin:0;padding:0;height:100%;overflow:hidden}`.
  - Variables on `:root, [data-theme="light"]`, and a `[data-theme="dark"]` override.
  - `body{background:var(--bg)}`.
  - Scrollbar rules.
  - `input::placeholder`, `button{font-family:inherit;cursor:pointer;border:none;background:none}`, and `a` / `a:hover` colours.
- Palette differences per design: pay adds `--red`, `--redSoft`, `--amber`, `--amberSoft` (light and dark), and pay and set add `color:inherit` on `button`.
- Keyframes exist only in cc. Used inline: `oa-fade .18s ease` (×2), `oa-rise .24s cubic-bezier(.2,.7,.3,1)`, `oa-rise .22s ease` and `oa-slide .26s cubic-bezier(.2,.7,.3,1)`.
- Defined but unreferenced in cc: `oa-pulse`, `oa-spin` and `oa-toast`.
  - `oa-toast` has a typo: `transform:transl(0,14px)` (invalid CSS).
  - This is harmless because the keyframe is unused.
- The `<div id="__claude_design_branding">` ("Made with Claude Design") sits after the script. It is `position:fixed; right:16px; bottom:16px; z-index:2147483646`. It is part of the bundle, not the design.

## 4. Mechanical converter spec

### 4.1 Recommended architecture
1. A build-time compiler (Node script) that turns each `<x-dc>` template into TSX.
2. A small TS shim with the exact `DCLogic` and `StreamableComponent` semantics: synchronous `this.state`, `setState(update, cb)`, lifecycle forwarding.
3. The three `class Component extends DCLogic {…}` bodies copied verbatim as the logic layer. This is the quickest way to get identical behaviour before replacing fixtures with API data.

### 4.2 Parsing
- Use `parse5.parseFragment(html)` with the default `<template>` context, which matches the runtime's `<template>.innerHTML`.
- Do not use JSX, jsdom or cheerio in `xmlMode` (it does not follow the HTML5 algorithm for void tags, `<input>` and implied end tags).
- The template text must be the serialised `x-dc.innerHTML`, since that is what the runtime sees.
- Apply the same pre-pass as the runtime (`encodeCase`): `helmet` → `sc-helmet`, the `RAW_WRAP` renames (no-op here), and camelCase-attr encoding (a no-op here, since the source already has `sc-camel-*`).

### 4.3 Algorithm
`emit(node, scopeStack, slotIndex)` produces a JS expression string:

1. **Element** (not `sc-if`, `sc-for` or `sc-helmet`):
   - `tag` is the original tag. SVG tags stay lowercase, as in the source.
   - Build props from the attributes, skipping `data-dc-tpl` and `sc-name`.
   - Decode `sc-camel-*` via `kebabToCamel`.
   - For events (`on*`), use the `EVENT_MAP[key] || on + Upper(key[2]) + key.slice(3)` logic.
   - For `style`:
     - If static, parse with `cssToObj` at build time and emit a hoisted frozen object. Key order must equal the source declaration order.
     - If a whole-value binding, emit `css(<expr>)`, where `css(v) = typeof v === 'string' ? cssToObj(v) : v`.
     - If mixed, emit `css(` + the concatenated string with each `{{x}}` as `(resolve(x) ?? '')` + `)`.
   - For `value` and `checked`, emit `v === undefined ? ('' | false) : v`.
   - Rename hyphenated SVG attributes to React names:

     | In the source | Emitted prop |
     |---|---|
     | `stroke-width`, `stroke-linecap`, `stroke-linejoin` | `strokeWidth`, `strokeLinecap`, `strokeLinejoin` |
     | `inputmode` | `inputMode` |
     | `class`, `for` (not used) | `className`, `htmlFor` |

   - `data-*` pass through unchanged.
   - Children: emit each child with its slot index.
   - Emit `<input/>`-style self-closing JSX for void elements.
2. **Text**:
   - If the text does not contain `{{`: skip it when `!trim() && !includes(' ')`. Otherwise emit `{"…"}` with `JSON.stringify(text)`, which preserves every whitespace character and handles quotes and braces.
   - If the text contains `{{`: split on `/\{\{([\s\S]+?)\}\}/`. Emit `<>{"static"}{interp(expr)}{"static"}…</>`, with `interp` as in §1.4. This keeps the `<span className="sc-interp">`.
3. **`sc-if`**: emit `{cond ? <>children…</> : null}`, where `cond` is the resolved expression with JS truthiness (the runtime uses `v ? … : null`, so `[]` and `'0'` are truthy).
4. **`sc-for`**: emit `{(Array.isArray(list) ? list : []).map((item, i) => <Fragment key={i}>…</Fragment>)}`. Push `{as, $index}` onto the scope stack.
   - Identifier resolution walks the scope stack from the innermost loop variable out, then falls through to `vals.<ident>`.
   - Dotted paths emit with optional chaining (`a?.b?.c`).
5. **Resolver**: since only identifiers and dotted paths occur, emit `a?.b?.c` directly. If the expression grammar is ever extended, port `resolve()` verbatim into a runtime helper instead.
6. **Keys**: the runtime keys children by slot index (`j`) and loop item by `i`. In static JSX the slot positions are fixed, and `sc-if` renders `null` in the same slot. Key loop fragments by `i`, not by an item id, so reconcile and unmount behaviour match the original.
7. **Helmet**: do not emit it as JSX.
   - The two `<link rel=preconnect>` elements are redundant once fonts are self-hosted.
   - `<style>` #1 (fonts): extract each woff2 from the manifest at build time, write the files out, and keep the `@font-face` blocks verbatim with `src` pointing at the files and `font-family` names unchanged (`'Manrope'`, `'Bricolage Grotesque'`), because inline styles reference those names. `next/font` would rename the families, so use plain CSS `@font-face`.
   - `<style>` #2 becomes `globals.css` verbatim.
8. **Root wrapper**: keep `#dc-root > div.sc-host` if you want DOM parity. They only matter for the `height:100%` of `FULL_PAGE_CSS` on pay and set, and the inner div has `height:100vh` anyway.
9. **TS shim**: implement `class DCHost extends React.Component` with:
   - `logic = new Logic(props)`
   - `logic.__host = this`
   - sync `setState`, forwarding `componentDidMount`, `componentDidUpdate` and `componentWillUnmount`
   - render of `{...props, ...logic.renderVals()}`
   - Mark it `'use client'`.

### 4.4 Edge cases
- Whitespace: JSX trims line-leading and trailing whitespace. Always emit text as `{"…"}` literals. Dropping inter-element whitespace can change inline layout, and it changes the DOM text-node count.
- Unresolved values: `undefined` renders nothing and logs a warning. `''` still renders an empty `span.sc-interp`.
- `ref` on a host element works as-is with `createRef()`.
- Controlled inputs: with `value` plus `onInput` only, React keeps the input controlled. Using `onChange` instead would be equivalent but changes the prop name. Keep `onInput` for parity.
- Inline style objects must be fresh per render where they come from `renderVals`. The cc swipe and drag handlers mutate `el.style.transform` and `transition` imperatively, and React's style diff relies on this working the same way.
- Keep the document-order of `<style>` tags: the runtime appends `FULL_PAGE_CSS` (pay and set only) at boot, before the helmet styles.
- SSR and hydration: all three scripts read `localStorage` and the clock in the initial state (`theme`, `closures`, `hours`, and so on). Render client-only (`dynamic(..., {ssr:false})`) or defer reads to `useEffect`; otherwise there will be hydration mismatches. The 1 s `tick` is cc-only.
- React version: the originals use React 18.3.1 UMD. Pin React 18 for baseline parity. Next 15 App Router requires React 19, and React 19 changes some attribute handling and ref semantics. If React 19 is used, re-run the parity suite.
- CSS framework conflicts: do not combine with Tailwind preflight or any reset beyond the designs' own global CSS.
- Navigation: `href="Oasis%20…dc.html"` and `#emergency` need route mapping (suggest `/operations`, `/payments`, `/settings`), and `location.hash === '#emergency'` in set must keep working.

### 4.5 Test strategy (DOM-snapshot equality against the original runtime)
1. Load the original bundle in headless Chromium and the ported page at the same viewport. Pin the clock, timezone and locale (§5.3).
2. Take `document.querySelector('#dc-root').outerHTML` from the original and the port. Strip `data-dc-tpl` and `data-sc-name`, and compare. The `style` attribute strings should match byte-for-byte if the property order is preserved.
3. For each design, drive an identical interaction script on both and re-snapshot after each step:
   - Theme toggle.
   - cc: the view tabs (timeline, bay board, staff, calendar), range tabs, search typing, open appointment modal and its tabs, new-appointment drawer, calendar day, week and month modes, the keyboard shortcuts, and pointer drag to a bay (`data-drop`).
   - pay: filters, the sheet (refund, adjust, credit), amount inputs, and role menu (locked and unlocked).
   - set: every section nav, the hours editor, add closure, emergency flow, employee drawer, roles and permissions, and VIP.
4. Compare computed styles and `getBoundingClientRect` for every element, as a pixel-independent check.
5. Pixel-diff screenshots with `pixelmatch` at threshold 0. Original and port render on the same machine and browser, so exact equality is a reasonable target.
6. Logic parity check: wrap `renderVals` on the original (via `__dcRegistry`) and on the port, and diff the returned objects with functions stripped.
7. Also capture the original runtime's `console.warn` lines (`[dc-runtime] … never resolved`). They list any `{{ }}` the script does not provide, which are design inconsistencies to resolve once in the plan.

## 5. Original-render harness feasibility

### 5.1 Can the saved bundle render offline?
Yes. Everything is inside the file:
- The bootstrapper decodes the manifest entries from base64, gunzips them with `DecompressionStream('gzip')` (Chromium 80+), and turns JS assets into `blob:` URLs.
- Fonts become `data:` URIs, because strict hosts allow `font-src data:` but not `blob:`.
- The runtime, React 18.3.1 and ReactDOM 18.3.1 are in the manifest (3 JS assets plus 9 fonts).
- `__bundler/ext_resources` maps the unpkg React and ReactDOM URLs to those assets. The runtime's `cdnScriptFor` takes the `window.__resources` blob URL first and drops the `integrity` attribute, so there is no network fetch.
- `window.__resources` is injected as an object, so the runtime skips its `fetch(location.href)` hot-update path. Root `fetch` and sibling `fetch` are never needed.
- No Babel is loaded, because there is no JSX `x-import`.
- The only network references are the two `<link rel=preconnect>` hints, which fail harmlessly.
- Load via `http://localhost` (a static file server) rather than `file://`, for a stable origin and reliable `localStorage`. `file://` is supported by the bootstrapper but riskier.
- Wait for `#dc-root .sc-host`, then `document.fonts.ready`, then one frame.
- Hide `#__claude_design_branding` (`display:none`) before screenshots, or mask it.

### 5.2 What this host needs (checked, read-only)
- This host is Amazon Linux 2023 on **aarch64** (ARM), not x86_64. It has 2 vCPU, 7.8 GB RAM and 30 GB free disk.
- Installed: python 3.9.25 (no `pip3`, no `playwright` module). Not installed: node, npm, bun, chromium, chrome, firefox. No Playwright cache exists. `fc-list` printed nothing, so no system fonts are installed or `fontconfig` is absent.
- Needed:
  - Node (AL2023 `dnf` provides a nodejs package; a linux-arm64 tarball also works) and `@playwright/test`.
  - Playwright's own Chromium or headless-shell for linux-arm64 (`npx playwright install chromium`).
  - Playwright's `install-deps` assumes apt, so on AL2023 install Chromium's shared libraries with `dnf` instead: `nss`, `atk`, `at-spi2-atk`, `cups-libs`, `libdrm`, `libxkbcommon`, `libXcomposite`, `libXdamage`, `libXfixes`, `libXrandr`, `mesa-libgbm`, `pango`, `alsa-lib` and similar.
  - Google Chrome and Chrome-for-Testing have no linux-arm64 builds, so do not rely on them.
  - System fonts for fallback glyphs the bundled fonts lack (`⚠ ★ ‹ › − ✕ ↑ ↓ →`). Install a Noto or DejaVu family and an emoji font, and use the same set for both renders.
  - Playwright 1.45 or later, for `page.clock`.
- Run one worker with `--disable-dev-shm-usage`, `--force-color-profile=srgb`, `--font-render-hinting=none`, `--disable-lcd-text` and deviceScaleFactor 1. `--no-sandbox` may be needed.

### 5.3 Determinism: what must be pinned
| Source | Where | Pin with |
|---|---|---|
| Real clock | cc `nowClock()` and `clockLabel:'Live · '+…`; pay `nowT()` | `page.clock.install({time: '2026-06-13T10:36:00'})` in a fixed timezone |
| `Date.now()` | cc `startedAt` and elapsed progress; set ids (`'c'+Date.now()`) | fake clock (then pause it) |
| 1 s re-render | cc `setInterval` | fake clock; use `runFor` to step |
| Timezone and locale | `new Date(2026,5,13+off)`, `toLocaleDateString('en-US')` | context `timezoneId` and `locale: 'en-US'` (the designs do not state a timezone) |
| `localStorage` | `oasis-*` keys | fresh context per run |
| URL hash | set: `#emergency` | explicit per scenario |
| Animations | cc: `oa-fade`, `oa-rise`, `oa-slide` | screenshot with `animations: 'disabled'` |
| Fonts | all | wait for `document.fonts.ready` |
| Randomness | none (`rng` is seeded; no `Math.random`) | nothing to pin |
| Viewport | cc is designed for 1480×1000 (`$preview`); pay and set give no size | set it explicitly per design |

Run with network blocked: `context.route('**/*', …)` aborting everything except localhost.

## 6. Risks and recommendations

1. **Wrapper `<span class="sc-interp">` and whitespace text nodes.** These are the two main sources of DOM and layout divergence if the port is hand-written JSX. Keep both in the mechanical port. Add a codegen flag to drop them later, once the baseline is green.
2. **Template logic lives in `renderVals`.** The template has no expressions, so the backend and API must supply all derived labels, colours and booleans, or a BFF layer must replicate the `renderVals` mapping.
3. **Fixtures are partly generated.** cc builds appointments from a seeded RNG per date, so it is deterministic. Dump `logic.state` and `renderVals()` from the live original (via the harness) to get ground-truth fixtures for the backend seed data.
4. **Design/runtime gaps to flag in the plan:**
   - Timezone is unspecified.
   - Responsive behaviour is unspecified. The page is fixed `100vh` with `overflow:hidden` on `html,body`, and has no breakpoints, although cc has touch gestures.
   - `$preview` size is given only for cc.
   - The cross-design hrefs are file names, not routes.
   - `oa-toast` keyframes are mistyped and unused.
   - Some persisted settings (`oasis-hours`, `oasis-closures`, `oasis-emergency`, `oasis-checklists`, `oasis-roles`, `oasis-vip`) are client-only in the design, so they need server-side models.
5. **Synchronous `this.state` semantics.** Several handlers call `setState` and then read `this.state`. Any rewrite to hooks must preserve this, or those handlers will break. Hence the DCHost shim.
6. **React version.** Pin React 18.3.1 to match the original bundle. Next 14.2 supports React 18 in the App Router.
7. **Global CSS collisions.** Keep the helmet CSS as the single global stylesheet. Do not add Tailwind preflight or other resets. Fonts must stay named `Manrope` and `Bricolage Grotesque`.
8. **SSR.** All three screens read `localStorage` and the clock during state initialisation. Make the screens client-only or defer reads to effects.
9. **Environment.** The harness host is ARM64 Amazon Linux with no Node or browser. Plan for the manual `dnf` library install and font install in §5.2, or run the baseline on a different machine.