<!-- Reference material generated during planning (2026-10-06) from the three Claude Design prototypes. Source of truth for the build; see docs/plan.md. -->

## 0. Scope and method

- **Source:** the `pay` artifact, "Oasis Payments". I read all of PART=markup (28,257 chars) and all of PART=script (about 37K chars), including every style-helper function.
- **Not computed:** there is no `node` in the sandbox, so I could not execute the script. Derived numbers below (KPIs per range, generated-history rows) are not computed. Only values that follow directly from the source are stated.
- **Screen:** one screen, `data-screen-label="Oasis Payments"`. It has a header, then either a "locked" card or a three-band body (toolbar, 6 KPI cards, main two-column area). A modal "action sheet" and a toast sit on top.
- **Fonts:** Manrope (400/500/600/700/800, all subsets) and Bricolage Grotesque (500/600/700/800, variable-width `font-stretch:100%`). The artifact embeds them as woff2; the `<link>` tags are only `preconnect` to fonts.googleapis.com and fonts.gstatic.com.
- **Interactions the design lacks:** no `@media` queries, no transitions or animations, no hover styles except `a:hover`, no keyboard handlers (no Esc to close the sheet), no `aria-*`.

---

## 1. Page frame and global chrome

### Root frame
- `html,body{margin:0;padding:0;height:100%;overflow:hidden}` and `*{box-sizing:border-box}`.
- `body{background:var(--bg)}`.
- Root div: `data-theme="{{ theme }}"`, `height:100vh; overflow:hidden; display:flex; flex-direction:column; background:var(--bg); color:var(--ink)`.
- Root font: `font-family:'Manrope',system-ui,sans-serif; -webkit-font-smoothing:antialiased; font-feature-settings:'tnum'; letter-spacing:-0.01em`.
- The page never scrolls. Only the transactions list body, the detail aside body and the sheet body scroll internally.
- Global resets:
  - `button{font-family:inherit;cursor:pointer;border:none;background:none;color:inherit}`
  - `button:disabled{cursor:not-allowed}`
  - `a{color:var(--accent);text-decoration:none}`
  - `a:hover{color:var(--accentInk)}`
  - `input::placeholder{color:var(--ink3)}`
  - `input:focus{outline:none;border-color:var(--accent)!important}`
- Scrollbar:
  - `::-webkit-scrollbar{width:10px;height:10px}`
  - Thumb: `background:var(--line); border-radius:8px; border:3px solid transparent; background-clip:padding-box`.

### Header
- `<header>` style: `flex:none; display:flex; align-items:center; gap:18px; padding:14px 26px; border-bottom:1px solid var(--line)`. It has no background of its own, so `--bg` shows through.
- Order: brand block, nav pill, `flex:1` spacer, role-preview button with menu, theme toggle.

**Brand block** (`display:flex; align-items:center; gap:13px; flex:none`):
- Logo tile: 42×42, `border-radius:13px`, `background:var(--accent)`, content centered.
- Logo glyph: 24×24 SVG, viewBox `0 0 24 24`, `fill:none`. All strokes are `#fff`, width 2.1, `stroke-linecap:round`:
  1. Arc `M5 13c0-3.5 2.5-7 7-7s7 3.5 7 7`.
  2. Wave `M3 16.5c1.2-.9 2.1-.9 3.3 0 1.2.9 2.1.9 3.3 0 …`. It is five repeated quarter-sine segments starting at x=3, also with `stroke-linejoin:round`. Take the exact path from the source.
  3. Circle `cx=12 cy=12.5 r=1.6`, `fill:#fff`.
- Text block: `line-height:1.05`.
  - Line 1, "Oasis Auto Spa": Bricolage Grotesque 700, 18px, `letter-spacing:-0.02em`.
  - Line 2, "Payments": 11px, weight 600, `color:var(--ink3)`, `letter-spacing:0.04em`, uppercase.

**Nav pill** (`<nav>`): `display:flex; align-items:center; gap:4px; padding:4px; background:var(--panel2); border:1px solid var(--line); border-radius:13px; flex:none`.
- Three `<a>` items. Each is `display:flex; align-items:center; height:38px; padding:0 16px; border-radius:10px; font-size:13.5px; font-weight:700`.
- Operations: `href="Oasis%20Command%20Center.dc.html"`, `color:var(--ink2)`.
- Payments (active): `href="Oasis%20Payments.dc.html"`, `background:var(--accent); color:#fff`.
- Settings: `href="Oasis%20Settings.dc.html"`, `color:var(--ink2)`.
- All three are plain links (cross-page navigation). The nav items are identical in the other two designs, differing only in the active item.

**"Preview as <role>" button**
- Wrapper: `position:relative`.
- Button: `display:flex; align-items:center; gap:8px; height:46px; padding:0 14px; background:var(--panel); border:1px dashed var(--line); border-radius:13px; font-size:13px; font-weight:700; color:var(--ink2)`.
- Content: text "Preview as ", then `<span style="color:var(--ink);font-weight:800">{{ roleName }}</span>`, then a 14×14 chevron-down SVG (`M6 9l6 6 6-6`, stroke `currentColor`, width 2.2, round caps and joins).
- Dropdown, shown when `roleMenu`:
  - Container: `position:absolute; right:0; top:52px; z-index:50; width:250px; background:var(--panel); border:1px solid var(--line); border-radius:14px; box-shadow:var(--shadowLg); padding:6px`.
  - Each role button:
    - Style: `display:flex; flex-direction:column; align-items:flex-start; gap:1px; width:100%; padding:9px 10px; border-radius:10px`.
    - Background: `var(--accentSoft)` if selected, else `transparent`.
    - Line 1: role name, 13.5px, weight 800.
    - Line 2: limit text, 11.5px, weight 600, `color:var(--ink3)`.
  - Footer text: "Limits come from Settings → Roles & permissions." Style: `font-size:11px; font-weight:600; color:var(--ink3); padding:8px 10px 4px; line-height:1.4`.
  - Clicking a role sets `role` and closes the menu.
  - Clicking outside the menu does not close it; only the button toggle or picking a role does.
- Role list, in order (id → name → second-line text):

| id | Name | Second line | Computed from |
|---|---|---|---|
| super | Super Admin | "refunds no limit" | has refund, max Infinity |
| mgmt | Management | "refunds ≤ $1000" | |
| acct | Accounting | "refunds ≤ $500" | |
| support | Customer Support | "refunds ≤ $50" | |
| crew | Crew | "no access" | |

- Text rule: `!perms.reports && !lim.has ? 'no access' : (lim.has ? 'refunds '+(max===Infinity?'no limit':'≤ $'+max) : 'no refunds')`.
- The "refunds ≤ $50" label for Customer Support is misleading. Support has no `pay.reports`, so that role sees the locked screen.
- Default role is `mgmt`.

**Theme toggle**
- 46×46 button, `display:flex`, centered, `background:var(--panel); border:1px solid var(--line); border-radius:13px; color:var(--ink2)`. `title="Toggle theme"`.
- Icon: 19×19 crescent-moon SVG, `M20 14.5A8 8 0 019.5 4 7 7 0 1020 14.5z`, stroke `currentColor`, width 2, round join. It is the same icon in both themes (no sun variant).
- Behavior: flips `light`/`dark`, persists to `localStorage['oasis-theme']`. The initial value is read from that key and defaults to `'light'`.

### Locked / no-access state (`locked = !perms[role]['pay.reports']`)
- The toolbar, KPIs and main area are all hidden. The header stays.
- Wrapper: `flex:1; display:flex; align-items:center; justify-content:center; padding:26px`.
- Card: `max-width:440px; text-align:center; background:var(--panel); border:1px solid var(--line); border-radius:22px; padding:36px; box-shadow:var(--shadow)`.
- Lock tile: 60×60, `border-radius:18px`, `background:var(--panel3)`, centered, `margin:0 auto 16px`. Inside is a 28×28 padlock SVG:
  - `<rect x=5 y=10 width=14 height=10 rx=2>`
  - Shackle `M8 10V7a4 4 0 018 0v3`
  - Both strokes `var(--ink2)`, width 2.
- Title "No payment access": Bricolage 700, 22px.
- Body: `font-size:14px; font-weight:600; color:var(--ink2); margin-top:8px; line-height:1.5`. The copy is:
  > The {{ roleName }} role doesn't include "View payment reports". A Super Admin can grant it in Settings.
  - Straight apostrophe and straight double quotes, as in the source.
- The action sheet and toast are rendered outside the lock gate.

---

## 2. Design tokens

### Light (`:root, [data-theme="light"]`)

| Token | Value |
|---|---|
| --bg | #ECEBE4 |
| --bg2 | #F4F3EE |
| --panel | #FFFFFF |
| --panel2 | #F5F4EF |
| --panel3 | #EEEDE6 |
| --ink | #18211E |
| --ink2 | #5C645F |
| --ink3 | #949A94 |
| --line | #E2E0D7 |
| --line2 | #EDEBE3 |
| --accent | #0E7A63 |
| --accentInk | #0A5C49 |
| --accentSoft | #DCEEE8 |
| --accentBrd | #BFE0D5 |
| --red | #C2410C |
| --redSoft | #FBEAE0 |
| --amber | #B07908 |
| --amberSoft | #FAF0D8 |
| --shadow | `0 1px 2px rgba(24,33,30,.04),0 6px 22px rgba(24,33,30,.07)` |
| --shadowLg | `0 24px 70px rgba(24,33,30,.22)` |

### Dark (`[data-theme="dark"]`)

| Token | Value |
|---|---|
| --bg | #0C100E |
| --bg2 | #10150F |
| --panel | #161E1A |
| --panel2 | #1C2620 |
| --panel3 | #212C26 |
| --ink | #ECF1EE |
| --ink2 | #9BA7A0 |
| --ink3 | #69756E |
| --line | #283330 |
| --line2 | #222B27 |
| --accent | #2FB694 |
| --accentInk | #7FE0C6 |
| --accentSoft | #15302A |
| --accentBrd | #23463D |
| --red | #F08A5D |
| --redSoft | #2E1C14 |
| --amber | #E0A93C |
| --amberSoft | #2A2415 |
| --shadow | `0 1px 2px rgba(0,0,0,.3),0 8px 26px rgba(0,0,0,.35)` |
| --shadowLg | `0 30px 80px rgba(0,0,0,.6)` |

Token usage notes:
- `#fff` is hard-coded for text on accent, red or amber fills. It is not a token.
- Sheet overlay scrim: `rgba(8,12,10,.55)` in both themes.
- Toast uses `background:var(--ink); color:var(--bg)`, so it inverts per theme.
- `--redSoft` is used only by the "Unpaid" pill.
- The `--bg2` panel background is used only by the action sheet body.

### Fonts
- **Manrope:** body, labels, buttons, inputs, table.
- **Bricolage Grotesque:** brand name, KPI values, detail client name, detail big-stat values, locked title, sheet title.
- Weights actually used: Manrope 600, 700, 800; Bricolage 700.
- `font-feature-settings:'tnum'` is set on the root, so numerals are tabular. Bricolage elements inherit it.

### Type scale in use (px / weight / notes)

| Size | Where |
|---|---|
| 10 / 700 | chart x-axis bucket labels |
| 10.5 / 800 | table header (uppercase, ls 0.06em); detail big-stat label (uppercase, ls 0.05em); ADJ tag |
| 11 / 700 | KPI label (uppercase, ls 0.05em); brand subtitle (600, ls 0.04em); filter count badge (800); pill (800); breakdown section heading (800, uppercase, ls 0.06em); approve note (600) |
| 11.5 / 600–700 | chart legend (700); row id and ledger meta (600); item-refund note (600); role-menu second line (600) |
| 12 / 600–700 | KPI sub (600); sheet field labels (700); "Approve"/"Deny" (800/700); row vehicle (600) |
| 12.5 / 700–800 | row items (600); "Review" (800); detail header id (800); chip (700); sheet subtitle (600); perm text (700); method-bar label (700); credit line (700) |
| 13 / 600–800 | toolbar buttons (700), range label (700), filters (700), search (600), row date (800), breakdown rows (600/800), ledger title and amount (800), seg buttons (700), detail vehicle line (600), "Preview as" (700) |
| 13.5 / 700–800 | nav (700), row client (700), pending text (700), role name (800), action buttons (800), sheet summary rows (600/800), toast (700), item checkbox row (700/800), note input (600) |
| 14 / 700–800 | row total (800), seg "Cancel" (700), locked body (600), "Total" label in breakdown (800) |
| 14.5 / 800 | card headings ("Net revenue", "Collected by method") |
| 15 / 800 | breakdown Total value; sheet submit label |
| 18 / 700–800 | brand name (Bricolage 700); sheet number inputs (Manrope 800) |
| 19 / 700 | detail big-stat value (Bricolage) |
| 20 / 700 | sheet title (Bricolage) |
| 22 / 700 | detail client name; locked title (Bricolage) |
| 24 / 700 | KPI value (Bricolage, ls -0.02em) |

Letter-spacing:
- Root `-0.01em`.
- Display text `-0.02em`.
- Uppercase labels `0.04–0.06em`.

### Radii

| Radius | Used for |
|---|---|
| 3 | legend dot, loss bar |
| 4 | method bar; net bar top corners (`4px 4px 2px 2px`) |
| 6 | ADJ tag, count badge |
| 7 | pill, item checkbox |
| 8 | scrollbar thumb |
| 9 | seg button, 30px glyph tiles, Approve/Deny buttons, '!' badge |
| 10 | range buttons, filter buttons, chip, nav items, Review button, role-menu row |
| 11 | search input, close button |
| 12 | KPI-adjacent seg containers, toolbar Export button, action buttons, inputs, detail big stats, refund item rows, perm/credit boxes |
| 13 | logo tile, nav pill, preview and theme buttons, submit and Cancel buttons, range container |
| 14 | pending banner, breakdown, role menu, summary box, toast |
| 15 | KPI cards |
| 18 | cards (chart, methods, table, detail aside), locked icon tile |
| 22 | sheet panel, locked card |

### Shadows and borders
- Cards use `var(--shadow)`.
- Menus, sheet and toast use `var(--shadowLg)`.
- All borders are 1px solid `--line`.
- Internal dividers (table rows, filter bar, table header) use `--line2`.
- The preview button is `1px dashed var(--line)`.
- The pending banner is `1px solid var(--line)`, not an amber border.

### Spacing rhythm
- Header: `14px 26px`.
- Toolbar: `16px 26px 0`, gap 14.
- KPI grid: `14px 26px 0`, gap 12.
- Main: `16px 26px 18px`, gap 18.
- Left column gap: 14.
- Card padding: `16px 18px`.
- Detail aside padding: 20.
- Sheet padding: `20px 22px`, gap 16.

### z-index
- Role menu 50.
- Sheet overlay 70.
- Toast 90.
- The "Made with Claude Design" badge at 2147483646 is not part of the product.

---

## 3. Region-by-region component spec (DOM order)

### 3.0 Body wrapper
Everything inside `sc-if unlocked` is three flex-none bands (toolbar, KPIs) plus `<main>` (flex:1).

### 3.1 Toolbar: range selector, range label, Export CSV
- Row: `flex:none; display:flex; align-items:center; gap:14px; padding:16px 26px 0; flex-wrap:wrap`.
- **Range selector container:** `display:flex; gap:4px; padding:4px; background:var(--panel); border:1px solid var(--line); border-radius:13px`.
  - Four buttons: `height:38px; padding:0 14px; border-radius:10px; font-size:13px; font-weight:700`.
  - Active: `background:var(--accent); color:#fff`. Inactive: `transparent` and `var(--ink2)`.
  - Order and labels:

| Key | Button label | Range label text |
|---|---|---|
| today | "Today" | "Saturday, June 13" |
| 7d (default) | "7 days" | "Jun 7 – Jun 13" |
| 30d | "30 days" | "May 15 – Jun 13" |
| mtd | "Month to date" | "Jun 1 – Jun 13" |

- The range label text is hard-coded in the design (en dash with spaces).
- **Range label:** `font-size:13px; font-weight:700; color:var(--ink3)`.
- Then `flex:1` spacer.
- **Export CSV button:**
  - Style: `height:42px; padding:0 16px; background:var(--panel); border:1px solid var(--line); border-radius:12px; font-weight:700; font-size:13px`.
  - Label "Export CSV".
  - Click flashes `CSV export started · {n} invoices`, where n is the in-range count before filter and search.
  - The design does not specify the CSV columns or contents.

### 3.2 KPI cards (6)
- Grid: `flex:none; display:grid; grid-template-columns:repeat(6,minmax(0,1fr)); gap:12px; padding:14px 26px 0`.
- Card: `padding:14px 16px; background:var(--panel); border:1px solid var(--line); border-radius:15px; min-width:0`. No shadow.
  - Label: 11px / 700 / `--ink3`, uppercase, ls 0.05em, `white-space:nowrap; overflow:hidden; text-overflow:ellipsis`.
  - Value: Bricolage 700, 24px, ls -0.02em, `margin-top:6px`, colored per card.
  - Sub: 12px / 600 / `--ink2`, `margin-top:1px`.
- Cards in order. All values use `money0` (rounded to whole dollars, en-US thousands separators, U+2212 minus):

| Label | Value formula | Sub text | Value color |
|---|---|---|---|
| Gross sales | Σ `c.items` | `{n} invoices` (n = in-range tx count) | `--ink` |
| Net revenue | Σ items + Σ adj − Σ refunds/1.07 | "after refunds & discounts" | `--accentInk` |
| Refunds | Σ `c.refunded` (done only) | `{cnt refunded>0} refunded` | `--red` if non-zero, else `--ink` |
| Adjustments | Σ signed `c.adj` | `{cnt adj≠0} invoices` | `--ink` |
| Credits issued | Σ `c.issued` | `{cnt issued>0} clients` | `--ink` |
| Outstanding | Σ `c.balance` | `{cnt balance>0} open balances` | `--amber` if non-zero, else `--ink` |

- Quirks:
  - "Credits issued" sub says "clients" but counts invoices.
  - Counts have no pluralization ("1 invoices").
  - `Credits issued` counts only `credit_issue` events. Refunds-to-credit and credit applied are excluded.
  - All six depend on the selected range, not on the filter or search.

### 3.3 Main grid
- `<main>`: `flex:1; min-height:0; display:grid; grid-template-columns:minmax(0,1fr) 440px; gap:18px; padding:16px 26px 18px`.
- Left column: `display:flex; flex-direction:column; gap:14px; min-height:0; min-width:0`.
- Right column is the detail `<aside>`, fixed at 440px.

### 3.4 Pending-approval banner (`sc-if hasPending`)
- Shown when any tx, in any range, has a refund event with `status==='pending'`. It is not range-filtered.
- Style: `flex:none; display:flex; align-items:center; gap:12px; padding:12px 14px 12px 16px; background:var(--amberSoft); border:1px solid var(--line); border-radius:14px`.
- Left badge: `<span>` 30×30, `border-radius:9px`, `background:var(--amber); color:#fff`, centered, `font-weight:800; flex:none`. Text is a literal "!".
- Text: `flex:1; min-width:0; font-size:13.5px; font-weight:700`. Format: `{count} refund awaiting approval — {money(first.amt)} · {first.client} · requested by {first.by}`.
  - Example with default fixtures: "1 refund awaiting approval — $80.00 · Chloe Bennett · requested by Sofia D."
  - The em dash is U+2014.
  - Only the first pending item is described. There is no plural handling ("2 refund awaiting…").
- **"Review" button:** `height:38px; padding:0 15px; border-radius:10px; background:var(--amber); color:#fff; font-weight:800; font-size:12.5px`.
  - Click selects the first pending tx.
  - Range logic: if `p.t.off >= -6` keep the current range, except switch to `7d` when the current range is `today` and `p.t.off < 0`. If `p.t.off < -6`, set `30d`.
  - Quirk: with `mtd` and an off of -7 to -12, it still jumps to `30d`.
  - It does not clear the filter or search, so the selected row can be hidden by an active filter.

### 3.5 Charts row
- `flex:none; display:grid; grid-template-columns:minmax(0,1.7fr) minmax(0,1fr); gap:14px`.
- Both cards: `background:var(--panel); border:1px solid var(--line); border-radius:18px; padding:16px 18px; box-shadow:var(--shadow); min-width:0`.

**Net revenue chart**
- Header row: `display:flex; align-items:center; justify-content:space-between`.
  - Title "Net revenue": 800 / 14.5px.
  - Legend: `display:flex; gap:12px; font-size:11.5px; font-weight:700; color:var(--ink3)`. Each entry is a `<span>` with `display:flex; align-items:center; gap:5px`, a 9×9 `border-radius:3px` square and the text.
    - Square 1: `background:var(--accent)`, "Net".
    - Square 2: `background:var(--red)`, "Refunds & discounts".
- Bar area: `display:flex; align-items:flex-end; gap:4px; height:130px; margin-top:14px`.
  - Each bucket column: `flex:1; min-width:0; height:100%; display:flex; flex-direction:column; justify-content:flex-end; gap:2px`. Its `title` attribute is the tooltip.
  - Inside, in DOM order from top to bottom:
    1. Loss div: `height:(loss/mx*100)%`, `background:var(--red)`, `border-radius:3px`, `opacity:.85`. Placed above the net segment.
    2. Net div: `height:(net/mx*100)%`, `min-height:3px` if net>0 else 0, `background:var(--accent)`, `border-radius:4px 4px 2px 2px`.
  - `mx = max(1, max over buckets of (net+loss))`.
- X-axis labels row: `display:flex; gap:4px; margin-top:6px`. Each label is `flex:1; min-width:0; text-align:center; font-size:10px; font-weight:700; color:var(--ink3); white-space:nowrap; overflow:hidden`.
- Bucket logic:
  - **Today:** 10 buckets, hours 8 to 17. Label is `((h%12)||12)+(h>=12?'p':'a')`, giving "8a, 9a, 10a, 11a, 12p, 1p, … 5p". An event falls in the bucket by parsing `time` (`/(\d+):\d+\s*(AM|PM)/`, converted to 24h). Tooltip is just the label plus `' · net '+money0(net)`.
  - **Other ranges:** one bucket per day offset from `R[0]` to `R[1]`.
    - Bucket counts: 7d = 7, mtd = 13, 30d = 30.
    - Label when the span is ≤14 days (7d, mtd): weekday letter plus space plus date number (`'SMTWTFS'[getDay()] + ' ' + getDate()`, e.g. "S 13").
    - Label when the span is >14 days (30d): date number only when `getDate()%3===1`, else an empty string.
    - Tooltip: `d.toDateString()+' · net '+money0(net)`.
  - Per-bucket net is Σ `c.net`, where `c.net = items + adj − refunded/1.07`. Loss is Σ(`refunded + max(0, −adj)`), so refunds are tax-inclusive but discounts are pre-tax. Surcharges are not shown as loss.
  - The 30d bucket labels sit in 10px text, fitting the sparse date numbers.

**Collected by method card**
- Title "Collected by method": 800 / 14.5px, `margin-bottom:12px`.
- Four rows, fixed order: Card, Apple Pay, Cash, Store credit. Each row has `margin-bottom:10px`:
  - Top line: `display:flex; justify-content:space-between; font-size:12.5px; font-weight:700`. Left is the label, right is `money0(value)`.
  - Track: `height:7px; border-radius:4px; background:var(--panel3); margin-top:5px; overflow:hidden`.
  - Fill: `height:100%; width:(v/mmx*100)%; border-radius:4px`. Fill is `var(--amber)` for Store credit, `var(--accent)` for the others.
  - `mmx = max(1, max of the four values)`.
- Aggregation, over in-range txs:
  - `pay` events add `e.amt` to `fam(e.method)`.
  - `credit_apply` adds `e.amt` to Store credit.
  - `fam`: `/visa|master|amex/i` gives Card; `'Apple Pay'` gives Apple Pay; `'Cash'` gives Cash; anything else gives Store credit.
  - Refunds are not subtracted.
  - Method strings are pay-event `method` values such as "Visa ••4421".

### 3.6 Transactions panel
- Wrapper: `flex:1; min-height:0; display:flex; flex-direction:column; background:var(--panel); border:1px solid var(--line); border-radius:18px; box-shadow:var(--shadow); overflow:hidden`.

**Filter bar**
- `flex:none; display:flex; align-items:center; gap:10px; padding:12px 14px; border-bottom:1px solid var(--line2); flex-wrap:wrap`.
- Chips container: `display:flex; gap:4px; flex-wrap:wrap`.
- Filter button: `display:flex; align-items:center; gap:7px; height:38px; padding:0 12px; border-radius:10px; font-size:13px; font-weight:700`.
  - Active: `background:var(--accentSoft); color:var(--accentInk)`. Inactive: transparent and `--ink2`.
  - Count badge: `font-size:11px; font-weight:800; padding:1px 6px; border-radius:6px`.
    - Active: `background:var(--accent); color:#fff`.
    - Inactive: `background:var(--panel3); color:var(--ink3)`.
  - Order, keys, labels and predicates over the in-range set. Counts are not affected by the search box:

| Key | Label | Predicate |
|---|---|---|
| all (default) | All | true |
| unpaid | Open balance | balance>0 |
| refunds | Refunds | refunded>0 or pending refunds exist |
| adjusted | Adjusted | adj≠0 |
| credits | Credits | issued>0 or creditApplied>0 |

- Then `flex:1` spacer, then the search input:
  - Style: `width:250px; max-width:100%; height:40px; padding:0 14px; border-radius:11px; border:1px solid var(--line); background:var(--panel2); color:var(--ink); font-family:inherit; font-size:13px; font-weight:600`.
  - Placeholder: "Search client, invoice, vehicle…" (a single ellipsis character).
  - Search is case-insensitive substring over `[id, client, vehicle, ...item names].join(' ')`, and ANDs with the filter.

**Column header row**
- `flex:none; display:grid; grid-template-columns:118px minmax(170px,1.4fr) minmax(140px,1.2fr) 96px 150px; gap:12px; padding:10px 16px; border-bottom:1px solid var(--line2); font-size:10.5px; font-weight:800; color:var(--ink3); text-transform:uppercase; letter-spacing:0.06em`.
- Columns, in order: "Date", "Client", "Items", "Total" (right-aligned), "Status".
- The grid template string is identical to the row template. Keep them in sync.

**Rows area**
- `flex:1; min-height:0; overflow-y:auto`.
- Row is a `<button>`: `display:grid; same 5-column template; gap:12px; align-items:center; width:100%; text-align:left; min-height:58px; padding:9px 16px; border-bottom:1px solid var(--line2)`.
  - Background is `var(--accentSoft)` when selected (`t.id===selId`), else transparent. There is no hover state.
- Cells:
  1. **Date:** line 1 is `fmtDate(off)+' · '+time`, 800 / 13px, e.g. "Today · 10:05 AM", "Yesterday · 2:10 PM", "Jun 11 · 11:00 AM". Line 2 is the invoice id, 11.5px / 600 / `--ink3`.
  2. **Client:** line 1 is the client name, 700 / 13.5px, ellipsis. Line 2 is the vehicle, 12px / 600 / `--ink2`, ellipsis.
  3. **Items:** first item name plus `' +N'` when more items exist. 12.5px / 600 / `--ink2`, ellipsis. Example: "Executive Detail + Ceramic +1".
  4. **Total:** `money(c.total)` (two decimals), right-aligned, 800 / 14px.
  5. **Status:** `display:flex; gap:5px; flex-wrap:wrap; align-items:center`.
     - A pill (see helper below).
     - An optional **ADJ tag**, shown when `c.adj !== 0`: `font-size:10.5px; font-weight:800; padding:3px 7px; border-radius:6px; background:var(--panel3); color:var(--ink2)`. Text is "ADJ".
- **Pill helper:** `fontSize:11px, fontWeight:800, padding:'4px 9px', borderRadius:'7px', whiteSpace:nowrap`.

| Status | Background | Text |
|---|---|---|
| Paid | `--accentSoft` | `--accentInk` |
| Unpaid | `--redSoft` | `--red` |
| Partially paid | `--amberSoft` | `--amber` |
| Partially refunded | `--amberSoft` | `--amber` |
| Refunded | `--panel3` | `--ink2` |
| Canceled · refunded | `--panel3` | `--ink2` |
| (default) | `--panel3` | `--ink2` |

- A tx with a pending refund shows the text "Refund pending" and uses the "Partially paid" (amber) pill. This applies in both the row and the detail header.
- Sort order: `off` descending, then `id` descending by string compare.
- **Empty state** (`noRows`): `padding:40px; text-align:center; font-weight:600; color:var(--ink3)`. Text: "Nothing matches this filter."
- The table lists every in-range tx (no pagination, no virtualization).

### 3.7 Invoice detail panel (right `<aside>`)
- Aside: `background:var(--panel); border:1px solid var(--line); border-radius:18px; box-shadow:var(--shadow); display:flex; flex-direction:column; min-height:0; overflow:hidden`.
- Inner scroller: `flex:1; min-height:0; overflow-y:auto; padding:20px`.
- There is no empty or "nothing selected" state. `selId` defaults to `'INV-20603'`. A `selId` not found falls back to `txs[0]`. The panel shows any tx even if it is out of the current range.

**Header**
- Row: `display:flex; align-items:center; justify-content:space-between; gap:10px`.
  - Left: `{{ d.id }} · {{ d.when }}`, 12.5px / 800 / `--ink3`. `when = fmtDate(off)+' '+time` (no dot), e.g. "Today 10:31 AM", "Jun 10 1:30 PM".
  - Right: status pill.
- Client name: Bricolage 700, 22px, ls -0.02em, `margin-top:8px`.
- Vehicle line: `{{ vehicle }} · {{ staff }}`, 13px / 600 / `--ink2`, `margin-top:2px`. Staff for fixtures is e.g. "Marco R." or "Unassigned".

**Big-stat trio**
- `display:grid; grid-template-columns:repeat(3,1fr); gap:8px; margin-top:16px`.
- Tile: `padding:11px 12px; background:var(--panel2); border:1px solid var(--line); border-radius:12px`.
  - Label: 10.5px / 800 / uppercase / ls 0.05em / `--ink3`.
  - Value: Bricolage 700, 19px, `margin-top:3px`.
- Tiles:
  1. "Total": `money(total)`, `--ink`.
  2. "Collected": `money(paid − refunded)`, `--accentInk`. Here `paid = paidOrig + creditApplied`.
  3. If `balance>0`: "Balance due", `money(balance)`, `--red`. Else "Refundable", `money(refundable)`, `--ink`.

**Breakdown box**
- `margin-top:16px; padding:6px 14px; background:var(--panel2); border:1px solid var(--line); border-radius:14px`.
- Row (kind default): `display:flex; justify-content:space-between; padding:6px 0`. Label 13px / 600 / `--ink2`. Value 13px / 800 / `--ink`.
- Row kinds:
  - `neg` (discounts, refunded): label and value both `--red`.
  - `pos` (store credit applied): both `--accentInk`.
  - `total`: row `padding:11px 0 7px; border-top:1px solid var(--line); margin-top:4px`. Label 14px / 800 / `--ink2`. Value 15px / 800 / `--ink`.
- Lines, in order:
  1. One line per item: name and `money(price)`.
  2. One line per adjust event: `'Discount · '+reason` (red) or `'Surcharge · '+reason` (default), value `money(amt)`, so a discount shows "−$25.00".
  3. "Tax (7%)": `money(tax)`.
  4. "Tip": only when `tip>0`.
  5. "Total" (total kind).
  6. "Store credit applied": only when `creditApplied>0`, value `money(−creditApplied)` (pos).
  7. "Paid": `money(paidOrig)`. It excludes store credit.
  8. "Refunded": only when `refunded>0`, `money(−refunded)` (neg).

**Action buttons grid**
- `display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-top:14px`.
- Button base: `height:48px; border-radius:12px; font-weight:800; font-size:13.5px; border:1px solid ...`.
  - Enabled non-primary: `background:var(--panel); color:var(--ink); border-color:var(--line)`.
  - Enabled primary: `background:var(--accent); color:#fff; border-color:var(--accent)`.
  - Disabled: `background:var(--panel2); color:var(--ink3); border:1px solid var(--line); opacity:.7`. Uses the native `disabled` attribute, and the `title` tooltip carries the reason.
- Buttons in DOM order, with visibility and enablement:

| Order | Label | Visible when | Enabled when | Disabled reason (title) |
|---|---|---|---|---|
| 1 | "Collect $X" (X = balance), primary | balance>0 | role has `pay.collect` | "Role can’t collect payments" |
| 2 | "Apply $Y credit" (Y = min(clientCredit, balance)) | balance>0 and clientCredit>0 | `pay.collect` | "Role can’t collect payments" |
| 3 | "Refund" | always | has `pay.refund` and refundable>0 | no permission: "Role can’t issue refunds"; else "Nothing left to refund" |
| 4 | "Adjust" | always | has `pay.adjust` and not canceled | "Role can’t adjust invoices" |
| 5 | "Issue credit" | always | has `pay.credit` | "Role can’t issue credits" |
| 6 | "Send receipt" | always | always | |

- The apostrophe in the reasons is U+2019.
- "Send receipt" flashes `Receipt sent to {client} via WhatsApp + email`. Nothing else happens; there is no receipt UI in this design.
- Odd button counts leave a half-empty last row (the grid is 2 wide).

**Credit line** (`sc-if creditLine`, i.e. client store credit>0)
- `display:flex; align-items:center; gap:10px; margin-top:12px; padding:11px 13px; background:var(--accentSoft); border:1px solid var(--accentBrd); border-radius:12px; font-size:12.5px; font-weight:700; color:var(--accentInk)`.
- Text: `{firstName} has {money(credit)} in store credit`.
- Client credit = Σ over all txs with the same `client` string:
  - `credit_issue` amounts
  - plus `refund` events with `dest==='credit'` and `status==='done'`
  - minus `credit_apply` amounts

**Ledger & audit trail**
- Heading: "Ledger & audit trail". Style: `font-size:11px; font-weight:800; color:var(--ink3); text-transform:uppercase; letter-spacing:0.06em; margin:20px 0 10px`.
- Entries are the tx's events in reverse (newest first). Entry layout: `display:flex; gap:11px; padding-bottom:14px`.
  - Glyph tile: 30×30, `border-radius:9px`, `flex:none`, centered, 14px / 800, `border:1px solid var(--line)`.
    - Background `--panel2`, or `--amberSoft` when pending.
    - Text color is the event color, or `--amber` when pending.
  - Body: `flex:1; min-width:0`.
    - Top line: `display:flex; justify-content:space-between; gap:8px`. Title 13px / 800. Amount 13px / 800 in the event color (or `--ink3` when denied).
    - Meta: `font-size:11.5px; font-weight:600; color:var(--ink3); margin-top:2px; line-height:1.4`.
- Glyphs: pay "$", adjust "±", refund "↩", credit_issue "+", credit_apply "◆".
- Colors:
  - refund: `--red`
  - adjust: `--red` if amt<0, else `--ink`
  - credit_issue and credit_apply: `--amber`
  - pay: `--accentInk`
- Title by type:
  - pay: `Deposit · {method}` if `deposit`, else `Payment · {method}`
  - adjust: `Discount · {reason}` or `Surcharge · {reason}`
  - refund: `Refund requested` (pending) / `Refund denied` (denied) / `Refund`, then ` · ` plus: `to store credit` (dest credit) / `cash` (dest cash) / the method (card)
  - credit_issue: `Credit issued · {reason}`
  - credit_apply: "Store credit applied"
- Amount prefix:
  - pay and credit_apply: none
  - refund: "−"
  - credit_issue: "+"
  - adjust: none. The value is always `money(abs(amt))`, so a discount appears as an unsigned "$25.00" in red.
- Meta is the `' · '`-join of the non-empty values of:
  1. `e.t`
  2. `e.by` plus `' (role)'` if `byRole`
  3. `e.reason` (refund type only)
  4. `e.note`
  5. `'Expires: '+e.expiry`
  6. `'Approved by '+e.approvedBy`
- Fixture `by` is "System" for payments and "Rafael M." as default.

**Pending refund controls** (`sc-if e.pending`)
- Row: `display:flex; gap:6px; margin-top:8px`.
  - **Approve:** `height:34px; padding:0 13px; border-radius:9px; font-weight:800; font-size:12px`.
    - Enabled: `background:var(--accent); color:#fff`.
    - Not allowed: `background:var(--panel3); color:var(--ink3)`.
    - It is never `disabled`. Clicking it when not allowed flashes `Your role can’t approve {money(amt)}`.
  - **Deny:** `height:34px; padding:0 13px; border-radius:9px; background:var(--panel); border:1px solid var(--line); font-weight:700; font-size:12px; color:var(--ink2)`. Always active, with no permission check.
- Note under the buttons: `font-size:11px; font-weight:600; color:var(--ink3); margin-top:5px`.
  - Allowed: `You can approve up to {any amount | $N}.`
  - Else: `Needs a role with a refund limit of at least {money0(amt)}.`
- `canApprove = lim('refund').has && max >= e.amt`.
- Approve sets `status:'done'` and `approvedBy:'Rafael M. · '+roleName`. Flash: `Refund approved · {money(amt)} to {store credit | method}`.
- Deny sets `status:'denied'`. Flash: "Refund request denied". A denied refund stays in the ledger with a gray amount and the title "Refund denied · …", and is excluded from all totals.

### 3.8 Action sheet (modal)
- **Overlay:** `position:fixed; inset:0; z-index:70; background:rgba(8,12,10,.55); display:flex; align-items:center; justify-content:center; padding:24px`. Clicking the overlay closes; the inner panel stops propagation.
- **Panel:** `width:100%; max-width:560px; max-height:100%; display:flex; flex-direction:column; background:var(--bg2); border:1px solid var(--line); border-radius:22px; box-shadow:var(--shadowLg); overflow:hidden`.
- **Header:** `flex:none; display:flex; align-items:center; gap:12px; padding:20px 22px; background:var(--panel); border-bottom:1px solid var(--line)`.
  - Title: Bricolage 700 / 20px.
  - Sub: 12.5px / 600 / `--ink2`, `margin-top:2px`.
  - Close: 42×42, `border-radius:11px; background:var(--panel2); border:1px solid var(--line); color:var(--ink2)`, with a 16×16 X icon (`M6 6l12 12M18 6L6 18`, width 2.2, round).
- **Body:** `flex:1; min-height:0; overflow-y:auto; padding:20px 22px; display:flex; flex-direction:column; gap:16px`.
- **Footer:** `flex:none; display:flex; gap:10px; padding:16px 22px; border-top:1px solid var(--line); background:var(--panel)`.
  - Cancel: `height:52px; padding:0 20px; border-radius:13px; background:var(--panel2); border:1px solid var(--line); font-weight:700; font-size:14px`. Label "Cancel".
  - Submit: `flex:1; height:52px; border-radius:13px; font-weight:800; font-size:15px`. Disabled while `blocked`. Colors:
    - Blocked: `background:var(--panel3); color:var(--ink3)`.
    - Else for refund: `background:var(--red); color:#fff`.
    - Else: `background:var(--accent); color:#fff`.

Shared widgets:
- **Segmented control** (`seg(on)`): container `display:flex; gap:4px; padding:4px; background:var(--panel); border:1px solid var(--line); border-radius:12px`. Button `flex:1; height:40px; padding:0 12px; border-radius:9px; font-size:13px; font-weight:700; white-space:nowrap`. Active is `--accent` / `#fff`, inactive is transparent / `--ink2`.
- **Reason chip** (`chip(on)`): `height:38px; padding:0 13px; border-radius:10px; font-size:12.5px; font-weight:700`. Active: `background:var(--accentSoft); color:var(--accentInk); border:1px solid var(--accentBrd)`. Inactive: `background:var(--panel); color:var(--ink2); border:1px solid var(--line)`. They sit in a `display:flex; gap:6px; flex-wrap:wrap` row.
- **Field label:** `font-size:12px; font-weight:700; color:var(--ink2); margin-bottom:6px` (8px for "Reason").
- **Number input:** `width:100%; height:50px; padding:0 14px; border-radius:12px; border:1px solid var(--line); background:var(--panel); color:var(--ink); font-family:inherit; font-size:18px; font-weight:800; inputmode="decimal"`.
- **Note input:** same border and background, but `height:46px; font-size:13.5px; font-weight:600`. Placeholder "Internal note (optional)".
- **Summary box:** `padding:14px 16px; background:var(--panel); border:1px solid var(--line); border-radius:14px`. Rows are `display:flex; justify-content:space-between; padding:5px 0; font-size:13.5px`. Label is 600 / `--ink2`; value is 800 in a per-row color.
- **Perm/permission box** (`permText`): `padding:12px 14px; border-radius:12px; font-size:12.5px; font-weight:700; line-height:1.45`.
  - OK (`permOk`): `background:var(--accentSoft); color:var(--accentInk); border:1px solid var(--accentBrd)`.
  - Not OK: `background:var(--amberSoft); color:var(--amber); border:1px solid var(--line)`.
- Reasons and note appear together (`hasReasons`) for refund, adjust and credit. They are absent for collect and apply.
- Opening a sheet resets form state to:
  `{ mode:'full', items:[], dest:'card', reason:null, note:'', amount:'', kind:'discount', unit:'$', settle:'credit', expiry:'90 days', method:'Card on file' }`.
- The effective reason is `f.reason` if it is in the current reason list, else the first reason of the list. So a reason is always preselected.
- Parsed amount: `parseFloat(String(f.amount).replace(/[^0-9.]/g,''))||0`.

#### 3.8.1 Refund sheet
- Title "Refund". Sub `{id} · {client}` (middle dot).
- Mode seg, three buttons: "Full", "By item", "Custom". Default Full.
- **By item** (`byItems`):
  - A list of item rows, `display:flex; flex-direction:column; gap:6px`.
    - Each row is a button: `display:flex; align-items:center; gap:11px; min-height:50px; padding:0 14px; border-radius:12px`. Selected: `background:var(--accentSoft); border:1px solid var(--accentBrd)`. Unselected: `background:var(--panel); border:1px solid var(--line)`.
    - Checkbox: 22×22, `border-radius:7px`. Selected: `background:var(--accent); border:none`, with a 12×12 white check (`M5 12.5l4.5 4.5L19 7`, width 3). Unselected: transparent with `2px solid var(--ink3)`.
    - Name: `flex:1; text-align:left; font-weight:700; font-size:13.5px`. Price: 800 / 13.5px, shown as `money(price*1.07)` (tax-inclusive).
  - Note below: "Tax on selected items is refunded proportionally." 11.5px / 600 / `--ink3`.
  - Items are indexed by position in `tx.items`.
- **Custom** (`byCustom`): label "Amount", number input, placeholder "0.00".
- **"Refund to"** seg: "Original payment" (`card`), "Store credit" (`credit`), "Cash" (`cash`). Default is `card`.
- Reason chips: "Service issue", "Customer canceled", "Duplicate charge", "Pricing error", "Goodwill", "Add-on not performed". Then the note input.
- Computed value `val`:
  - Full: `c.refundable`
  - By item: `min(c.refundable, r2(Σ price × 1.07))`
  - Custom: parsed amount
- Summary rows:
  1. "Refundable" `money(refundable)` (ink)
  2. "This refund" `money(val)` (red)
  3. "Collected after" `money(paid − refunded − val)` (accentInk)
  4. When dest = credit: `{firstName}’s credit after` `money(credit+val)` (amber). The apostrophe is U+2019.
- Validation:
  - `origOk = dest!=='card' || val <= toOrigMax + .001`
  - `over = val > rf.max`
  - `blocked = val<=0 || val > refundable+.001 || !origOk`
- Perm text priority:
  1. `!origOk`: "Only {money(toOrigMax)} was paid by card — refund the rest to store credit." (em dash)
  2. `val>refundable`: "More than the refundable amount."
  3. `over`: "Over your {limTxt} as {Role}. This will be sent for approval."
  4. Else: "Within your {limTxt} as {Role}."
  - `limTxt` is "no limit" or `{money0(max)} limit`.
- Submit label: `over && !blocked` gives "Request approval · {money(val)}"; else "Refund {money(val)}".
- Submit adds a refund event: `{ type:'refund', amt:r2(val), dest, method, reason, note, byRole:roleName, status: over ? 'pending':'done' }`.
  - `method` is "Store credit" / "Cash" / the first `pay` event's method (else "Card").
  - Flash if over: "Sent for approval · {money}".
  - Flash otherwise: `Refunded {money}` plus ` to store credit` or ` to {method}`.

#### 3.8.2 Adjust sheet
- Title "Adjust invoice". Sub `{id} · applied before tax`.
- Row 1 (`display:flex; gap:10px; flex-wrap:wrap`):
  - Kind seg (`flex:1`): "Discount" / "Surcharge". Changing the kind resets the reason to null.
  - Unit seg: "$" / "%". Each unit button is `flex:none; width:48px`.
- Value input: label "Amount ($)" or "Percent of services", placeholder "0".
- Settle seg (`showSettle`): shown only when `kind==='discount' && paid>0 && diff>0.005`.
  - Label "Invoice is already paid — return the difference as".
  - Options "Store credit" (`credit`, default) / "Refund to card" (`card`).
- Reasons and note shown below:
  - Discount: "Service recovery", "Loyalty", "Price match", "Manager discretion"
  - Surcharge: "Extra soil surcharge", "Pet hair surcharge", "Oversize vehicle"
- Math:
  - `pre = unit==='%' ? r2(c.items*amt/100) : amt`
  - `signed = kind==='discount' ? -pre : pre`
  - `newSub = c.sub + signed`
  - `newTotal = r2(newSub*1.07 + tip)`
  - `diff = r2(paid − refunded − newTotal)`
- `over = pre > ad.max`. `blocked = pre<=0 || newSub<0 || over`. There is no approval path, unlike refunds.
- Summary:
  1. "Current total"
  2. "Discount (pre-tax)" or "Surcharge (pre-tax)" with the signed value (discount red)
  3. "New total" (accentInk)
  4. If `diff>0.005 && paid>0`: "Overpaid — returned as store credit|card refund" (amber)
  5. If `diff<-0.005`: "New balance due" `money(-diff)` (red)
- Perm text:
  - `over`: "Over your {limTxt} as {Role}. Ask Management or a Super Admin." (not OK / amber)
  - `newSub<0`: "Discount is larger than the invoice."
  - Else: "Within your {limTxt} as {Role}."
- Submit label "Apply discount" or "Apply surcharge".
- Submit adds an adjust event `{type:'adjust', amt:signed, reason, note}`. If `diff>0.005 && paid>0` it also adds an auto-completed refund event: `{ type:'refund', amt:diff, dest:(settle==='credit'?'credit':'card'), method:(credit ? 'Store credit' : first pay method or 'Card'), reason:'Adjustment settlement', status:'done' }`.
- Flash: `{Discount|Surcharge} applied · new total {money(newTotal)}`.

#### 3.8.3 Credit sheet
- Title "Issue account credit". Sub `{client} · linked to {id}`.
- Input label "Credit amount ($)", placeholder "25.00".
- "Expires" seg: "No expiry", "90 days" (default), "30 days".
- Reason chips: "Service recovery", "Referral reward", "Weather closure", "Goodwill", "Promotion". Then the note input.
- Summary: "Current credit" (ink), "Issuing" with `'+'+money(amt)` (amber), "New balance" `money(credit+amt)` (accentInk).
- `over = amt > cr.max`. `blocked = amt<=0 || over`.
- Perm text:
  - Over: "Over your {limTxt} as {Role}."
  - Else: "Within your {limTxt} as {Role}. Credit can be applied to any future invoice."
- Submit label "Issue {money(amt)} credit". With a $0 amount the label reads "Issue $0.00 credit", disabled.
- Event: `{type:'credit_issue', amt, reason, note, expiry}`. Flash: `{money} credit issued to {client}`.

#### 3.8.4 Collect sheet
- Title "Collect payment". Sub `{id} · {client}`.
- Method seg: "Card on file" (default), "Cash", "Payment link".
- Summary: a single row, "Balance due" `money(balance)` (red).
- Perm box (OK/green): "Receipt goes out by WhatsApp and email."
- Submit label `Collect {money(balance)}`.
- Behavior:
  - "Payment link": no ledger event; closes the sheet and flashes `Payment link sent to {client}`.
  - Otherwise: adds a `pay` event `{amt:balance, method: f.method==='Cash' ? 'Cash' : 'Visa ••4421'}` (card on file is hard-coded to "Visa ••4421"). Flash: `Collected {money}`.
- No reasons or note shown. No permission check inside the sheet; the button was already gated by `pay.collect`.

#### 3.8.5 Apply-credit sheet (kind `'apply'`)
- Title "Apply store credit". Sub is the client name only.
- Summary: "Available credit" `money(credit)` (amber), "Applying" `money(min(credit,balance))` (accentInk), "Balance after" `money(balance − use)` (red).
- Perm box (OK/green): "Store credit is used as a payment on this invoice."
- Submit label `Apply {money(use)}`.
- Event: `{type:'credit_apply', amt:use, method:'Store credit'}`. Flash: `{money} credit applied`.

### 3.9 Toast
- Shown when `toast` is non-null.
- Style: `position:fixed; bottom:26px; left:50%; transform:translateX(-50%); z-index:90; padding:14px 20px; background:var(--ink); color:var(--bg); border-radius:14px; box-shadow:var(--shadowLg); font-weight:700; font-size:13.5px; max-width:90vw`.
- It auto-dismisses after 3000 ms. A new flash resets the timer.

---

## 4. Interaction map (every `sc-camel-on-*` handler)

| Element | Handler and effect |
|---|---|
| Preview-as button | `toggleRoleMenu`: toggles `roleMenu` |
| Role option | `setState({role:id, roleMenu:false})` |
| Theme button | `toggleTheme`: flips theme, writes `localStorage['oasis-theme']`, sets state |
| Range button | `setState({range:k})` |
| Export CSV | `flash('CSV export started · '+inR.length+' invoices')`. No file is generated. |
| "Review" in banner | `openPending`: sets `selId` to the first pending tx and adjusts `range` (see 3.4) |
| Filter button | `setState({filter:k})` |
| Search input (`sc-camel-on-input`) | `setState({query: e.target.value})` |
| Row button | `setState({selId: t.id})` |
| Detail action: Collect / Apply credit / Refund / Adjust / Issue credit | `openSheet('collect'/'apply'/'refund'/'adjust'/'credit')`. They are skipped when disabled. |
| Detail action: Send receipt | `flash('Receipt sent to …')` |
| Ledger Approve | `approve` (see 3.7) |
| Ledger Deny | `deny` (see 3.7) |
| Sheet overlay click, X button, Cancel | `closeSheet`: `sheet:null`. The form state `f` is not cleared until the next `openSheet`. |
| Sheet panel click | `stop`: `stopPropagation` |
| Sheet seg and chip buttons | `setF({...})` (mode, dest, kind, unit, settle, expiry, method, reason, items) |
| Refund item row | toggles the index in `f.items` |
| Sheet amount input | `setF({amount: e.target.value})` |
| Sheet note input | `setF({note: e.target.value})` |
| Sheet submit | `sh.submit`: no-op if `blocked`; else adds ledger event(s), closes the sheet, flashes |

Side-effect helpers:
- `addEvent(id, ev)` appends `{ t:nowT(), by:'Rafael M.', ...ev }` to the tx. `nowT()` yields `'Today h:mm AM/PM'` from the wall clock.
- State persistence: only theme (`oasis-theme`) is persisted. The `oasis-roles` key is read from localStorage on init (written by the Settings design), falling back to `DEF_ROLES`. Everything else, including new ledger events, is in-memory and lost on reload.

---

## 5. View-model contract (`{{ bindings }}` per region)

### Root and header
- `theme`: `'light'|'dark'`.
- `roleName`: string. `roleMenu`: bool. `toggleRoleMenu`, `toggleTheme`: fn.
- `roleOpts[]`: `{ name, lim, onClick, style }`.
- `locked`, `unlocked`: bool.

### Toolbar
- `ranges[]`: `{ label, onClick, style }`.
- `rangeLabel`: string.
- `exportCsv`: fn.

### KPIs
- `kpis[6]`: `{ label, value, sub, color }`.

### Banner
- `hasPending`: bool. `pendingText`: string. `openPending`: fn.

### Charts
- `bars[]`: `{ label, title, netStyle, lossStyle }`. The styles are CSS objects.
- `methods[4]`: `{ label, value, barStyle }`.

### Table
- `filters[5]`: `{ label, count (string), onClick, style, countStyle }`.
- `query`, `onQuery`.
- `rows[]`: `{ id, date, client, vehicle, items, total, status, adjusted, statusStyle, onClick, style }`.
- `noRows`: bool.

### Detail (`d`)
- `d.id`, `d.when`, `d.client`, `d.vehicle`, `d.staff`, `d.status`, `d.statusStyle`.
- `d.big[3]`: `{ label, value, color }`.
- `d.lines[]`: `{ label, value, style, labelStyle, valStyle }`.
- `d.actions[]`: `{ label, onClick, disabled, why, style }`.
- `d.creditLine`: string (empty means hidden).
- `d.ledger[]`: `{ glyph, title, meta, amt, amtColor, dot, pending, approve, deny, approveStyle, approveNote }`.

### Sheet (`sh`), by sheet kind
- Common:
  - `sheetOpen`, `closeSheet`, `stop`.
  - `sh.title`, `sh.sub`, `sh.summary[]` (`{label, value, color}`), `sh.permText`, `sh.permStyle`, `sh.submit`, `sh.blocked`, `sh.submitStyle`, `sh.submitLabel`.
  - `sh.amountRaw`, `sh.setAmount`, `sh.note`, `sh.setNote`, `sh.hasReasons`, `sh.reasons[]` (`{label, onClick, style}`).
- Refund:
  - `sh.isRefund`
  - `sh.modes[]`, `sh.byItems`, `sh.byCustom`
  - `sh.itemRows[]` (`{label, value, on, onClick, style, box}`)
  - `sh.dests[]`
- Adjust:
  - `sh.isAdjust`
  - `sh.kinds[]`, `sh.units[]`, `sh.valueLabel`
  - `sh.showSettle`, `sh.settleLabel`, `sh.settles[]`
- Credit: `sh.isCredit`, `sh.expiries[]`.
- Collect: `sh.isCollect`, `sh.payMethods[]`.
- Apply: no flag. Only `title`, `sub`, and the common fields.

### Toast
- `toast`: string or null.

### Underlying data model (what the backend must hold)

**Invoice (tx)**

| Field | Type or notes |
|---|---|
| `id` | "INV-#####" |
| `off` | day offset from "today" |
| `time` | "H:MM AM/PM" |
| `client` | name string |
| `vehicle` | string |
| `staff` | e.g. "Marco R." / "Lena K." / "Sofia D." / "Unassigned" |
| `items[]` | `{name, price}` |
| `tip` | number |
| `canceled` | bool |
| `events[]` | typed ledger events |

**Ledger event types**

| `type` | Fields |
|---|---|
| `pay` | `amt, method, by, t, deposit?` |
| `adjust` | `amt` (signed), `reason, note?, by, t` |
| `refund` | `amt, dest` ('card'/'credit'/'cash'), `method, reason, note?, by, byRole?, status` ('pending'/'done'/'denied'), `approvedBy?, t` |
| `credit_issue` | `amt, reason, note?, expiry` ('No expiry'/'90 days'/'30 days'/…), `t` |
| `credit_apply` | `amt, method:'Store credit', by, t` |

**Calc**
- `TAX = 0.07`.
- `items = Σ price`.
- `adj = Σ adjust.amt`.
- `sub = items + adj`.
- `tax = r2(sub*0.07)`.
- `total = r2(sub + tax + tip)`.
- `paidOrig = Σ pay.amt`.
- `creditApplied = Σ credit_apply.amt`.
- `paid = r2(paidOrig + creditApplied)`.
- `refunded = r2(Σ done refund.amt)`.
- `refOrig = r2(Σ done refunds with dest≠'credit')`.
- `pending = refund events with status 'pending'`.
- `balance = canceled ? 0 : max(0, r2(total − paid))`.
- `refundable = max(0, r2(paid − refunded − Σ pending.amt))`.
- `toOrigMax = max(0, r2(paidOrig − refOrig))`.
- `issued = Σ credit_issue.amt`.
- `net = r2(items + adj − refunded/1.07)`.
- Status precedence:
  1. canceled and `refunded >= paid` gives "Canceled · refunded"
  2. `refunded>0 && refunded>=paid-0.01` gives "Refunded"
  3. `paid===0` gives "Unpaid"
  4. `balance>0` gives "Partially paid"
  5. `refunded>0` gives "Partially refunded"
  6. else "Paid"
- Display status is "Refund pending" if any pending refund exists.

**Role/permission config (`oasis-roles`, shared with Settings)**
- `roles`: `[{id, name}]`.
- `perms`: `{roleId: {'pay.reports','pay.refund','pay.adjust','pay.credit','pay.collect'}}`.
- `limits`: `{roleId: {refund, adjust, credit}}`. `null` means unlimited.
- `lim(kind, role)`: `{has, max}`.
  - No permission gives `{has:false, max:0}`.
  - `null`, or `undefined` for super, gives `Infinity`.
  - Other `undefined` gives 25.
- The "pay.reports" copy label is "View payment reports".
- Default roles and limits (from `DEF_ROLES`):

| Role | Permissions | Refund / adjust / credit limit |
|---|---|---|
| super | all five | null / null / null |
| mgmt | all five | 1000 / 500 / 500 |
| acct | all five | 500 / 250 / 250 |
| support | refund, adjust, credit, collect (no reports) | 50 / 25 / 50 |
| crew | none | 25 / 25 / 25 |

**Price catalog (`PRICE`)**
- 'Express Hand Wash' 45
- 'Premium Hand Wash + Interior' 129
- 'Premium Hand Wash + Interior Refresh' 139
- 'Executive Detail' 260
- 'Executive Detail + Ceramic' 420
- 'Full Detail' 320
- 'Ceramic Maintenance + Wax' 180
- 'Exotic Detail Package' 650
- 'Family Wash + Pet Hair' 95

**Add-ons (`ADD`)**
- 'Interior deep clean' 60
- 'Pet hair removal' 35
- 'Leather conditioning' 45
- 'Wax' 40
- 'Clay bar' 50
- 'Odor removal' 30
- 'Engine bay cleaning' 55
- 'Ceramic maintenance' 120
- 'Rain repellent' 25
- 'Wheel deep clean' 40

**Named fixtures** (pay `'full'` means the payment equals total minus creditUsed; staff default 'Marco R.'; today = off 0 = Sat Jun 13 2026; `dateOf(off) = new Date(2026,5,13+off)`)

Today:

| id | time | client | vehicle | staff | svc + add | tip | other |
|---|---|---|---|---|---|---|---|
| INV-20608 | 10:05 AM | Aisha Rahman | 2023 Range Rover Sport | Marco R. | Executive Detail + Ceramic + Ceramic maintenance | | pay full, Amex ••3008 |
| INV-20607 | 10:15 AM | Marcus Webb | 2017 Jeep Wrangler | Unassigned | Family Wash + Pet Hair + Odor removal | | pay 20 (deposit), Visa ••6610 |
| INV-20606 | 9:50 AM | Liam Chen | 2020 BMW M340i | Marco R. | Ceramic Maintenance + Wax | | pay full, Visa ••7731 |
| INV-20605 | 10:30 AM | Sofia Marchetti | 2024 Porsche Macan | Sofia D. | Executive Detail | | pay 50 (deposit), Visa ••0092 |
| INV-20604 | 9:40 AM | Jonathan Franco | 2023 Mercedes-Benz GLE | Marco R. | Premium Hand Wash + Interior Refresh + Leather conditioning | | pay full, Apple Pay |
| INV-20603 | 10:31 AM | Priya Nair | 2022 Tesla Model Y | Lena K. | Premium Hand Wash + Interior + Rain repellent | | pay 0 (unpaid) |
| INV-20602 | 9:58 AM | David Okafor | 2019 Ford F-150 | Marco R. | Full Detail + Engine bay cleaning | 20 | adj [-25,'Loyalty'], pay full, Mastercard ••1180 |
| INV-20601 | 8:52 AM | Maria Delgado | 2021 Audi Q5 | Lena K. | Express Hand Wash + Wax | 8 | pay full, Visa ••4421 |

Specials:

| id | off | time | client | vehicle | staff | svc | notes |
|---|---|---|---|---|---|---|---|
| INV-20579 | -1 | 2:10 PM | Chloe Bennett | 2022 BMW X5 | Lena K. | Executive Detail | pay full Visa ••5521; post refund 80, dest card, method Visa ••5521, reason "Service issue", note "Interior stain not fully removed", by "Sofia D.", byRole "Customer Support", status pending, t "Yesterday 4:40 PM" |
| INV-20571 | -2 | 11:00 AM | Omar Haddad | 2023 Porsche 911 Carrera | Marco R. | Full Detail | canceled; pay 50 Visa ••2290; refund 50 card Visa ••2290, reason "Customer canceled", by "Sofia D.", done, t "Jun 11 · 9:12 AM" |
| INV-20566 | -3 | 1:30 PM | Hannah Kim | 2024 Rivian R1S | Marco R. | Premium Hand Wash + Interior + Pet hair removal | tip 10; pay full (default Visa ••4421); refund 37.45 card Visa ••4421, reason "Add-on not performed", by "Rafael M.", done, t "Jun 10 · 3:05 PM" |
| INV-20560 | -4 | 10:20 AM | Victor Nguyen | 2020 Honda Accord | Marco R. | Express Hand Wash | creditUsed 25; pre credit_apply 25 "Store credit" by "Sofia D." t "10:20 AM"; pay full Visa ••8812 |
| INV-20552 | -5 | 3:15 PM | Mateo Silva | 2022 Ford Bronco | Marco R. | Premium Hand Wash + Interior | pay full Apple Pay; credit_issue 25, reason "Service recovery", note "Waited 40 min past slot", expiry "90 days", t "Jun 8 · 4:02 PM" |
| INV-20548 | -6 | 9:00 AM | Zoe Laurent | 2023 Audi e-tron GT | Marco R. | Exotic Detail Package | adj [40,'Extra soil surcharge']; pay full Amex ••1005 |
| auto-id | -14 | 11:30 AM | Priya Nair | 2022 Tesla Model Y | Lena K. | Express Hand Wash | pay full; credit_issue 20, reason "Referral reward", expiry "No expiry", t "May 30 · 11:45 AM" |
| auto-id | -20 | 12:00 PM | Victor Nguyen | 2020 Honda Accord | Marco R. | Express Hand Wash | pay full; credit_issue 25, reason "Weather closure", expiry "90 days", t "May 24 · 12:10 PM" |

- All of these are in-code fixtures. The auto-id rows use a counter that starts at 20610 and decrements (`seq--`).
- Fixture event defaults: `by` is "Rafael M." for adjust, "System" for pay.

**Generated history**
- Seeded PRNG (mulberry32 variant) with seed 987654. Offsets -1 to -29, skipping -10.
- Per day, 2 to 4 invoices. Time is hour 8 to 16, minute "00" or "30".
- Clients come from 17 names: Olivia Hart, Ethan Morales, Isaac Patel, Andre Thompson, Camila Reyes, Noah Fischer, Leah Goldberg, Ruby Castillo, Ava Sinclair, Diego Ramos, Nina Petrova, Caleb Owens, Mia Torres, Julian Brooks, Grace Adeyemi, Tom Bradley, Nathan Brooks.
- Vehicles come from 10 values: 2022 BMW X5, 2021 Toyota 4Runner, 2020 Honda Accord, 2024 Rivian R1S, 2019 Mercedes-Benz C300, 2021 Kia Telluride, 2022 Tesla Model 3, 2024 Lexus GX 550, 2023 Genesis GV80, 2018 Lexus RX 350.
- Staff cycles Marco R. / Lena K. / Sofia D.
- Service is random from `PRICE`. 40% have one random add-on. Tip is 0/5/10/15.
- 8% (`r<0.08`) have a "-15 Loyalty" adjustment.
- Methods list: 'Visa ••4421', 'Mastercard ••1180', 'Apple Pay', 'Apple Pay', 'Cash', 'Amex ••3008' (Apple Pay twice, so weighted double).
- All are paid in full. 5% (`r>0.95`) have a done refund of 20 to store credit, reason "Goodwill", by "Sofia D.", `t:''`.
- This is placeholder volume data. A real backend need not replicate the PRNG.

**Default open invoice, INV-20603**
- Priya Nair has services 129 + 25 = 154; tax 10.78; total $164.78; unpaid; balance $164.78.
- Priya's store credit is $20.00.
- Actions: "Collect $164.78" (primary), "Apply $20.00 credit", Refund (disabled, "Nothing left to refund"), "Adjust", "Issue credit", "Send receipt".
- Big stats: Total $164.78, Collected $0.00, Balance due $164.78.

---

## 6. Fidelity risks and ambiguities

**Silent or ambiguous**
1. **Responsive layout:** none. The page is a fixed `100vh` desktop layout (6-col KPI grid, 440px aside, 5-col table needing at least about 118+170+140+96+150 plus gaps). Below roughly 1280px wide it will squash or overflow. Tablet and mobile behavior is undefined.
2. **CSV export:** no columns, delimiter, filename or data scope are defined. Only the toast copy is.
3. **Receipt:** "Send receipt" is toast-only (WhatsApp plus email). There is no preview or template.
4. **Payment-link flow:** the design has no link UI, only a toast. There is no `pending` state or expiry for links.
5. **Card on file:** hard-coded to "Visa ••4421" regardless of client. There is no card-selection UI.
6. **Real-time "Today":** the design is frozen at Sat June 13 2026. Range labels are literal strings. The backend must derive these from the real current date, and the weekday letters in chart labels depend on it.
7. **Staff/actor identity:** "Rafael M." is hard-coded as the acting user. The previewed role does not change the actor name, only the role label.
8. **Locked state:** all roles with no `pay.reports` see the locked card, including Customer Support (despite its role-menu text "refunds ≤ $50").
9. **Currency, locale and timezone:** en-US, USD, `toLocaleString`. Times are display strings "H:MM AM/PM", not timestamps. Event times such as "Jun 11 · 9:12 AM" and "Yesterday 4:40 PM" are free-form strings. A backend must produce equivalent formatted strings, or the UI must format them (relative "Today", "Yesterday", then "Mon D").

**Behavioral quirks to decide on explicitly (replicate or fix)**
10. Adjust ledger amount shows as unsigned "$25.00" in red, while the breakdown shows "−$25.00".
11. Banner pluralization ("2 refund awaiting approval") and only the first pending item is described. Count is global across all ranges.
12. "Credits issued" sub-label says "clients" but counts invoices.
13. **Self-approval:** nothing blocks the requester from approving their own refund. Deny has no permission check at all. Approve checks only the approver's refund limit.
14. **Refund approval with insufficient state:** approving does not recheck refundable or toOrigMax. A pending refund reduces `refundable` but not `toOrigMax`.
15. **Cash refunds count against the original-payment cap:** `refOrig` includes every non-credit done refund. The over-cap message always says "paid by card", even for cash or Apple Pay payments.
16. **Refund method choice:** the "Original payment" refund uses the first `pay` event's method only, not a split across payments.
17. **Adjust over-limit** hard-blocks with no approval route, unlike refunds. The adjust limit is checked against the pre-tax amount. Percent discounts are of `c.items` (services only), not subtotal after prior adjustments.
18. **Adjustment settlement refund** auto-completes (status done) with no approval, even if it exceeds the refund limit or the user lacks `pay.refund`.
19. **Net revenue** excludes tip and tax but subtracts refunds divided by 1.07. It does not reduce net for store-credit refunds differently. The chart's loss bars mix tax-inclusive refunds with pre-tax discounts.
20. **Collected-by-method** ignores refunds. It lumps any unrecognized method (including a "Store credit" refund method, if recorded as a pay) into Store credit.
21. Clients are keyed by display-name string (`clientCredit`, "Priya Nair" appears in multiple invoices). The backend should use a client id. Two distinct clients with the same name would merge credit.
22. `lim()` precedence: `v===null || (v===undefined && r==='super') ? Infinity : (v===undefined ? 25 : v)`. The fallback limit for a role with a missing value is $25.
23. Rows and the detail panel are decoupled from filters and ranges. The Review jump can leave a selected invoice hidden in the table.
24. The sheet's `f` persists after close but is reset on the next open. The reason defaults to the first item with no "none" choice, so a reason is always submitted.
25. No loading, error, offline or optimistic-failure states exist. Every action succeeds synchronously.
26. Persisted state: only the theme. Ledger changes vanish on reload, so the backend must persist events, approvals, denials and settlement refunds.

**Pixel-fidelity pitfalls**
27. Odd decimal sizes (12.5, 13.5, 14.5, 10.5, 11.5, 19px) must be kept as is. `tnum` must be on for the numerals to align. Bricolage 700 numerals in KPIs need the same font.
28. The `−` in money strings is U+2212, not a hyphen. The ledger and breakdown use it. Em dashes (U+2014) appear in the banner, refund validation and adjust copy; "·" is U+00B7; "↩", "±", "◆" are literal glyphs and rely on font fallback in Manrope.
29. Row selected highlight is `--accentSoft`, and there is no hover. A hover effect added by an implementer would be a deviation.
30. The pending banner border is `--line`, not amber. Same for the amber-soft perm box (border `--line`). Do not add amber borders.
31. Bar layout: the loss segment sits above the net segment, with a 2px gap even when loss is 0. The net bar's min-height is 3px only when net>0. Labels in the 30d view are blank for most buckets.
32. Theme toggle uses the same moon icon in both modes; the preview button uses a dashed border (distinct from every other control).
33. The "Made with Claude Design" badge is prototype chrome and should not be rebuilt.