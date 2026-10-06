<!-- Reference material generated during planning (2026-10-06) from the three Claude Design prototypes. Source of truth for the build; see docs/plan.md. -->

# Oasis Command Center (Operations) — UI / visual-fidelity spec

Source: `artifact-1f91dadc-…-21b8.html`. I read all of the markup (83,526 chars) and all of the script (80,514 chars) and extracted the `@font-face` metadata. Values are verbatim from the source.

Conventions:
- "ink" means CSS variable `--ink`, and so on for the other variables.
- `{{x}}` is a template binding.
- Styles marked "(computed)" come from the script's style objects and are quoted in the region sections.
- Bare `$preview` means `{"width":1480,"height":1000}`.

---

## 1. Page frame & global chrome

### 1.1 Frame
- **Preview size:** `data-props = {"$preview":{"width":1480,"height":1000}}`. The design is fixed-layout, built for 1480x1000, and has no responsive breakpoints.
- **Page rules:** `html,body{margin:0;padding:0;height:100%;overflow:hidden;}`, `*{box-sizing:border-box;}`, `body{background:var(--bg);}`. The page never scrolls. Each region scrolls internally.
- **Root wrapper:** `<div data-theme="{{ theme }}" data-screen-label="Oasis Command Center">`.
  - Style: `height:100vh;overflow:hidden;display:flex;flex-direction:column;background:var(--bg);color:var(--ink);font-family:'Manrope',system-ui,sans-serif;-webkit-font-smoothing:antialiased;font-feature-settings:'tnum';letter-spacing:-0.01em;`.
  - The theme attribute is on this wrapper, not on `<html>`. All fixed overlays (modal, slide-over, toast, ghost) are children of it, so they inherit the theme variables.
- **Vertical stack, top to bottom:**
  1. header (`flex:none`)
  2. emergency banner (conditional, `flex:none`)
  3. KPI strip (`flex:none`)
  4. view switcher row (`flex:none`)
  5. `<main>` (`flex:1;min-height:0;`)
  6. overlays
- **Global element rules:**
  - Scrollbar: `::-webkit-scrollbar{width:10px;height:10px;}`. Thumb: `background:var(--line);border-radius:8px;border:3px solid transparent;background-clip:padding-box;`. Thumb hover: `background:var(--ink3);background-clip:padding-box;`.
  - `input::placeholder{color:var(--ink3);}`
  - `input:focus{outline:none;}`
  - `button{font-family:inherit;cursor:pointer;border:none;background:none;}`
  - `a{color:var(--accent);text-decoration:none;}`
  - `a:hover{color:var(--accentInk);}`

### 1.2 Header
Style: `flex:none;display:flex;align-items:center;gap:18px;padding:14px 26px;background:var(--bg);border-bottom:1px solid var(--line);`. Children, left to right:

**A. Brand block** (`display:flex;align-items:center;gap:13px;flex:none`)
- **Logo tile:** 42x42, `border-radius:13px`, `background:var(--accent)`, centered content, `box-shadow:0 6px 16px var(--accentSoft)`. It holds a 24x24 SVG (viewBox 0 0 24 24, fill none, all strokes `#fff`) with three elements:
  - `<path d="M5 13c0-3.5 2.5-7 7-7s7 3.5 7 7" stroke-width="2.1" stroke-linecap="round">` (arc).
  - `<path d="M3 16.5c1.2-.9 2.1-.9 3.3 0 1.2.9 2.1.9 3.3 0 1.2-.9 2.1-.9 3.3 0 1.2.9 2.1.9 3.3 0 1.2-.9 2.1-.9 3.3 0" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">` (wave).
  - `<circle cx="12" cy="12.5" r="1.6" fill="#fff">`.
- **Text block** (`line-height:1.05`):
  - "Oasis Auto Spa": Bricolage Grotesque 700, 18px, `letter-spacing:-0.02em`.
  - "Command Center": 11px, 600, ink3, `letter-spacing:0.04em`, uppercase.

**B. Primary nav** (`display:flex;align-items:center;gap:4px;padding:4px;background:var(--panel2);border:1px solid var(--line);border-radius:13px;flex:none`)
- Three `<a>` items, each `display:flex;align-items:center;height:38px;padding:0 16px;border-radius:10px;font-size:13.5px;font-weight:700`.
- Items and hrefs:
  - "Operations" → `Oasis%20Command%20Center.dc.html`. Active style: `background:var(--accent);color:#fff`.
  - "Payments" → `Oasis%20Payments.dc.html`. Inactive: `color:var(--ink2)`.
  - "Settings" → `Oasis%20Settings.dc.html`. Inactive: `color:var(--ink2)`.
- The active state is hard-coded per page, so there is no active-route binding.

**C. Search** (center region)
- Wrapper: `flex:1;display:flex;justify-content:center;min-width:0`. Inner: `position:relative;width:100%;max-width:430px`.
- Magnifier SVG: 17x17 (circle cx11 cy11 r7, stroke `var(--ink3)` 2; line `M20 20l-3.5-3.5`). Positioned `position:absolute;left:15px;top:50%;transform:translateY(-50%)`.
- Input: `id="oa-search"`, `value={{search}}`, `placeholder="Search customer, phone, plate, vehicle…   /"` (three spaces before `/`).
  - Style: `width:100%;height:46px;padding:0 16px 0 42px;background:var(--panel);border:1px solid var(--line);border-radius:13px;color:var(--ink);font-size:14px;font-weight:500;font-family:inherit;`.
  - Focus has no outline and no style change.

**D. Action cluster** (`display:flex;align-items:center;gap:9px;flex:none`)
1. **"New Appointment"** button.
   - Style: `display:flex;align-items:center;gap:8px;height:46px;padding:0 18px;background:var(--accent);color:#fff;border-radius:13px;font-weight:700;font-size:14px;box-shadow:0 6px 16px var(--accentSoft);`.
   - Icon: plus, 18x18, `M12 5v14M5 12h14`, stroke `#fff` 2.2 round.
2. **"Walk-in"** button: `height:46px;padding:0 16px;background:var(--panel);border:1px solid var(--line);border-radius:13px;font-weight:700;font-size:14px;color:var(--ink);`.
3. **Theme toggle:** `title="Toggle theme"`, 46x46, panel background, `1px solid var(--line)`, `border-radius:13px`, `color:var(--ink2)`.
   - Dark theme shows a sun icon: 19x19, circle r4.5, rays `M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4`, currentColor, stroke 2, round caps.
   - Light theme shows a moon icon: 19x19, `M20 14.5A8 8 0 019.5 4 7 7 0 1020 14.5z`, currentColor, stroke 2, round join.
4. **Bell button:** `position:relative`, 46x46, same chrome as the theme toggle.
   - Icon: 19x19, `M18 9A6 6 0 006 9c0 6-2.5 8-2.5 8h17S18 15 18 9z` plus `M10 20a2 2 0 004 0`, stroke 2.
   - Red dot: `position:absolute;top:9px;right:10px;width:8px;height:8px;border-radius:50%;background:#E0533B;border:2px solid var(--panel)`.
   - It has no handler and the dot is always shown.
5. **Role chip:** `display:flex;align-items:center;gap:9px;padding:4px 12px 4px 4px;background:var(--panel);border:1px solid var(--line);border-radius:13px`.
   - Avatar: 36x36, `border-radius:10px`, accentSoft background, accentInk text, 800, 13px, text "RM".
   - Name block (`line-height:1.1`): "Rafael M." (700, 13px) and "Manager" (11px, ink3, 600).
   - The user is hard-coded. There is no dropdown and no handler.

### 1.3 Emergency banner
Visibility is `<sc-if emergencyOn>`, where `emergencyOn = !!(emergency && emergency.active)`.
- **Bar style:** `flex:none;display:flex;align-items:center;gap:12px;margin:14px 26px 0;padding:11px 12px 11px 18px;background:#C2410C;border-radius:14px;color:#fff;`.
- **Children:**
  - White dot: 9x9, `border-radius:50%`, `background:#fff`, `flex:none`.
  - Text: `flex:1;min-width:0;font-size:13.5px;font-weight:700;`. Copy: `Emergency closure active · {{ emergencyText }}`. `emergencyText` is `emergency.summary` or `''`.
  - "Manage" link → `Oasis%20Settings.dc.html#emergency`. Style: `height:38px;padding:0 16px;display:flex;align-items:center;border-radius:10px;background:#fff;color:#C2410C;font-weight:800;font-size:13px;`. This `a` rule overrides the hover colour, so the link stays orange.
- **Data source:** `localStorage['oasis-emergency']`, read once in the constructor. The Settings page writes `{active, summary, …}`. The banner is not reactive to storage events.
- **Ambiguity:** the design is silent on what the emergency closure does to the calendar or bookings. The Command Center only shows the banner.

### 1.4 View switcher row (below the KPI strip)
Style: `flex:none;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 26px 6px;`.

**Left group** (`display:flex;align-items:center;gap:12px;flex-wrap:wrap`)
- **View tabs container:** `display:flex;align-items:center;gap:6px;padding:5px;background:var(--panel);border:1px solid var(--line);border-radius:14px`.
  - Tabs in order: Timeline, Bay Board, Staff, Calendar (keys `timeline`, `bay`, `staff`, `calendar`).
  - Each tab is a button with a 16x16 icon span, then the label. Style (computed): `display:flex;align-items:center;gap:8px;height:40px;padding:0 18px;border-radius:11px;font-size:13.5px;font-weight:700;`.
  - Active: `background:var(--panel2);color:var(--ink);border:1px solid var(--line)`.
  - Inactive: `background:transparent;color:var(--ink2);border:1px solid transparent`.
  - Tab icons (viewBox 0 0 24 24, 16x16, stroke currentColor 2, rendered via `dangerouslySetInnerHTML`):
    - timeline: `M4 6h16M4 12h16M4 18h10`, round caps.
    - bay: two rects, `x3 y4 w8 h16 rx1.5` and `x13 y4 w8 h16 rx1.5`.
    - staff: circle `cx9 cy8 r3`, plus path `M3.5 19a5.5 5.5 0 0111 0M16 6.5a3 3 0 010 5.5M18 13a5 5 0 013 4.5`.
    - calendar: rect `x3 y5 w18 h16 rx2`, plus `M3 9h18M8 3v4M16 3v4`.
- **Range tabs:** visible only when `showRange` (`view !== 'calendar'`).
  - Container: `display:flex;align-items:center;gap:4px;padding:4px;background:var(--panel2);border:1px solid var(--line);border-radius:13px`.
  - Tabs: "Next 24h" (`next24`), "Today" (`today`), "Tomorrow" (`tomorrow`), "Week" (`week`).
  - Each tab (computed): `height:36px;padding:0 14px;border-radius:10px;font-size:13px;font-weight:700;white-space:nowrap`.
  - Active: `background:var(--accent);color:#fff`.
  - Inactive: `background:transparent;color:var(--ink2)`.

**Right group** (`display:flex;align-items:center;gap:14px`)
- **Live clock:** `display:flex;align-items:center;gap:7px;font-size:13px;font-weight:600;color:var(--ink2)`.
  - Dot: `8x8`, `border-radius:50%`, `background:var(--accent)`, `box-shadow:0 0 0 4px var(--accentSoft)`.
  - Text: `{{clockLabel}}` = `'Live · '+nowClock()`. This is the real wall-clock time as `h:mm AM/PM`, re-rendered every second.
- **Date label:** `font-size:13px;font-weight:600;color:var(--ink3)`. Text: `{{dateLabel}}` = hard-coded `'Saturday, June 13'`.

### 1.5 Main container
`<main style="padding:8px 26px 18px;flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden;">`. It holds exactly one of the four view panels, chosen by `isTimeline`, `isBay`, `isStaff` or `isCalendar`.

---

## 2. Design tokens

### 2.1 Colour variables

| Var | Light (`:root, [data-theme="light"]`) | Dark (`[data-theme="dark"]`) |
|---|---|---|
| `--bg` | `#ECEBE4` | `#0C100E` |
| `--bg2` | `#F4F3EE` | `#10150F` |
| `--panel` | `#FFFFFF` | `#161E1A` |
| `--panel2` | `#F5F4EF` | `#1C2620` |
| `--panel3` | `#EEEDE6` | `#212C26` |
| `--ink` | `#18211E` | `#ECF1EE` |
| `--ink2` | `#5C645F` | `#9BA7A0` |
| `--ink3` | `#949A94` | `#69756E` |
| `--line` | `#E2E0D7` | `#283330` |
| `--line2` | `#EDEBE3` | `#222B27` |
| `--accent` | `#0E7A63` | `#2FB694` |
| `--accentInk` | `#0A5C49` | `#7FE0C6` |
| `--accentSoft` | `#DCEEE8` | `#15302A` |
| `--accentBrd` | `#BFE0D5` | `#23463D` |
| `--shadow` | `0 1px 2px rgba(24,33,30,.04),0 6px 22px rgba(24,33,30,.07)` | `0 1px 2px rgba(0,0,0,.3),0 8px 26px rgba(0,0,0,.35)` |
| `--shadowLg` | `0 24px 70px rgba(24,33,30,.22)` | `0 30px 80px rgba(0,0,0,.6)` |

Theme persistence: `localStorage['oasis-theme']`, either `'light'` (default) or `'dark'`.

### 2.2 Hard-coded (non-variable) colours
All of these are the same in light and dark unless noted.

**Status meta** (`stMeta`; badge background is `rgba(c, .12)` light / `.18` dark, text is `c` light / `lighten(c)` dark):
- booked `#6B7280`, label "Booked"
- confirmed `#2563EB`, "Confirmed"
- arrived `#7C3AED`, "Arrived"
- cleaning `#C2740B`, **label "In Wash"**
- completed `#0E9E6E`, "Completed"
- canceled `#9F1239`, "Canceled"
- noshow `#B91C1C`, "No-Show"
- Late override: colour `#C2410C`, label "Late". Late applies when `a.late` is true and status is not arrived, cleaning or completed.

**Colour helpers:**
- `hexA(hex,a)` gives `rgba(r,g,b,a)`.
- `lighten(hex)` moves each channel 45% toward white: `c + (255-c)*0.45`, rounded.

**Membership tiers** (`memberMeta`, keyed by the first word of the plan name; `{c, bg}`):
- Essential `{c:#7A8B73, bg:#E9EDE4}`
- Premium `{c:#8A6D3B, bg:#F2E9D6}`
- Executive `{c:#3B5A8A, bg:#E0E8F4}`
- Exotic `{c:#7A3B8A, bg:#EEDFF2}`
- Default `{c:#8A6D3B, bg:#F2E9D6}`
- In dark mode the badge uses `hexA(c,.2)` as background and `lighten(c)` as text colour.

**Membership card tint** (`planTint`): Essential `#5E7A52`, Premium `#8A6D3B`, Executive `#3B5A8A`, Exotic `#7A3B8A`, default `#8A6D3B`. This is a different Essential green from the badge colour.

**Other fixed colours:**
- VIP badge: `#7A3B8A` background, `#fff` text.
- Paid text: `#0D9488` light, `#5FC9A6` dark.
- Due or unpaid text: `#C2410C`.
- Late rail and late badge: `#C2410C`.
- WhatsApp green: dot `#25D366`, text `#1FA855`.
- Warning pill (special instructions): background `#FBEFD9`, border `#F0D9A6`, text `#8A5A12`. Not themed, so it stays light in dark mode.
- Amber amber-dot (new-appointment legend): `#E0A93B`.
- Notification dot: `#E0533B`.
- Swipe underlay gradient: `linear-gradient(90deg,var(--accent) 0 50%,#2C6E8F 50% 100%)`.
- KPI accents: `var(--accent)`, `#C2740B`, `#0E9E6E`, `#C2410C`, `#2563EB`, `#7A3B8A`, `#0D9488`.
- Staff avatar colours: Marco R. `#2563EB`, Lena K. `#0E9E6E`, Sofia D. `#7A3B8A`, Unassigned `#6B7280`.
- Alert tones, `{c, bg(light), bg(dark)}`:
  - red `#C2410C`, `#FBEAE0`, `rgba(194,65,12,.14)`
  - amber `#B07908`, `#FAF0D8`, `rgba(176,121,8,.14)`
  - blue `#2563EB`, `#E5EEFD`, `rgba(37,99,235,.14)`
  - green `#0E9E6E`, `#DCF1E8`, `rgba(14,158,110,.14)`
  - violet `#7A3B8A`, `#F0E3F4`, `rgba(122,59,138,.16)`
- Checklist add-on kind chip: `hexA('#B07908', dark?.22:.14)`; text `#8A5A06` light, `lighten('#B07908')` dark.
- Pickup chip active colour: `#0E7A63`. Pay chip active colour: `#C2410C`.
- Retention "watch" background: `#FBEAE0`, text `#C2410C`.
- Overlay scrims: modal `rgba(8,12,10,.55)` with `blur(4px)`; slide-over `rgba(8,12,10,.5)` with `blur(3px)`.

### 2.3 Fonts
- **Bricolage Grotesque** (display), weights 500, 600, 700, 800, `font-stretch:100%`.
  - Used at 700 only, for: wordmark, section titles, KPI values, vehicle titles, elapsed timers, big counts, modal and tab titles, invoice total, membership card.
  - It is also applied (inline `font-family`) to the avatar initials in the modal header (weight 800) and the new-appointment title (700).
- **Manrope** (body), weights 400, 500, 600, 700, 800.
  - 400 is declared but unused.
  - 500 is used only in the search input.
  - 600, 700, 800 are the main weights.
- Both are loaded as @font-face woff2 files, subset into latin, latin-ext, vietnamese (plus cyrillic and greek for Manrope), with `font-display:swap`. A `fonts.googleapis.com` / `fonts.gstatic.com` preconnect is present.
- Root `font-feature-settings:'tnum'` (tabular numerals) is applied to everything, including Bricolage.
- Root `letter-spacing:-0.01em`. Children override it only where noted below.

### 2.4 Type scale in use
Family B means Bricolage 700. Family M means Manrope.

| Size / weight / tracking | Used for |
|---|---|
| B 700 18px, -0.02em | Wordmark "Oasis Auto Spa" |
| B 700 17px | Column titles: Appointment Timeline, Active Bays, Ready & Completed, Needs Attention |
| B 700 16px | "Up Next" title (bay view) |
| B 700 25px, -0.02em | KPI value |
| B 700 20px, -0.02em | Calendar period label |
| B 700 23px, -0.02em, lh 1.1 | Bay vehicle (timeline view) |
| B 700 26px, -0.02em | Bay vehicle (bay view) |
| B 700 30px, -0.02em | Bay elapsed (timeline) |
| B 700 38px | Bay elapsed (bay view) |
| B 700 28px, -0.02em | Week cell date number |
| B 700 46px, lh 1, -0.03em | Week cell count |
| B 700 22px | Calendar "Closed" |
| B 800 22px | Modal initials avatar |
| B 700 24px, -0.02em | Modal customer name |
| B 700 20px | Overview card values (vehicle, service) |
| B 700 19px | Tab titles: Service Checklist, Add-on Services, Photos & Documentation, Conversation, Service History |
| B 700 18px | Invoice title |
| B 700 20px | New-appointment title |
| B 700 22px | Add-ons total |
| B 700 38px, -0.02em | Pay big amount |
| B 700 26px | Membership card name |
| B 700 30px | Membership stat numerals |
| B 700 18px (weight 800 for total) | Invoice total value |
| M 800 14px, -0.01em | Timeline time |
| M 700 15px, -0.01em | Timeline card name |
| M 700 14.5px, -0.01em | Completed-card name |
| M 600 12.5px | Vehicle line and service text |
| M 800 11px, 0.01em | Status badge |
| M 800 10px, 0.04em | VIP badge (modal: 11px) |
| M 800 10px, 0.03em, uppercase | Member badge (modal: 11px) |
| M 700 11px, 0.05em, uppercase | KPI label |
| M 800 11px, 0.07em, uppercase | Timeline day-divider |
| M 800 11px, 0.06em, uppercase | Modal section labels |
| M 800 12px, 0.06em, uppercase | Week-cell day-of-week; also membership card caption |
| M 800 11px, 0.06em, uppercase | Month-grid day headers |
| M 700 10.5px, 0.04em, uppercase | "Next" mini label |
| M 800 10.5px, 0.04em, uppercase | Checklist kind chip |
| M 800 15px | Bay-view and stage inline emphasis |
| M 800 16px | "Message Customer" / next action button |
| M 800 15.5px | "Mark Paid" |
| M 700 14px | Default buttons |
| M 700 13.5px | Nav item and many secondary text blocks |
| M 600 11.5px, lh 1.4 | Timeline hint text |
| M 600 13px, lh 1.5 | Empty states |

### 2.5 Radii
- Chips and badges: 6, 7, 8, 9px.
- Small buttons and inputs: 10, 11, 12, 13, 14px (46px header controls use 13px).
- Cards: 15px (timeline card), 16px, 17px (modal avatar), 18px.
- Panels: 20px (main columns).
- Modal: 24px.
- Round: 50% (dots, progress rings, check-circle).
- Progress bar: 6px (10px high) and 7px (12px high, bay view).
- Pills in slots: 20px (template pills).
- Message bubbles: `15px 15px 4px 15px` (outgoing), `15px 15px 15px 4px` (incoming).

### 2.6 Shadows
- Panels and cards: `var(--shadow)`.
- Modal, slide-over, toast, drag ghost: `var(--shadowLg)`.
- Primary buttons: `0 6px 16px var(--accentSoft)`.
- Bay primary: `0 8px 18px var(--accentSoft)`.
- "Mark Paid": `0 8px 20px var(--accentSoft)`.
- Modal next-action: `0 10px 24px var(--accentSoft)`.
- "Book Appointment": `0 8px 20px var(--accentSoft)`.
- Membership card: `0 12px 30px hexA(planTint,.35)`.
- Active segmented tab: `var(--shadow)` (calendar mode buttons only).

### 2.7 Spacing rhythm
- Page gutter: 26px (header, banner, KPI, switcher, main).
- Column gap: 18px (timeline view, bay view). KPI gap: 12px. Staff grid gap: 16px.
- Common gaps: 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16, 18.
- Panel padding: 18px (timeline, completed, needs-attention aside, up-next); 20px (bay shell).

### 2.8 z-index layers
- Card within its wrapper: `z-index:1`.
- Completed header sticky: 2.
- Timeline header sticky: 3.
- Client-file modal scrim: 60.
- New-appointment slide-over scrim: 70.
- Toast: 90.
- Drag ghost: 95.
- Claude Design branding badge: `2147483646`.

### 2.9 `@keyframes`

| Name | Definition | Used where |
|---|---|---|
| `oa-pulse` | `0%,100%{opacity:1} 50%{opacity:.32}` | Defined, never referenced in this design |
| `oa-spin` | `to{transform:rotate(360deg)}` | Defined, never referenced |
| `oa-rise` | `from{opacity:0;transform:translateY(16px) scale(.985)} to{opacity:1;transform:none}` | Modal (`.24s cubic-bezier(.2,.7,.3,1)`) and toast (`.22s ease`) |
| `oa-fade` | `from{opacity:0}to{opacity:1}` | Modal scrim and slide-over scrim (`.18s ease`) |
| `oa-slide` | `from{transform:translateX(100%)}to{transform:none}` | Slide-over panel (`.26s cubic-bezier(.2,.7,.3,1)`) |
| `oa-toast` | `from{opacity:0;transform:transl(0,14px)}…` | Defined with an invalid function (`transl`) and never referenced |

### 2.10 Transitions
- Timeline card: `transition:transform .12s ease`.
- Swipe snap-back: inline `transition:transform .22s ease`.
- Bay progress fill: `transition:width 1s linear`.
- Free-bay shell: `transition:border-color .12s ease`.
- Drop zone: `transition:all .12s ease`.
- Calendar hour row: `transition:background .12s ease`.
- There is no entry or exit animation for views or cards. `sc-if` toggles mount and unmount instantly.

---

## 3. Region-by-region component spec (DOM order)

The header, banner and view switcher are covered in section 1.

### 3.1 KPI strip
- **Container:** `flex:none;display:grid;grid-template-columns:repeat(7,1fr);gap:12px;padding:16px 26px 4px;`.
- **Card:** `position:relative;padding:14px 16px;background:var(--panel);border:1px solid var(--line);border-radius:15px;overflow:hidden;`.
- **Left accent bar:** `position:absolute;left:0;top:0;bottom:0;width:3px;background:{{k.accent}}`.
- **Label:** `font-size:11px;font-weight:700;color:var(--ink3);text-transform:uppercase;letter-spacing:0.05em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`.
- **Value row:** `display:flex;align-items:baseline;gap:7px;margin-top:7px`.
  - Value: Bricolage 700 25px, -0.02em.
  - Sub: 12px, 600, ink2.
- **Seven KPIs** (label, value, sub, accent):

| # | Label | Value | Sub | Accent | Computed from |
|---|---|---|---|---|---|
| 1 | "Appointments 24h" | all appointment count | `'12 booked'` (hard-coded) | accent | `all.length` |
| 2 | "Active jobs" | count | `'in bays'` | `#C2740B` | status = cleaning |
| 3 | "Ready for pickup" | count | `'notify'` if > 0 else `'clear'` | `#0E9E6E` | completed and pickup ≠ collected |
| 4 | "Pending payments" | count | `$sum` | `#C2410C` | day 0, pay ≠ paid, status not canceled/noshow; sum of `balance()` |
| 5 | "Bay time free" | `'3.5h'` (hard-coded) | `'today'` | `#2563EB` | static |
| 6 | "Members today" | count | `'of '+day0.length` | `#7A3B8A` | day 0 with a member |
| 7 | "Revenue today" | `$` | `'paid'` | `#0D9488` | sum of `total().grand` for day-0 paid |

The KPIs ignore search and range filters.

### 3.2 View: Timeline (`isTimeline`)
Container grid: `display:grid;grid-template-columns:392px 1fr 356px;gap:18px;align-items:start;height:100%;min-height:0;`. The three columns follow.

#### 3.2.1 Column 1: Appointment Timeline (`<section>`)
- **Section style:** `background:var(--panel);border:1px solid var(--line);border-radius:20px;padding:18px 18px 10px;box-shadow:var(--shadow);height:100%;min-height:0;overflow-x:hidden;overflow-y:auto;`.
- **Sticky header:** `position:sticky;top:0;z-index:3;background:var(--panel);padding:2px 2px 12px;`.
  - Title row: flex, space-between.
    - "Appointment Timeline": Bricolage 700 17px.
    - `{{apptCount}} in 24h`: 12px, 700, ink3. `apptCount` is the number of timeline items, which are non-completed and not in a bay.
  - Hint: `font-size:11.5px;font-weight:600;color:var(--ink3);margin-top:4px;line-height:1.4;`. Copy: "Drag or long-press onto a bay · swipe right to advance, left to message".
- **Group loop** (`groups`, one per unique `day|time`):
  - **Divider** `{{g.dividerLabel}}`. When shown, the style is `font-size:11px;font-weight:800;color:var(--ink3);text-transform:uppercase;letter-spacing:0.07em;padding:6px 2px 8px;`. Otherwise `display:none`.
    - It is shown for the first group, labelled "Today" (even if that first group is on day 1, since `groups.length===0` yields "Today").
    - It is also shown when the group's day is 1 and the previous group's day is not 1, labelled "Tomorrow".
  - **Group row:** `display:flex;gap:13px;padding:3px 0 14px;`.
    - **Time column:** `flex:none;width:62px;padding-top:2px;text-align:right;`.
      - `{{g.time}}`: 800 14px, -0.01em, e.g. "10:30".
      - `{{g.ampm}}`: 11px, 600, ink3.
    - **Items column:** `flex:1;min-width:0;display:flex;flex-direction:column;gap:10px;border-left:1.5px solid var(--line2);padding-left:14px;position:relative;`.
- **Per-item wrapper:** `position:relative;border-radius:15px;`. It holds two layers.
  1. **Swipe underlay (behind):** `position:absolute;inset:1px;border-radius:14px;display:flex;align-items:center;justify-content:space-between;padding:0 18px;background:linear-gradient(90deg,var(--accent) 0 50%,#2C6E8F 50% 100%);color:#fff;font-weight:800;font-size:13px;`.
     - Left: arrow icon (16x16, `M5 12h14M13 6l6 6-6 6`, stroke `#fff` 2.4 round) followed by `{{a.nextLabel}}`.
     - Right: "Message" followed by a speech-bubble icon (`M4 5h16v11H8l-4 4z`, stroke `#fff` 2.2).
  2. **Card button (front):** `sc-camel-on-click={{a.open}}`, `on-pointer-down={{a.onPointerDown}}`, `on-context-menu={{preventCtx}}`. Style (computed `cardStyle`): `position:relative;z-index:1;width:100%;text-align:left;background:var(--panel);border:1px solid var(--line);border-radius:15px;padding:13px 15px 13px 17px;box-shadow:var(--shadow);cursor:grab|pointer;transition:transform .12s ease;touch-action:pan-y;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;opacity:0.45 while this card is the drag source, else 1`.
     - `cursor` is `grab` when `canDrag` (not in bay and not completed), else `pointer`.
- **Card content, top to bottom:**
  - **Status rail** `{{a.railStyle}}`: `position:absolute;left:0;top:10px;bottom:10px;width:4px;border-radius:4px;background:<status colour or #C2410C if late>`.
  - **Row 1:** `display:flex;align-items:flex-start;justify-content:space-between;gap:8px`.
    - Left block (`min-width:0`):
      - Name row: `display:flex;align-items:center;gap:7px`.
        - Name: 700 15px, -0.01em, `white-space:nowrap;overflow:hidden;text-overflow:ellipsis`.
        - VIP badge, shown if `a.vip`: `font-size:10px;font-weight:800;padding:2px 7px;border-radius:6px;background:#7A3B8A;color:#fff;letter-spacing:0.04em;`. Copy: "VIP".
        - Member badge, shown if `a.member`: style `{{a.memberStyle}}`, label `{{a.memberLabel}}` (the first word of the plan name, so "Premium" for "Premium Care"). Style: `font-size:10px;font-weight:800;padding:2px 7px;border-radius:6px;background:mm.bg (dark: hexA(mm.c,.2));color:mm.c (dark: lighten);text-transform:uppercase;letter-spacing:0.03em`.
      - Vehicle line: `font-size:12.5px;color:var(--ink2);font-weight:600;margin-top:2px;` plus ellipsis. Format `YYYY Make Model · Color`.
    - Status badge `{{a.badgeStyle}}`: `display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:7px;font-size:11px;font-weight:800;white-space:nowrap;background:hexA(c,.12|.18);color:c|lighten(c);letter-spacing:0.01em`. Label is the status label, or "Late".
  - **Service:** `font-size:12.5px;color:var(--ink);font-weight:600;margin-top:9px;` plus ellipsis.
  - **Meta row:** `display:flex;align-items:center;gap:10px;margin-top:9px;flex-wrap:wrap`.
    - Bay label `{{a.bayLabel}}`, either "Bay N" or "No bay": 11.5px, 700, ink2.
    - 3x3 dot separator: `border-radius:50%;background:var(--ink3)`.
    - Duration `{{a.durLabel}}`, "Est. N min": 11.5px, 700, ink2.
    - Dot separator.
    - Pay label with `{{a.payStyle}}`: 11.5px, 800, colour `#0D9488` (dark `#5FC9A6`) if paid, else `#C2410C`. Label values:
      - `Paid`
      - `Deposit · $X due`
      - `$X due`
    - Spacer `flex:1`.
    - Icon wrap (`display:inline-flex;align-items:center;gap:6px`):
      - If `a.hasNotes`: note icon, 13x13 (`M5 4h14v12l-4 4H5z` plus `M15 16v4M15 16h4`), stroke `var(--ink3)` 2. `hasNotes` is `special || (notes && !notes.startsWith('No special'))`.
      - If `a.hasPhotos`: camera icon, 13x13 (rect `x3 y6 w18 h14 rx2.5`, circle r3.2, `M8 6l1.5-2h5L16 6`). `hasPhotos` is `(photos.before + photos.after) > 0`.
      - If `a.hasAddons`: pill `+{{a.addonCount}}`: `font-size:10.5px;font-weight:800;color:var(--accentInk);background:var(--accentSoft);padding:2px 6px;border-radius:6px`.
  - **Next row** `{{a.nextStyle}}`: `display:flex;align-items:center;gap:8px;margin-top:10px;padding-top:10px;border-top:1px solid var(--line2)`.
    - "Next": 10.5px, 700, ink3, uppercase, 0.04em.
    - `{{a.nextLabel}}`: 12.5px, 800, colour = accentInk (dark) or accent (light) when a step exists. Otherwise ink3 with the label "Completed".
    - `nextLabel` values by status: booked "Confirm Appointment", confirmed "Mark Arrived", arrived "Start Cleaning", cleaning "Mark Complete", completed with balance "Collect Payment", otherwise "Completed".
- **Timeline filtering:** items are appointments matching search and range, and not `completed` and not `cleaning` (`inFacility`). Sort is by absolute minutes (`day*1440 + time`), then VIP first.
  - There is no empty state for the timeline. With zero items only the header shows.

#### 3.2.2 Column 2: Active Bays (`<section>`)
- **Section:** `display:flex;flex-direction:column;gap:16px;height:100%;min-height:0;overflow-x:hidden;overflow-y:auto;padding-right:2px;`.
- **Header row:** `display:flex;align-items:center;justify-content:space-between;padding:0 4px;`.
  - "Active Bays": Bricolage 700 17px.
  - `{{inFacilityLabel}}`: 12px, 700, ink3. Value is `N in facility`.
- **Arrival strip** (one row per arrival, before the bays): appointments with `eta` set and status confirmed or booked, VIP first, then ascending ETA.
  - Row style (computed `ar.style`): `display:flex;align-items:center;gap:12px;padding:13px 14px;border-radius:16px;flex-wrap:wrap;`.
    - Normal: `background:var(--panel);border:1px solid var(--line)`.
    - VIP: `background:#F3E8F6` (dark `rgba(122,59,138,.2)`), `border:1px solid rgba(122,59,138,.4)`.
  - Dot (`ar.dot`): 10x10, round, `flex:none`; `#2563EB` normal, `#7A3B8A` VIP.
  - Text block (`flex:1;min-width:180px`):
    - Title: 800 14px. `(VIP arriving in | Arriving in) N min · Name`.
    - Desc: 12.5px, 600, ink2, `margin-top:2px`. `Geofence ETA · YYYY Make Model · <svc up to ' + '> [· Bay N]`.
  - Prep button (`ar.prepStyle`): `height:44px;padding:0 14px;border-radius:11px;font-weight:800;font-size:12.5px`.
    - Not prepped: `background:var(--accent)` (VIP `#7A3B8A`), `color:#fff`. Label `Prep Bay N` (or `—` when no bay).
    - Prepped: `background:var(--accentSoft);color:var(--accentInk)`. Label `Bay N ready ✓`.
  - "Simulate arrival" button: `height:44px;padding:0 12px;border-radius:11px;background:var(--panel2);border:1px solid var(--line);font-weight:700;font-size:12px;color:var(--ink2);`.
- **Bay card** (two bays, 1 and 2). The wrapper carries `data-drop="bay:N"`. There are two states. The shell style is computed per state.

  **Occupied** (an appointment with `bay===N` and status cleaning):
  - **Shell:** `background:var(--panel);border:1px solid var(--line);border-left:4px solid <status colour>;border-radius:20px;padding:20px;box-shadow:var(--shadow);outline:2px dashed #C2410C` while a drag hovers this bay (the "bay is busy" cue); otherwise `outline:none`.
  - **Header row:** flex, space-between, `margin-bottom:16px`.
    - Left (`gap:12px`): bay tag `{{b.tagStyle}}` and badge `{{b.badgeStyle}}`.
      - Bay tag when occupied: `padding:5px 12px;border-radius:9px;background:hexA(meta.c, .12|.2);color:meta.c|lighten;font-weight:800;font-size:13px`. Text "Bay N".
      - Badge: label "In Wash", same badge style as 3.2.1.
    - Right (`gap:8px`): worker name (12px, 700, ink2) plus an avatar tile 30x30, `border-radius:9px`, accentSoft background, accentInk text, 800 11px, with initials from the staff name.
  - **Open-file button** (whole block, `width:100%;text-align:left;background:none;padding:0`):
    - Vehicle title: Bricolage 700 23px, -0.02em, lh 1.1.
    - `{{b.customer}} · {{b.plate}}`: 13.5px, 600, ink2, `margin-top:4px`.
    - Service chip: `display:inline-flex;align-items:center;gap:8px;margin-top:13px;padding:7px 13px;background:var(--panel2);border:1px solid var(--line);border-radius:10px`. Contains a 7x7 dot in the status colour and the service in 700 13px.
  - **Progress block** (if `b.showProgress`, i.e. status cleaning), `margin-top:18px`:
    - Row: `display:flex;align-items:flex-end;justify-content:space-between;margin-bottom:8px`.
      - Elapsed: Bricolage 700 30px, -0.02em, colour = status colour. Format `m:ss`, running. Followed by "elapsed" (13px, 700, ink2).
      - Right-aligned: "Est. completion" (12px, 700, ink2) and `{{b.eta}}` (14px, 800). ETA is `fmtT(parseT(time) + dur)`.
    - Track: `height:10px;border-radius:6px;background:var(--panel3);overflow:hidden`. Fill (computed): `height:100%;width:pct%;background:<status>;border-radius:6px;transition:width 1s linear`.
    - Footer: `display:flex;justify-content:space-between;margin-top:6px;font-size:11px;font-weight:700;color:var(--ink3)`. Left `N% complete`; right `N min total`.
    - `pct = min(100, elapsedMin/dur*100)`.
  - **Action row** (`display:flex;gap:10px;margin-top:18px`):
    - Primary button (computed): `flex:1;height:52px;background:var(--accent);color:#fff;border-radius:13px;font-weight:800;font-size:15px;box-shadow:0 8px 18px var(--accentSoft)`. Label `{{b.nextLabel}}`, normally "Mark Complete".
    - "Open File": `flex:none;height:52px;padding:0 18px;background:var(--panel2);border:1px solid var(--line);border-radius:13px;font-weight:700;font-size:14px;color:var(--ink)`.

  **Free** (no vehicle in the bay):
  - **Shell:** `background:var(--panel);border:1px solid <var(--line) | var(--accentBrd) while any drag | var(--accent) when hovering this bay>;border-radius:20px;padding:20px;box-shadow:var(--shadow);transition:border-color .12s ease`.
  - **Header:** bay tag `padding:5px 12px;border-radius:9px;background:var(--panel2);border:1px solid var(--line);font-weight:800;font-size:13px;color:var(--ink2)`, then "Available" (13px, 700, ink3).
  - **Drop zone** (computed): `display:flex;flex-direction:column;align-items:center;justify-content:center;padding:30px 0 26px;text-align:center;border-radius:14px;border:2px dashed <transparent | accentBrd while drag | accent when hovered>;background:<transparent | accentSoft when hovered>;transition:all .12s ease`.
    - Plus tile: 58x58, `border-radius:16px;background:var(--panel2);border:1.5px dashed var(--line)`, with a 26px plus icon (`M12 8v8M8 12h8`, stroke ink3 2).
    - "Bay open": 700 15px, ink.
    - `{{b.nextUp}}`: 12.5px, 600, ink3. Values: "Next: <Customer> · <time>" or "No vehicles queued".
    - Hint: "Drag or long-press a card onto this bay": 12px, 700, accentInk.
    - "Assign next vehicle" button: `margin-top:14px;height:46px;padding:0 20px;background:var(--accent);color:#fff;border-radius:12px;font-weight:700;font-size:14px`.

#### 3.2.3 Column 3: Ready & Completed (`<aside>`)
- **Aside:** `background:var(--panel);border:1px solid var(--line);border-radius:20px;padding:18px;box-shadow:var(--shadow);height:100%;min-height:0;overflow-x:hidden;overflow-y:auto;`.
- **Sticky header:** `position:sticky;top:0;z-index:2;background:var(--panel);display:flex;align-items:center;justify-content:space-between;padding-bottom:14px;`.
  - Title "Ready & Completed": Bricolage 700 17px.
  - Count pill `{{completedCount}}`: `min-width:24px;height:24px;padding:0 8px;border-radius:8px;background:var(--accentSoft);color:var(--accentInk);display:flex;align-items:center;justify-content:center;font-weight:800;font-size:12px`.
- **List:** `display:flex;flex-direction:column;gap:11px`. Filter: status completed, matching search and range, sorted like the timeline.
- **Completed card shell** (`c.shellStyle`): `position:relative;padding:14px 15px 14px 18px;background:var(--panel2);border:1px solid var(--line);border-radius:15px`.
  - Left accent rail: `position:absolute;left:0;top:13px;bottom:13px;width:4px;border-radius:4px;background:{{c.accent}}`.
    - Green `#0E9E6E` when picked up and paid.
    - Orange `#C2410C` when unpaid.
    - Amber `#B07908` when paid but not picked up.
  - Open button (`width:100%;text-align:left;background:none;padding:0;cursor:pointer`):
    - Row: name (700 14.5px, -0.01em, ellipsis) and time (11.5px, 700, ink3, `flex:none`).
    - Vehicle line: 12.5px, 600, ink2, `margin-top:2px`, ellipsis.
    - Service: 12.5px, 600, ink, `margin-top:7px`.
  - **Chip row** (`display:flex;gap:8px;margin-top:12px`), two toggle chips. Common chip style (computed): `height:34px;padding:0 13px;border-radius:9px;font-weight:800;font-size:12px;display:inline-flex;align-items:center;gap:6px;cursor:pointer`.
    - Active: `background:hexA(c,.14|.22);color:c|lighten(c);border:1px solid hexA(c,.32)`.
    - Inactive: `background:var(--panel);color:var(--ink3);border:1px solid var(--line)`.
    - **Pay chip:** label "Paid" or "Unpaid · collect". Active when unpaid, colour `#C2410C`. Click toggles paid and unpaid.
    - **Pickup chip:** label "Picked up" or "Needs pickup". Active when not collected, colour `#0E7A63`. Click toggles collected and pending.
- **Empty state** (`noCompleted`): `padding:34px 16px;text-align:center;color:var(--ink3);font-weight:600;font-size:13px;line-height:1.5;`. Copy: "No completed jobs yet. Finish a vehicle in a bay and it lands here for payment & pickup."

### 3.3 View: Bay Board (`isBay`)
Container: `display:grid;grid-template-columns:1fr 356px;gap:18px;align-items:start;height:100%;min-height:0;overflow-y:auto;`.

**Left block** (`display:grid;grid-template-columns:1fr 1fr;gap:18px`):

**Bay cards** (two, with `data-drop="bay:N"` and the same computed `shellStyle` as 3.2.2):
- Header row: flex, space-between, `margin-bottom:16px`. It has the bay tag, then the badge (occupied) or "Available" (13px, 700, ink3). There is no worker avatar in this view.
- **Occupied:**
  - Vehicle: Bricolage 700 26px, -0.02em.
  - Line: `{{customer}} · {{plate}} · {{service}}`, 13.5px, 600, ink2, `margin-top:4px`.
  - Progress block, `margin-top:20px`:
    - Elapsed: Bricolage 700 38px, status colour.
    - Right-aligned: "Est. done" (12px, 700, ink2) over `{{eta}}` (15px, 800).
    - Track: `height:12px;border-radius:7px;background:var(--panel3);overflow:hidden`. Fill style is the same computed `progressStyle`.
  - Worker section: `margin-top:18px;padding-top:16px;border-top:1px solid var(--line)`.
    - Label: `Worker · {{worker}}`, 11px, 700, ink3, uppercase, 0.05em, `margin-bottom:10px`.
    - Buttons: primary (same as 3.2.2: `flex:1;height:52px;…`) and "Open File" (same style).
- **Free:** `display:flex;flex-direction:column;align-items:center;justify-content:center;padding:50px 0;text-align:center`.
  - "Bay available": 700 16px, ink2.
  - `{{nextUp}}`: 13px, 600, ink3, `margin-top:4px`.
  - "Assign next vehicle": `margin-top:16px;height:48px;padding:0 22px;background:var(--accent);color:#fff;border-radius:12px;font-weight:700;font-size:14px`.
  - Note that this variant has no dashed drop-zone interior. The drag highlight comes only from the shell border (computed `shellStyle`).

**"Up Next" panel** (`grid-column:1/3;background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:18px;box-shadow:var(--shadow)`):
- Title: Bricolage 700 16px, `margin-bottom:13px`.
- Horizontal scroller: `display:flex;gap:12px;overflow-x:auto;padding-bottom:4px`.
- Queue card (button): `flex:none;width:230px;text-align:left;padding:14px;background:var(--panel2);border:1px solid var(--line);border-radius:14px;touch-action:pan-x;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;`.
  - Handlers: click opens; pointer-down starts a gesture with context `q`; context-menu is prevented.
  - Row 1: time (800 13px) and status badge.
  - Name: `display:flex;align-items:center;gap:6px;font-weight:700;font-size:14.5px;margin-top:8px`. Optional VIP badge (10px, 800, padding 2px 6px, radius 6, `#7A3B8A`).
  - Vehicle line: 12px, 600, ink2, `margin-top:2px`.
  - `{{service}} · {{bayLabel}}`: 12px, 600, ink, `margin-top:7px`.
- Queue contents: sorted items that are not in a bay and not completed (or paid), VIP first, first 6 only. There is no empty state.

**"Needs Attention" aside** (`background:var(--panel);border:1px solid var(--line);border-radius:20px;padding:18px;box-shadow:var(--shadow)`):
- Title: Bricolage 700 17px, `margin-bottom:14px`. Stack: `display:flex;flex-direction:column;gap:10px`.
- Alert card (`al.shellStyle`): `padding:13px 14px;background:<tone.bg>;border:1px solid hexA(tone.c,.2);border-radius:14px`.
  - Top row (`display:flex;gap:11px`):
    - Icon tile (`al.iconStyle`): `width:34px;height:34px;border-radius:10px;background:hexA(c, .16|.28);color:c|lighten(c);display:flex;align-items:center;justify-content:center;font-weight:800;font-size:16px;flex:none`, holding a text glyph.
    - Text block (`flex:1;min-width:0`): title (700 13.5px) and desc (12px, 600, ink2, `margin-top:2px`).
  - Button row (`display:flex;gap:8px;margin-top:11px`):
    - Action: `height:38px;padding:0 15px;background:<tone.c>;color:#fff;border-radius:10px;font-weight:700;font-size:12.5px`.
    - "Open": `height:38px;padding:0 13px;background:transparent;border:1px solid var(--line);border-radius:10px;font-weight:700;font-size:12.5px;color:var(--ink2)`.
  - There is no empty state, and the `alertCount` binding is exposed but not rendered.
- **Needs Attention appears only in Bay Board view.** It is absent from Timeline view.
- **Alert types** (tone, glyph, title, description, action label):
  - green `↑` "Ready for pickup" — `<Name>'s <Make> is done` + ` · payment due` if unpaid — "Mark picked up".
  - red `!` `Running late · <Name>` — `<time> <Make> <Model> — no arrival logged` — "Message customer".
  - amber `◳` "Needs bay assignment" — `<Name> · <svc>` — "Assign bay".
  - blue `→` "Arriving soon" — `<Name> in N min · <Make> <Model>` — `Prep bay N`. Fires when status is confirmed, no `eta`, and 0 < minutes-to-start ≤ 15.
  - amber `?` "Unconfirmed" — `<Name> · <time> hasn't confirmed` — "Send reminder".
  - violet `★` "Special instructions" — `<Name>: <first 46 chars>…` — "View file".
  - violet (VIP) or blue `◎` `(VIP arriving in | Arriving in) N min · <Name>` — `Geofence ETA · <Make> <Model>[ · Bay N]` — `Prep bay N` or `Bay ready ✓`.
  - green `✓` `Auto checked in · <Name>` — `Geofence at <geoIn> · vehicle in the lot` — "Start cleaning".
  - blue `◆` "Member credit available" — `<Name> has 1 unused Premium credit this cycle` — "Apply credit".
  - Sort: VIP-related alerts first (`pri`), otherwise generation order.

### 3.4 View: Staff (`isStaff`)
Container: `display:grid;grid-template-columns:repeat(4,1fr);gap:16px;align-items:start;height:100%;min-height:0;overflow-y:auto;`. The four columns are Marco R., Lena K., Sofia D. and Unassigned (the order is fixed).
- **Column card:** `background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:16px;box-shadow:var(--shadow)`.
- **Header:** `display:flex;align-items:center;gap:11px;padding-bottom:13px;margin-bottom:13px;border-bottom:1px solid var(--line)`.
  - Avatar (computed): `width:40px;height:40px;border-radius:12px;background:hexA(col,.14|.22);color:col|lighten(col);…font-weight:800;font-size:14px`.
    - Initials are the first letters of each word of the name. "Unassigned" shows "—".
  - Name block (`line-height:1.15`): name (700 14.5px) and role (11.5px, 600, ink3).
    - Roles: Marco R. "Lead Detailer", Lena K. "Detailer", Sofia D. "Front Desk", Unassigned "Queue".
  - Count: right-aligned, count (800 15px) over "jobs" (10.5px, 700, ink3, uppercase).
- **Job list:** `display:flex;flex-direction:column;gap:10px`.
  - Job button: `text-align:left;padding:12px;background:var(--panel2);border:1px solid var(--line);border-radius:13px;border-left:3px solid <status colour>`.
    - Row: time (800 12.5px) and status badge.
    - Name: 700 14px, `margin-top:7px`.
    - Vehicle line: 12px, 600, ink2, `margin-top:2px`.
    - Service: 12px, 600, ink, `margin-top:6px`.
  - Empty state per column: "No jobs assigned" (`padding:18px;text-align:center;font-size:12.5px;color:var(--ink3);font-weight:600`).
  - Jobs include every appointment with that staff name, matching search and range, in any status. The cards are not draggable here, because no pointer-down handler is bound.

### 3.5 View: Calendar (`isCalendar`)
Panel: `background:var(--panel);border:1px solid var(--line);border-radius:20px;box-shadow:var(--shadow);height:100%;min-height:0;display:flex;flex-direction:column;overflow:hidden;`. The range tabs are hidden in this view.

**Toolbar:** `flex:none;display:flex;align-items:center;gap:14px;padding:14px 18px;border-bottom:1px solid var(--line2);flex-wrap:wrap;`.
- **Navigation:**
  - Prev: `title="Previous"`, 44x44, `border-radius:12px;background:var(--panel2);border:1px solid var(--line)`, chevron `M15 6l-6 6 6 6` (18x18, currentColor, 2.2).
  - "Today": `height:44px;padding:0 16px;border-radius:12px;background:var(--panel2);border:1px solid var(--line);font-weight:700;font-size:13.5px;color:var(--ink)`.
  - Next: `title="Next"`, chevron `M9 6l6 6-6 6`.
- **Label:** Bricolage 700 20px, -0.02em. Below it, sub in 12px, 700, ink3, `margin-top:1px`.
- **Spacer** `flex:1`.
- **Hint** `{{calHint}}`: 12px, 600, ink3. Day mode: "Drag or long-press to reschedule · swipe for next day". Week and month: "Swipe or use ← → to move".
- **Mode switch:** `display:flex;gap:4px;padding:4px;background:var(--panel2);border:1px solid var(--line);border-radius:12px`. Buttons "Day", "Week", "Month": `height:36px;padding:0 16px;border-radius:9px;font-size:13px;font-weight:700`.
  - Active: `background:var(--panel);color:var(--ink);box-shadow:var(--shadow);border:1px solid var(--line)`.
  - Inactive: transparent, ink2, `border:1px solid transparent`.

**Body wrapper:** `flex:1;min-height:0;overflow-y:auto;touch-action:pan-y;`, with pointer-down and pointer-up handlers for swipe.

**Label and sub-label formats:**
- Day label: `Weekday, Month D` (a `, YYYY` suffix appears if the year ≠ 2026).
- Week label: `Mon D – [Mon ]D, YYYY` (first month abbreviated to 3 letters; the second month is shown only if it differs).
- Month label: `Month YYYY`.
- Day sub:
  - `[Today · ]N appointment(s) · [<reduced-hours note> · ]<open> – <close>`.
  - `Closed` when the day is closed.
- Week sub: `N appointments this week · tap a day to open it`.
- Month sub: `N appointments in <Month> · tap a date to open it`.

#### 3.5.1 Week mode
- **Grid:** `display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:12px;padding:18px;height:100%;min-height:300px;`.
- **Cell button** (computed): `display:flex;flex-direction:column;align-items:flex-start;text-align:left;padding:16px;border-radius:16px;min-height:190px;touch-action:manipulation`.
  - Background: closed `var(--panel3)`; today `var(--accentSoft)`; else `var(--panel2)`.
  - Border: `1px solid var(--accentBrd)` for today, else `var(--line)`.
- **Header row:** `display:flex;align-items:center;justify-content:space-between;width:100%;gap:6px`.
  - Weekday abbreviation: 12px, 800, ink3, uppercase, 0.06em.
  - TODAY pill: `font-size:10px;font-weight:800;color:#fff;background:var(--accent);padding:3px 7px;border-radius:6px`. Copy: "TODAY".
- **Date number:** Bricolage 700 28px, -0.02em, `margin-top:4px`.
- **Spacer** `flex:1`.
- **Open day:** count in Bricolage 700 46px, lh 1, -0.03em, accentInk; below it `{{countLabel}}` (12.5px, 700, ink2, `margin-top:5px`), either "appointment" or "appointments".
- **Closed day:** "Closed" (800 14px, `#C2410C`) and the reason (12px, 600, ink2, `margin-top:2px`).
- **Closed rule:** today (offset 0) is never rendered as closed, even if the closure data would close it.

#### 3.5.2 Month mode
- **Container:** `display:flex;flex-direction:column;height:100%;min-height:440px;padding:12px 18px 18px;`.
- **Header grid:** 7 columns, `gap:8px;margin-bottom:8px`. Each day name (Sun to Sat) is 11px, 800, ink3, uppercase, 0.06em, `padding:0 6px`.
- **Grid:** `flex:1;display:grid;grid-template-columns:repeat(7,minmax(0,1fr));grid-auto-rows:minmax(72px,1fr);gap:8px;`. The cell count is `ceil((lead + daysInMonth)/7)*7`, so 28 to 42 cells.
- **Cell** (computed): `display:flex;flex-direction:column;align-items:flex-start;padding:8px 9px 10px;border-radius:12px;text-align:left;min-height:72px;touch-action:manipulation`.
  - Background: closed day in the month `var(--panel3)`; in-month `var(--panel2)`; out-of-month `transparent`.
  - Border: `1px solid` accentBrd for today, line for in-month, line2 for out-of-month.
  - `opacity:1` in-month, `0.55` out-of-month.
  - Date badge (computed): `28x28;border-radius:8px;font-weight:800;font-size:13px`. Today: `background:var(--accent);color:#fff`. In-month: ink. Out-of-month: ink3.
  - Count pill: `font-size:12px;font-weight:800;padding:4px 9px;border-radius:8px`. In-month: accentSoft with accentInk. Out-of-month: panel3 with ink3. Label is `N appt` or `N appts`.
  - Closed (in-month only): reason text in 11px, 800, `#C2410C`, nowrap, ellipsis, `max-width:100%`.

#### 3.5.3 Day mode
- **Closed notice**, shown if `calClosed` (never for today):
  - `padding:80px 20px;text-align:center`.
  - "Closed": Bricolage 700 22px.
  - Reason: 14px, 600, ink2, `margin-top:6px`.
  - Link "Manage hours & holidays →" → `Oasis%20Settings.dc.html`: `display:inline-block;margin-top:14px;font-weight:700;font-size:13px`.
  - The hour rows still render below this notice, with empty bands covering the default 8 to 17 range.
- **Rows wrapper:** `padding:4px 18px 18px`. One row per hour from open hour to close hour (exclusive), i.e. `h0` to `h1-1`.
- **Row** (computed): `display:flex;gap:16px;border-top:1px solid var(--line2);padding:11px 8px;min-height:66px;transition:background .12s ease`. It carries `data-drop="hr:H"`.
  - While a drag hovers it: add `border-radius:12px;background:var(--accentSoft);outline:2px dashed var(--accent)`.
- **Time column:** `flex:none;width:70px;padding-top:3px;text-align:right`.
  - Hour (12-hour, no minutes): 800 13px.
  - AM/PM: 10.5px, 700, ink3.
- **Items:** `flex:1;display:flex;gap:10px;flex-wrap:wrap`.
  - Chip (computed `chipStyle`): `display:inline-flex;align-items:center;gap:9px;min-height:44px;padding:8px 14px;background:var(--panel2);border:1px solid var(--line);border-left:3px solid <status colour>;border-radius:11px;touch-action:pan-y;user-select:none;cursor:grab|pointer;opacity:.45 while dragging`.
    - Contents:
      - 8x8 status dot (`flex:none`).
      - Name (700 13px).
      - Optional VIP badge (10px, 800, `padding:2px 6px`, radius 6).
      - `{{a.short}}` = `Make Model` (12px, 600, ink2).
      - Status badge.
  - Empty row: "—" (12px, 600, ink3, `padding-top:4px`).
- **Day content:**
  - Today uses `appts` with `day===0`.
  - Other days use `genDay(offset)` (procedural seeded data).
  - Tomorrow (offset 1) merges the real `day:1` appointments in front of the generated ones.
- **Hours and closures:** day info comes from the `hours[getDay()]` and `closures` data (see Appendix B).

### 3.6 Client-file modal ("appointment detail drawer")
Visible when `modalOpen` (a selected appointment exists).

**Scrim:** `position:fixed;inset:0;z-index:60;background:rgba(8,12,10,.55);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;padding:36px;animation:oa-fade .18s ease;`. Click on the scrim closes the modal.

**Dialog:** `width:100%;max-width:1120px;height:100%;max-height:880px;background:var(--bg2);border:1px solid var(--line);border-radius:24px;box-shadow:var(--shadowLg);display:flex;flex-direction:column;overflow:hidden;animation:oa-rise .24s cubic-bezier(.2,.7,.3,1);`. Click inside stops propagation. Its three vertical zones follow.

#### 3.6.1 Header
Style: `flex:none;padding:24px 28px 20px;background:var(--panel);border-bottom:1px solid var(--line);`.
- **Top row:** `display:flex;align-items:flex-start;justify-content:space-between;gap:18px`.
  - **Left** (`display:flex;gap:18px;min-width:0`):
    - Avatar: 60x60, `border-radius:17px;background:var(--accentSoft);color:var(--accentInk);…font-weight:800;font-size:22px;font-family:'Bricolage Grotesque'`. Text is the first two initials.
    - Info (`min-width:0`):
      - Name row (`display:flex;align-items:center;gap:10px;flex-wrap:wrap`):
        - Name: Bricolage 700 24px, -0.02em.
        - VIP badge: `font-size:11px;font-weight:800;padding:3px 9px;border-radius:7px;background:#7A3B8A;color:#fff;letter-spacing:0.04em`.
        - Member badge: 11px, `padding:3px 9px`, radius 7, uppercase, 0.03em.
        - Status badge.
      - `{{vehicleLine}} · Plate {{plate}}`: 13.5px, 600, ink2, `margin-top:5px`.
      - Meta row (`display:flex;align-items:center;gap:12px;margin-top:8px;flex-wrap:wrap`):
        - Clock icon (14x14: circle r9 stroke ink3, hands `M12 7v5l3 2`) plus `{{sel.when}}` (13px, 700). Format: `(Today | Tomorrow) <time> · <service up to ' + '>`.
        - Phone: 13px, 700, ink2.
        - "WhatsApp opted-in": 12px, 700, `#1FA855`, with a 7x7 `#25D366` dot.
  - **Right buttons** (`display:flex;gap:9px;flex:none`):
    - "Message": `display:flex;align-items:center;gap:7px;height:44px;padding:0 16px;background:var(--accentSoft);color:var(--accentInk);border-radius:12px;font-weight:700;font-size:13.5px`, speech-bubble icon (16x16).
    - Close: 44x44, `background:var(--panel2);border:1px solid var(--line);border-radius:12px;color:var(--ink2)`, X icon (`M6 6l12 12M18 6L6 18`, 18x18, 2.2).
- **Stage tracker:** `display:flex;align-items:center;gap:0;margin-top:20px;padding:14px 16px;background:var(--panel2);border:1px solid var(--line);border-radius:14px;overflow-x:auto;`.
  - Five stages: Booked, Confirmed, Arrived, In Wash, Done (mapped from `booked`, `confirmed`, `arrived`, `cleaning`, `completed`).
  - Each stage is `display:flex;align-items:center;flex:none`, containing a 74px-wide column (`display:flex;flex-direction:column;align-items:center;gap:6px`) and a connector.
  - Dot (computed): 30x30, round, `font-weight:800;font-size:12px`.
    - Done: `background:var(--accentSoft);color:var(--accentInk)`, mark "✓".
    - Current: `background:var(--accent);color:#fff;border:2px solid var(--accent)`, number mark.
    - Future: `background:var(--panel3);color:var(--ink3)`, number mark (1 to 5).
  - Label: 10.5px, 700, centered; ink if current or done, ink3 otherwise.
  - Connector: `width:18px;height:2px`. Colour is accent for completed segments (index < current), line for the others, and `transparent` after the last stage.
  - The hint-placeholder count of 9 is only the editor's layout hint. The real count is 5.

#### 3.6.2 Body
Layout: `flex:1;display:flex;min-height:0`.

**Tab rail:** `flex:none;width:206px;padding:18px 14px;border-right:1px solid var(--line);background:var(--panel);display:flex;flex-direction:column;gap:4px;overflow-y:auto;`.
- Tabs, in order: Overview, Checklist (count `done/total`), Add-ons (count = add-on count, hidden if 0), Photos, Messages (count = message count), Payments, Membership, History.
- Tab button (computed): `display:flex;align-items:center;gap:11px;height:44px;padding:0 14px;border-radius:12px;font-size:14px;font-weight:700`.
  - Active: `background:var(--accentSoft);color:var(--accentInk)`.
  - Inactive: `background:transparent;color:var(--ink2)`.
- Layout: 18x18 icon span, label (`flex:1;text-align:left`), then the optional count chip (`min-width:20px;height:20px;padding:0 6px;border-radius:7px;font-size:11px;font-weight:800`; active: `var(--accent)` with `#fff`; inactive: `var(--panel3)` with `var(--ink3)`).
- Tab icons (all 18x18):
  - overview: four rects (3,3), (13,3), (3,13), (13,13), each 8x8 rx1.5.
  - checklist: `M4 6l2 2 3-3M4 13l2 2 3-3M4 20l2 2 3-3M13 6h7M13 13h7M13 20h7`.
  - addons: plus `M12 5v14M5 12h14`.
  - photos: rect `x3 y6 w18 h14 rx2`, circle r3, `M8 6l1.5-2h5L16 6`.
  - messages: `M4 5h16v11H8l-4 4z`.
  - payments: rect `x3 y6 w18 h12 rx2` plus `M3 10h18`.
  - membership: star `M12 3l2.5 5 5.5.8-4 3.9.9 5.5L12 16.5 7.1 21l.9-5.5-4-3.9 5.5-.8z`.
  - history: `M3 12a9 9 0 109-9 9 9 0 00-7 3.3M3 4v3h3` plus `M12 8v4l3 2`.

**Tab content area:** `flex:1;overflow-y:auto;padding:24px 28px;min-width:0;`. Only one tab renders at a time.

**Overview tab** (2-col grid, `gap:16px`; cards are `background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:18px`):
- Section label (all cards): 11px, 800, ink3, uppercase, 0.06em, `margin-bottom:14px`.
- **Vehicle card:**
  - Label "Vehicle". Value: Bricolage 700 20px (`YYYY Make Model`).
  - Mini-grid (2 columns, `gap:12px;margin-top:16px`): label (11.5px, 700, ink3) over value (14px, 700, `margin-top:2px`). Fields in order: Color, Plate, Bay (`Bay N` or `Unassigned`), Worker.
- **Appointment card:**
  - Label "Appointment". Value: Bricolage 700 20px (service).
  - Fields: Time; "Est. duration" (`N min`); Payment (coloured by `payColor`; values "Paid in full", "Deposit · $X due", "$X due"); Membership (plan name or "Non-member").
- **Notes card** (`grid-column:1/3`, label "Notes & Special Instructions", `margin-bottom:12px`):
  - Notes text: 14px, 600, ink, lh 1.55. Default copy: "No special instructions on file."
  - If `special`: warning box `display:flex;gap:10px;margin-top:14px;padding:13px 15px;background:#FBEFD9;border:1px solid #F0D9A6;border-radius:12px`. It holds a "⚠" glyph (16px) and the text (13.5px, 700, `#8A5A12`, lh 1.45).

**Checklist tab:**
- **Header row:** `display:flex;align-items:center;justify-content:space-between;gap:14px;margin-bottom:8px`.
  - **Progress ring:** 54x54, `border-radius:50%`, `background:conic-gradient(var(--accent) {{checkPct}},var(--panel3) 0)`. An inner disc 42x42, round, `background:var(--bg2)`, shows `{{checkPctLabel}}` in 800 13px.
  - **Title:** "Service Checklist" (Bricolage 700 19px). Below it: `N of M tasks complete` (13px, 600, ink2, `margin-top:2px`).
  - **Check-all button** (computed): `height:46px;padding:0 20px;border-radius:12px;font-weight:800;font-size:14px;flex:none`.
    - Not all done: `background:var(--accent);color:#fff;border:1px solid var(--accent)`; label "Check all".
    - All done: `background:var(--panel2);color:var(--ink2);border:1px solid var(--line)`; label "Clear all".
- **Hint row:** `display:flex;align-items:center;gap:8px;margin-bottom:18px;font-size:12.5px;font-weight:600;color:var(--ink3)`. It has a 14x14 refresh icon (`M4 12a8 8 0 0114-5.3M20 12a8 8 0 01-14 5.3M18 3v4h-4M6 21v-4h4`, stroke currentColor 2). Copy: "Built from the package + selected add-ons. Adding or removing an add-on updates this list."
- **Sections** (`margin-bottom:20px` each; one for the package, then one per add-on):
  - Header row: `display:flex;align-items:center;gap:10px;margin-bottom:10px`.
    - Kind chip (computed): `font-size:10.5px;font-weight:800;padding:4px 8px;border-radius:6px;text-transform:uppercase;letter-spacing:0.04em;flex:none`. "Package": accentSoft with accentInk. "Add-on": `hexA('#B07908', .14|.22)` with `#8A5A06` (dark `lighten('#B07908')`).
    - Title: 800 14.5px, `flex:1`.
    - Count: `d / n`, 12px, 800, ink3.
    - Per-section toggle: `height:36px;padding:0 13px;border-radius:10px;background:var(--panel);border:1px solid var(--line);font-weight:700;font-size:12.5px;color:var(--ink2)`. Label "Check all" or "Clear".
  - Items grid: `display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:8px`.
    - Row button (computed): `display:flex;align-items:center;gap:13px;width:100%;min-height:52px;text-align:left;padding:12px 15px;border-radius:12px`.
      - Done: `background:var(--accentSoft);border:1px solid var(--accentBrd)`.
      - Not done: `background:var(--panel);border:1px solid var(--line)`.
    - Checkbox: 24x24, `border-radius:7px;flex:none`. Done: `background:var(--accent)` with a `#fff` check (15x15, `M5 12.5l4.5 4.5L19 7`, stroke 2.6). Not done: `background:transparent;border:2px solid var(--ink3)`.
    - Label: 14px, 600. Done: ink2 with `text-decoration:line-through`. Not done: ink.
- **Package task lists** have the "inspection" tasks filtered out at load time (any item matching `/inspection/i`), so "Final inspection" never appears.

**Add-ons tab:**
- Header row: flex, space-between, `margin-bottom:16px`.
  - "Add-on Services" (Bricolage 700 19px) and "Tap to add — invoice and checklist update instantly" (13px, 600, ink2, `margin-top:2px`).
  - Right-aligned: "Add-ons total" (11.5px, 700, ink3, uppercase) over `{{addonTotal}}` (Bricolage 700 22px, accentInk).
- Grid: `display:grid;grid-template-columns:1fr 1fr;gap:10px`.
  - Row (computed): `display:flex;align-items:center;justify-content:space-between;padding:13px 15px;border-radius:12px`. On: `background:var(--accentSoft);border:1px solid var(--accentBrd)`. Off: `background:var(--panel);border:1px solid var(--line)`.
  - Checkbox: 22x22, `border-radius:7px`. On: accent with a check (13x13, stroke 2.8). Off: `border:2px solid var(--ink3)`.
  - Name: 700 14px. Price: 800 14px, ink2.
- Catalog of 10 add-ons (see Appendix A).

**Photos tab:**
- Title "Photos & Documentation" (Bricolage 700 19px, `margin-bottom:4px`). Sub: "Capture arrival condition, before/after, and any damage notes" (13px, 600, ink2, `margin-bottom:18px`).
- Four sections (`margin-bottom:20px`): "Arrival", "Before", "After", "Damage / Issues".
  - Header: title (700 14.5px), then `· N photos` (ink3, 700), or `· N notes` for Damage / Issues.
  - Tag chip (`tagS`): `font-size:11px;font-weight:800;padding:3px 9px;border-radius:7px;background:hexA(c,.13|.2);color:c|lighten;text-transform:uppercase;letter-spacing:0.03em`.
    - Arrival: "Captured" in `#0E9E6E`.
    - Before and After: "Captured" in `#0E9E6E`, or "Pending" in `#6B7280`.
    - Damage / Issues: "Flagged" in `#C2410C`, or "None" in `#6B7280`.
  - Grid: `repeat(4,1fr)`, `gap:10px`, with up to 3 filled slots plus one add slot.
    - Filled slot: `aspect-ratio:4/3;border-radius:11px;background:var(--panel3);border:1px solid var(--line)`, with a camera icon (26x26: rect `x3 y6 w18 h14 rx2`, circle r3, stroke ink3 1.8).
    - Add slot: `aspect-ratio:4/3;border-radius:11px;background:var(--panel);border:1.5px dashed var(--line);cursor:pointer`, with a plus icon (22x22, `M12 7v10M7 12h10`, stroke ink3 2).
    - Slot logic: `slots(n)` shows `min(n,3)` photo slots, followed by one add slot if n < 3. Because the loop stops at 3, only 3 slots ever render when n ≥ 3, and the 4th grid cell is never used.
  - There is no actual photo content, and the add slot has no handler.

**Messages tab** (`display:flex;flex-direction:column;height:100%;min-height:0`):
- "Conversation" (Bricolage 700 19px, `margin-bottom:14px`).
- Message list: `flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:12px;padding-right:4px`.
  - Row: `display:flex;justify-content:flex-end` (staff or system) or `flex-start` (customer).
  - Bubble (computed): `max-width:78%;padding:11px 14px`.
    - System: `background:var(--accentSoft);color:var(--accentInk);border:1px solid var(--line);border-radius:15px 15px 4px 15px`.
    - Staff: `background:var(--accent);color:#fff;border:none;border-radius:15px 15px 4px 15px`.
    - Customer: `background:var(--panel);color:var(--ink);border:1px solid var(--line);border-radius:15px 15px 15px 4px`. Not generated by any current code path.
  - Channel tag (system only): `Automated · <channel>`, 10px, 800, uppercase, 0.04em, `opacity:.7`, `margin-bottom:4px`. Shown whenever `channelTag` is truthy.
  - Text: 13.5px, 600, lh 1.45.
  - Time: 10.5px, 600, `margin-top:5px`, `opacity:.65`.
- **Composer area:** `flex:none;padding-top:14px;border-top:1px solid var(--line);margin-top:12px`.
  - Template pills row: `display:flex;gap:7px;overflow-x:auto;padding-bottom:10px`. Each pill: `flex:none;padding:8px 13px;background:var(--panel2);border:1px solid var(--line);border-radius:20px;font-size:12.5px;font-weight:700;color:var(--ink2);white-space:nowrap`.
  - Pill labels: "Confirmed", "We’re ready", "Checked in", "Being cleaned", "Ready for pickup", "Approve add-on?", "Payment link". Their texts are in the interaction map.
  - Input row (`display:flex;gap:10px`):
    - A static div `flex:1;height:48px;padding:0 16px;background:var(--panel);border:1px solid var(--line);border-radius:13px;font-size:13.5px;color:var(--ink3);font-weight:600`, text "Type a message…". It is not an input.
    - Send button: 48x48, `background:var(--accent);border-radius:13px`, paper-plane icon (20x20, `M4 12l16-7-7 16-2-7z`, stroke `#fff` 2). No handler.

**Payments tab:** 2-col grid `1.3fr 1fr`, `gap:16px`, `align-items:start`.
- **Invoice card:** `background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:20px`. Title "Invoice" (Bricolage 700 18px, `margin-bottom:16px`).
  - Rows (computed): `display:flex;justify-content:space-between;align-items:center;padding:8px 0`.
    - Total row: `padding:14px 0 6px;border-top:1px solid var(--line);margin-top:6px`.
  - Row types:
    - Package line: label = service name, value `$(sub - addon)`.
    - `+ <Add-on>` rows (label colour accentInk).
    - "Tip" (only if > 0).
    - "Tax (7%)".
    - "Total": label 800 15px, value Bricolage 800 18px.
    - "Deposit paid": value `– $X`, both green `#0E9E6E` (only when pay is deposit).
  - Other rows: label 13.5px, 600, ink2; value 14px, 700, ink.
- **Right column** (`display:flex;flex-direction:column;gap:14px`):
  - Status card (`payCardStyle`): `padding:20px;border-radius:16px`. Paid: `background:var(--accentSoft);color:var(--accentInk)`. Otherwise: `background:var(--ink);color:var(--bg)`.
    - Label: 12px, 800, uppercase, 0.05em, `opacity:.85`. Values: "Paid in full", "Balance due", "Awaiting payment".
    - Big amount: Bricolage 700 38px, `margin-top:6px`, -0.02em.
    - Method: 13px, 600, `margin-top:4px`, `opacity:.85`. Values: "Visa ···· 4421" (paid) or "No payment on file".
  - If `showCollect` (not paid):
    - "Send payment link": `height:52px;background:var(--panel);border:1px solid var(--line);border-radius:13px;font-weight:700;font-size:14px;color:var(--ink);display:flex;align-items:center;justify-content:center;gap:8px`, with a 17x17 external-link icon (`M9 15l6-6M10 7h6v6`).
    - `Mark Paid · {{payBig}}`: `height:56px;background:var(--accent);color:#fff;border-radius:13px;font-weight:800;font-size:15.5px;box-shadow:0 8px 20px var(--accentSoft)`.
  - If `isPaid`: `display:flex;align-items:center;gap:10px;padding:16px;background:var(--accentSoft);border-radius:13px`.
    - 36x36 accent circle with a white check (18x18).
    - "Payment complete" (800 14px, accentInk) and "Receipt sent via WhatsApp + email" (12px, 600, accentInk, `opacity:.8`).

**Membership tab:**
- **Member card** (if `member`; style `memberCardStyle`): `padding:24px;border-radius:18px;background:linear-gradient(135deg, <planTint>, rgba(<planTint>,.78));color:#fff;box-shadow:0 12px 30px rgba(<planTint>,.35)`.
  - Top row:
    - Left: caption `<Plan> Member` (12px, 800, uppercase, 0.06em, `opacity:.8`) over the name (Bricolage 700 26px, `margin-top:4px`).
    - Right: "Renews" (12px, 700, `opacity:.8`) over `{{renewDate}}` (800 15px). `renewDate` is the hard-coded "Jul 12, 2026".
  - Stats row (`display:flex;gap:24px;margin-top:22px`): three stats, each a Bricolage 700 30px numeral over a 12px, 700, `opacity:.8` label.
    - "Credits left" (`∞` for Executive and Exotic, else `1`).
    - "Used this cycle" (`1` for Premium, else `0`).
    - "Months active" (`8 + (visits % 6)`).
- **Lower grid** (`1fr 1fr`, `gap:14px`, `margin-top:16px`):
  - **Plan perks card:** same card chrome (radius 16, padding 18), label "Plan perks" (`margin-bottom:12px`). List `display:flex;flex-direction:column;gap:9px`; each item `display:flex;align-items:center;gap:9px;font-size:13.5px;font-weight:600` with an 18x18 round accentSoft badge holding an 11x11 check (stroke accentInk 3).
  - **Right column** (`gap:12px`):
    - Retention card: `padding:16px;border-radius:14px`. Loyal: `background:var(--accentSoft);color:var(--accentInk)`. Watch: `background:#FBEAE0;color:#C2410C`.
      - Caption "Retention" (12px, 800, uppercase, 0.05em).
      - Label (800 16px, `margin-top:4px`): "Loyal · low risk" or "Watch · 1 missed visit".
      - Desc (12.5px, 600, `margin-top:3px`, `opacity:.85`): "Consistent monthly usage — strong retention" or "Down from 3 to 1 visit last month".
      - Loyal is `visits > 6`.
    - "Recommend upgrade →": `height:50px;background:var(--accent);color:#fff;border-radius:13px;font-weight:700;font-size:14px`. No handler.
- **Perks lists** (verbatim):
  - Essential: "2 express washes / month", "Priority booking", "10% off add-ons", "Free vacuum anytime".
  - Premium: "2 premium washes / month", "Skip-the-line priority", "15% off all add-ons", "Monthly interior refresh", "Free rain repellent".
  - Executive: "Unlimited express washes", "2 executive details / month", "20% off add-ons", "Dedicated detailer", "Loaner coordination".
  - Exotic: "Unlimited hand washes", "Concierge pickup & delivery", "Paint protection reviews", "25% off all services", "Private appointment windows".
- **Non-member card** (`noMember`): `background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:36px;text-align:center`.
  - "Not a member yet": Bricolage 700 20px.
  - Body: `<Name> is a strong upgrade candidate — 4 visits in 60 days. Offer Essential at check-out.` (13.5px, 600, ink2, `margin:6px auto 0`, `max-width:380px`, lh 1.5). The "4 visits in 60 days" is hard-coded.
  - "Present membership offer" button: `margin-top:18px;height:50px;padding:0 24px;background:var(--accent);color:#fff;border-radius:13px;font-weight:700;font-size:14px`. No handler.

**History tab:**
- Header: flex, space-between, `margin-bottom:16px`. "Service History" (Bricolage 700 19px). Right group (`display:flex;gap:18px`) of three right-aligned stats, value 800 16px over label 11px, 700, ink3, uppercase: "Visits", "Lifetime" (`visits * 148` as dollars), "Avg cadence" (hard-coded "18 days").
- List: `display:flex;flex-direction:column;gap:10px`.
  - Row: `display:flex;align-items:center;gap:16px;padding:15px 18px;background:var(--panel);border:1px solid var(--line);border-radius:14px`.
    - Date box (`flex:none;width:46px;text-align:center`): day (800 15px) over month (11px, 700, ink3, uppercase).
    - Divider: `width:1px;height:34px;background:var(--line)`.
    - Body (`flex:1;min-width:0`): service (700 14.5px) over note (12.5px, 600, ink2, `margin-top:2px`).
    - Favourite pill (if `fav`): "★ Favorite" (`font-size:11px;font-weight:800;color:var(--accentInk);background:var(--accentSoft);padding:4px 9px;border-radius:7px`).
    - Amount: 800 15px.

#### 3.6.3 Action bar (modal footer)
- Style: `flex:none;display:flex;align-items:center;gap:14px;padding:16px 28px;background:var(--panel);border-top:1px solid var(--line);`.
- Left (`flex:1;min-width:0`): "Recommended next action" (11px, 700, ink3, uppercase, 0.05em) over `{{sel.nextHint}}` (800 15px, `margin-top:2px`).
- **"Message Customer":** `flex:none;height:54px;padding:0 20px;background:var(--panel2);border:1px solid var(--line);border-radius:14px;font-weight:700;font-size:14px;color:var(--ink)`. Switches to the Messages tab.
- **Primary** (if `hasNext`): `flex:none;height:54px;padding:0 30px;background:var(--accent);color:#fff;border-radius:14px;font-weight:800;font-size:16px;box-shadow:0 10px 24px var(--accentSoft)`. Label `{{nextLabel}}`.
- **Done state** (if `done`): `flex:none;height:54px;padding:0 26px;display:flex;align-items:center;gap:9px;background:var(--accentSoft);color:var(--accentInk);border-radius:14px;font-weight:800;font-size:15px`, a check icon (18x18, stroke 2.6) and "Job Complete".
- **Hints (`nextHint`)** by next step:
  - confirmed: "Customer hasn’t confirmed — send the reminder".
  - arrived: "Mark arrived once the customer pulls in".
  - cleaning: "Drag the card onto an open bay, or start the wash here".
  - completed: "Wash finished — mark complete and move it to pickup".
  - pay: `Collect $X before release`.
  - No next step: "Job complete — closed and archived".
  - Note that the keys are the destination state, so for a booked appointment the hint is the `confirmed` one.

### 3.7 New Appointment / Walk-in slide-over
Visible when `newOpen`.

**Scrim:** `position:fixed;inset:0;z-index:70;background:rgba(8,12,10,.5);backdrop-filter:blur(3px);display:flex;justify-content:flex-end;animation:oa-fade .18s ease;`. Click closes.

**Panel:** `width:520px;max-width:94vw;height:100%;background:var(--bg2);border-left:1px solid var(--line);box-shadow:var(--shadowLg);display:flex;flex-direction:column;animation:oa-slide .26s cubic-bezier(.2,.7,.3,1);`.
- **Header:** `flex:none;display:flex;align-items:center;justify-content:space-between;padding:22px 24px;border-bottom:1px solid var(--line);background:var(--panel)`.
  - Title `{{newTitle}}` (Bricolage 700 20px): "New Appointment" or "Walk-in Booking".
  - Sub: "Booked slots respect bay capacity" (13px, 600, ink2, `margin-top:2px`).
  - Close: 42x42, `background:var(--panel2);border:1px solid var(--line);border-radius:11px;color:var(--ink2)`, X icon (17x17).
- **Body:** `flex:1;overflow-y:auto;padding:22px 24px;display:flex;flex-direction:column;gap:18px`. Section labels are 11px, 800, ink3, uppercase, 0.06em, `margin-bottom:10px`.
  - **"Customer":** two non-interactive field divs.
    - Field style: `height:50px;display:flex;align-items:center;padding:0 15px;background:var(--panel);border:1px solid var(--line);border-radius:12px;font-size:14px;color:var(--ink3);font-weight:600`.
    - "Full name".
    - Row with "Phone number" (flex 1) plus a "WhatsApp" button: `flex:none;display:flex;align-items:center;gap:7px;padding:0 15px;background:var(--accentSoft);border:1px solid var(--accentBrd);border-radius:12px;font-weight:700;font-size:13px;color:var(--accentInk)`, with a 8x8 `#25D366` dot.
  - **"Vehicle":** 2-col grid with fields "Year / Make / Model" and "License plate".
  - **"Service package":** column of 5 buttons (the first five services: Express Hand Wash, Premium Hand Wash + Interior, Premium Hand Wash + Interior Refresh, Executive Detail, Executive Detail + Ceramic).
    - Button (computed): `display:flex;align-items:center;justify-content:space-between;padding:13px 15px;border-radius:12px`. Selected: `background:var(--accentSoft);border:1px solid var(--accentBrd)`. Else: `background:var(--panel);border:1px solid var(--line)`.
    - Left: name (700 14px) and `Est. N min` (12px, 600, ink2, `margin-top:1px`). Right: price (800 15px).
  - **"Available slots — bay-aware":** 4-col grid, `gap:8px`, with 8 buttons.
    - Slot times: "10:30 AM", "11:00 AM", "11:30 AM", "12:30 PM", "1:00 PM", "2:30 PM", "4:00 PM", "4:30 PM".
    - Blocked: 11:00 AM and 1:00 PM. Held for VIP: 11:30 AM and 12:30 PM (label becomes `<time> · VIP`).
    - Button (computed): `height:42px;border-radius:11px;font-size:13px;font-weight:700`.
      - Blocked: `cursor:not-allowed;background:var(--panel3);color:var(--ink3);opacity:.6;border:1px solid var(--line)`.
      - Selected: `background:var(--accent);color:#fff;border:1px solid var(--accent)`.
      - Default: `background:var(--panel);color:var(--ink);border:1px solid var(--line)`.
    - Legend: `display:flex;align-items:center;gap:8px;margin-top:12px;padding:11px 14px;background:var(--panel2);border:1px solid var(--line);border-radius:11px;font-size:12.5px;font-weight:600;color:var(--ink2)`, with an 8x8 `#E0A93B` dot. Copy: "Greyed slots would overbook a bay — manager override required".
- **Footer:** `flex:none;display:flex;gap:12px;padding:18px 24px;border-top:1px solid var(--line);background:var(--panel)`.
  - "Cancel": `flex:none;height:54px;padding:0 22px;background:var(--panel2);border:1px solid var(--line);border-radius:14px;font-weight:700;font-size:14px;color:var(--ink)`.
  - "Book Appointment": `flex:1;height:54px;background:var(--accent);color:#fff;border-radius:14px;font-weight:800;font-size:16px;box-shadow:0 8px 20px var(--accentSoft)`.
- **Prototype limitations:** all text fields are static divs (no inputs, no validation, no state). "Book Appointment" only closes the panel and toasts.

### 3.8 Drag ghost
Rendered when `dragging`.
- Style: `position:fixed;left:0;top:0;z-index:95;pointer-events:none;width:280px;padding:13px 15px;background:var(--panel);border:2px solid var(--accent);border-radius:15px;box-shadow:var(--shadowLg);transform:translate(-9999px,-9999px);`.
- Placement is set by script: `translate(x-140px, y-36px) rotate(-2deg)`.
- Content:
  - Name: 800 14.5px.
  - Vehicle: `YYYY Make Model`, 12.5px, 600, ink2, `margin-top:2px`.
  - Hint: 11px, 800, accentInk, uppercase, 0.05em, `margin-top:9px`. Copy: "Drop on an open bay" (timeline and queue) or "Drop on a new time" (calendar).

### 3.9 Toast
Rendered when `toast` is truthy.
- Style: `position:fixed;bottom:26px;left:50%;transform:translateX(-50%);z-index:90;display:flex;align-items:center;gap:12px;padding:14px 20px;background:var(--ink);color:var(--bg);border-radius:14px;box-shadow:var(--shadowLg);animation:oa-rise .22s ease;max-width:90vw;`.
  - The toast inverts the theme (ink as background, bg as text).
  - Because the `oa-rise` keyframe ends at `transform:none`, the animation's fill state is not retained after it ends, so `translateX(-50%)` from the inline style takes over. During the animation `transform` is overridden by the keyframe, so the toast briefly jumps horizontally.
- Icon tile: 30x30, `border-radius:9px;background:var(--accent)`, speech-bubble icon (16x16, stroke `#fff` 2). The same icon is used for every toast.
- Title: 800 13.5px. Description: 12.5px, 600, `opacity:.8`.
- Lifetime: 3200ms, then cleared. A new toast resets the timer.
- There is no dismiss button.

### 3.10 Branding badge
Injected `#__claude_design_branding`: fixed bottom-right pill ("Made with Claude Design") that is part of the prototype export, not the product. It should not be reproduced.

---

## 4. Interaction map

### 4.1 Pointer handlers by element

| Element | Event → handler | Behaviour |
|---|---|---|
| Search input | `input` → `onSearch` | Sets `search`. Filters timeline, bay, staff and completed lists on a case-insensitive substring match against `name`, `phone`, `make`, `model`, `color`, `plate`, `service`. KPIs ignore it. |
| New Appointment | `click` → `openNew` | `newOpen:true`, `newTitle:'New Appointment'` |
| Walk-in | `click` → `openWalkin` | `newOpen:true`, `newTitle:'Walk-in Booking'` |
| Theme toggle | `click` → `toggleTheme` | Flips theme, writes `localStorage['oasis-theme']` |
| View tabs | `click` | `view = timeline / bay / staff / calendar` |
| Range tabs | `click` | `range = next24 / today / tomorrow / week` (only `today` and `tomorrow` actually filter; `next24` and `week` show everything) |
| Timeline card | `click` → `open` | `openAppt(a)` (ignored within 450ms of a gesture, see `_sup`) |
| Timeline card | `pointerdown` → `onPointerDown` | `gStart(e,a,'tl')` |
| Timeline card | `contextmenu` → `preventCtx` | `preventDefault` |
| Arrival "Prep Bay" | `click` | `prepBay` |
| Arrival "Simulate arrival" | `click` | `simArrive` |
| Bay card | `data-drop="bay:N"` | Drop target |
| Bay "Mark Complete" (primary) | `click` → `doNext` | `advance(occ.id)` |
| Bay "Open File" / vehicle block | `click` → `open` | Opens modal on Overview |
| Free bay "Assign next vehicle" | `click` → `assign` | Opens the next queued appointment for that bay (first non-in-bay, non-completed appointment with `bay===N`). If none, toasts "Nothing queued" / "No vehicles waiting for Bay N". It does not assign the bay. |
| Completed card | `click` → `open` | Opens modal |
| Pay chip | `click` → `togglePay` | Toggles paid and unpaid |
| Pickup chip | `click` → `togglePickup` | Toggles collected and pending |
| Queue card | `pointerdown` → `onQDown` | `gStart(e,a,'q')` |
| Alert action | `click` → `action` | Per-alert function (see 3.3) |
| Alert "Open" | `click` → `open` | Opens modal at Overview if an id exists |
| Staff job | `click` → `open` | Opens modal |
| Calendar Prev / Next | `click` | `calNav(-1 / +1)` |
| Calendar Today | `click` | `calOffset:0` |
| Calendar mode buttons | `click` | `calMode = day / week / month` |
| Week or month cell | `click` | `calMode:'day'`, `calOffset = that day's offset` |
| Calendar body | `pointerdown` / `pointerup` | Swipe (see 4.4) |
| Calendar chip | `click`, `pointerdown` (`onCalDown`, ctx `cal`), `contextmenu` | Open, or drag to reschedule |
| Day row | `data-drop="hr:H"` | Drop target for reschedule |
| Modal scrim | `click` → `closeModal` | `selectedId:null` |
| Modal dialog | `click` → `stop` | `stopPropagation` |
| Modal header "Message" and footer "Message Customer" | `click` → `quickMsg` | `modalTab:'messages'` |
| Modal close | `click` | `closeModal` |
| Modal tab | `click` | `modalTab = k` |
| Checklist "Check all / Clear all" | `click` → `checkAllToggle` | Sets or clears every task |
| Checklist section toggle | `click` | Sets or clears that section (quiet, no toast) |
| Checklist row | `click` | `toggleCheckKey` |
| Add-on row | `click` | `toggleAddon` (toast: "Invoice + checklist updated" / `Added|Removed <name>`) |
| Template pill | `click` → `send` | `sendTemplate(id,text)` |
| "Send payment link" | `click` | Toast only (no state change) |
| "Mark Paid · $X" | `click` → `collect` | Sets `pay='paid'` |
| Footer primary | `click` → `doNext` | `advance(id)` |
| New-appointment service rows | `click` | `pickedService` |
| New-appointment slots | `click` | Select, or toast for blocked and VIP slots (see 4.2) |
| "Book Appointment" | `click` → `createAppt` | Closes and toasts "Appointment booked" / `<service> · <slot>` |
| Scrim / Cancel / X (new) | `click` → `closeNew` | `newOpen:false` |

Elements with no handler in this design:
- Bell button, role chip, "Recommend upgrade →", "Present membership offer", the Messages send button and "Type a message…", the photo add slots, the new-appointment inputs, and the new-appointment "WhatsApp" button.

### 4.2 Keyboard (global `keydown` on `window`)
- **Typing guard:** if the target is an `INPUT` or `TEXTAREA`, only `Escape` is handled (it blurs the field). Everything else is ignored.
- `Escape`: `selectedId:null` and `newOpen:false`.
- `/`: `preventDefault` and focus `#oa-search`.
- `n` (case-insensitive): opens the new-appointment panel. The title is not reset, so a previously set "Walk-in Booking" title would persist.
- In Calendar view with no modal open:
  - `ArrowLeft` / `ArrowRight`: `calNav(-1 / +1)`.
  - `t`: `calOffset:0`.
- With a modal open (`selectedId` set):
  - `m`: toast "Message composer opened" / `WhatsApp to <name>`. It does not switch tabs.
  - `p`: `modalTab:'payments'`.
  - `s` or `r`: `advance(sel)`.
- Modifier keys are not checked, so Ctrl or Cmd combos also trigger these.

### 4.3 Gesture engine (`gStart` / `_gm` / `_gu` / `_gc` / `gEnd`)
- **Start (`gStart`):**
  - Ignores `button > 0`.
  - Resets any previous gesture.
  - Records `{id, a, ctx, x0, y0, x, y, touch (pointerType !== 'mouse'), el, mode:null, can:canDrag(a)}`.
  - Touch plus `can`: starts a **380ms** long-press timer that begins a drag if the gesture is still undecided.
  - Adds `pointermove`, `pointerup` and `pointercancel` listeners on `window`.
- **`canDrag(a)`:** not in a bay (`status !== 'cleaning'`) and `status !== 'completed'`.
- **Move, mouse:** if `can` and movement > **6px** (`Math.hypot`), begin drag.
- **Move, touch (before a mode is chosen):**
  - Horizontal intent: `|dx| > 12` and `|dx| > |dy| * 1.4`. This cancels the long-press timer. Context `tl` enters swipe mode. Any other context ends the gesture, so native horizontal scroll takes over for Up Next.
  - Otherwise, any movement > 12px ends the gesture, which cancels the long-press and leaves native scroll.
- **Drag mode:**
  - `beginDrag`: sets `mode='drag'`, `document.body.style.userSelect='none'`, and calls `navigator.vibrate(12)` where supported.
  - Sets state `dragId`, `dropTarget:null` and `ghost` (name, `YYYY Make Model`, hint text).
  - Each move calls `moveGhost()` (translate `(x-140, y-36)` and `rotate(-2deg)`) and `hoverTarget()`, which uses `document.elementFromPoint(x,y).closest('[data-drop]')` to read the `data-drop` value into `dropTarget`.
  - On pointer-up: sets `_sup` (suppress click for 450ms), ends the gesture, and if a `dropTarget` exists calls `dropOn`.
  - `bay:N` calls `assignToBay(id,N)`. `hr:H` calls `reschedule(appt,H)`.
  - Dropping outside any target does nothing.
- **Swipe mode** (timeline cards only, touch only):
  - On each move: `g.el.style.transition='none'` and `transform=translateX(clamp(dx,-150,150)px)`.
  - On pointer-up: sets `_sup`, snaps back with `transition:transform .22s ease` and `transform:''`.
    - `dx > 90`: `advance(id)`.
    - `dx < -90`: opens the modal on the Messages tab.
    - Otherwise nothing.
  - `pointercancel` snaps back without any action.
- **Mouse swipe is not supported.** The swipe affordance is touch-only; a mouse drag on a timeline card starts a bay drag instead.
- **`touchmove` guard:** a non-passive `touchmove` listener on `document` calls `preventDefault` whenever a gesture mode is active, so the page does not scroll while dragging or swiping.
- **Context menu suppression:** timeline cards, queue cards and calendar chips suppress the browser context menu (`preventDefault`), to stop the long-press callout.
- **Click suppression:** `openAppt` returns early if `Date.now() - _sup < 450`.
- **Drop outcomes:**
  - `assignToBay`:
    - Appointment already in a bay: toast "Already in a bay" / `That vehicle is in Bay N`.
    - Target bay occupied: toast `Bay N is busy` / `Finish <First>’s vehicle first`.
    - Otherwise sets `bay=N`, `status='cleaning'`, `startedAt=now`, appends a log entry and a WhatsApp message, and toasts `Moved to Bay N` / `<Name> · cleaning started`.
  - `reschedule(a,hr)`:
    - If `!canDrag`: toast "Can’t move this job" / "It’s already in progress or done".
    - Otherwise the new time keeps the original minutes: `fmtT(hr*60 + parseT(time)%60)`. If unchanged, nothing happens.
    - It materializes a generated appointment into `calAppts`, sets `time` and `late:false`, adds a WhatsApp message "Your appointment has been moved to <time>. Reply if that doesn’t work." and a log line "Rescheduled to <time>", and toasts `Moved to <time>` / `<Name> notified via WhatsApp`.

### 4.4 Calendar swipe
- Pointer-down on the calendar body records `{x,y,t}` unless `pointerType==='mouse'`.
- Pointer-up navigates if all of these hold:
  - A gesture start was recorded and the gesture engine is not in drag mode.
  - `|dx| > 70`.
  - `|dx| > |dy| * 1.5`.
  - `Date.now() - t < 800`.
- The direction is `dx < 0` for next and otherwise previous.
- It sets `_sup` so a following click does not open a chip.
- `calNav`: day ±1 day; week ±7 days; month moves to the 1st of the target month.

### 4.5 State transitions (`advance` and friends)
- **`nextStep`:**
  - booked → "Confirm Appointment" (to confirmed)
  - confirmed → "Mark Arrived" (to arrived)
  - arrived → "Start Cleaning" (to cleaning)
  - cleaning → "Mark Complete" (to completed)
  - completed with balance > 0 → "Collect Payment" (to pay)
  - otherwise null
- **`advance(id)`** applies the step and appends a log line and message. Toast labels:
  - confirmed: "Confirmation sent" / "Reminder via WhatsApp".
  - arrived: "Marked arrived" / "Internal team notified".
  - cleaning: "Cleaning started" / "In-progress message sent".
  - completed: "Job completed" / "Ready-for-pickup sent · moved to pickup".
  - pay: "Payment collected" / "Receipt sent".
- **Other toast strings:**
  - "Checked in automatically" / `<Name> · welcome message sent`.
  - `Bay N prepped` / `(VIP )<Name> arrives in N min`.
  - "All tasks checked" / "Checklist cleared", with `N tasks marked done` or `N tasks reset`.
  - "Message sent" / "Delivered via WhatsApp".
  - "Customer notified" / "Ready-for-pickup sent via WhatsApp".
  - "Payment link sent" / "Secure link via WhatsApp".
  - "Reminder sent" / `WhatsApp to <name>`.
  - "Bay prepped" / `Ready for <name>`.
  - "Credit applied" / "1 Premium credit redeemed".
  - "Slot unavailable" / "Would overbook a bay — override required".
  - "Held for VIP clients" / "Releases to everyone 48h before · VIP clients can book it now".
  - "Marked unpaid" / "Balance reopened"; "Payment collected" / "Receipt sent to customer".
  - "Pickup reopened" / "Back to ready for pickup"; "Vehicle picked up" / `Released to <First>`.
- **Message templates** (label → text):
  - Confirmed → "Your appointment is confirmed. See you soon!"
  - We’re ready → "We’re ready for you — come on in!"
  - Checked in → "Your vehicle has been checked in."
  - Being cleaned → "Your vehicle is now being cleaned."
  - Ready for pickup → "Your vehicle is ready for pickup!"
  - Approve add-on? → "We recommend an add-on — would you like to approve it?"
  - Payment link → "Here is your secure payment link."
- **Timers:**
  - A 1-second `setInterval` bumps `tick` and re-renders (drives the bay timers, progress bars and the live clock).
  - The toast uses a 3200ms timeout.
  - Everything is client-state-only, with no persistence apart from the localStorage keys in Appendix B.

---

## 5. Overlays & motion

| Overlay | Mount | Position and structure | Scrim | Entry animation | Exit |
|---|---|---|---|---|---|
| Client-file modal | `modalOpen` | Fixed full-viewport flex centre, `padding:36px`. Dialog `max 1120x880`, filling available height. z 60. | `rgba(8,12,10,.55)` + `blur(4px)`, click to close | Scrim `oa-fade .18s ease`; dialog `oa-rise .24s cubic-bezier(.2,.7,.3,1)` | Instant unmount |
| New-appointment slide-over | `newOpen` | Fixed full-viewport flex, right-aligned. Panel width 520px, `max-width:94vw`, full height. z 70. | `rgba(8,12,10,.5)` + `blur(3px)`, click to close | Scrim `oa-fade .18s ease`; panel `oa-slide .26s cubic-bezier(.2,.7,.3,1)` | Instant unmount |
| Toast | `toast` | Fixed, bottom 26px, centred via `translateX(-50%)`. z 90. `max-width:90vw`. | None | `oa-rise .22s ease` | Instant unmount after 3.2s |
| Drag ghost | `dragging` | Fixed at 0,0, moved by transform. `pointer-events:none`. z 95. | None | None | Removed when the gesture ends |
| Emergency banner | `emergencyOn` | In flow between header and KPI | None | None | n/a |

- The modal (z 60) sits below the slide-over (z 70) and the toast (z 90). The toast remains visible above either overlay.
- When both could be open (the `n` key does not close the modal), the slide-over covers the modal.
- Ongoing motion: the progress fill width transitions linearly over 1s per tick, and the ghost carries `rotate(-2deg)`.

---

## 6. View-model contract (bindings consumed by markup)

Notes:
- `style` objects (`*Style`, `style`) are computed client-side. In a Next.js port they should be derived from semantic fields (status, theme, selection) rather than shipped from the API.
- Fields marked `*` should be API-provided or derived from API data.

### 6.1 Global
- `theme`*, `isDark`, `isLight`, `toggleTheme`.
- `emergencyOn`*, `emergencyText`* (from `emergency.active` and `emergency.summary`).
- `search`, `onSearch`.
- `openNew`, `openWalkin`.
- `showRange`, `rangeTabs[]{label,onClick,style}`.
- `viewTabs[]{label,icon,onClick,style}`.
- `isTimeline`, `isBay`, `isStaff`, `isCalendar`.
- `clockLabel` (live clock), `dateLabel` (hard-coded in the prototype; should be the real date).
- `preventCtx`, `stop`.

### 6.2 KPI strip
- `kpis[]{label, value, sub, accent}` (7 items).

### 6.3 Timeline view
- `apptCount`.
- `groups[]{dividerStyle, dividerLabel, time, ampm, items[]}`.
- `groups[].items[]` (card VM, `a.*`): `open`, `onPointerDown`, `cardStyle`, `railStyle`, `name`, `vip`, `member`, `memberStyle`, `memberLabel`, `vehicleLine`, `badgeStyle`, `badgeLabel`, `service`, `bayLabel`, `durLabel`, `payStyle`, `payLabel`, `iconWrap`, `hasNotes`, `hasPhotos`, `hasAddons`, `addonCount`, `nextStyle`, `nextColor`, `nextLabel`.

### 6.4 Active Bays
- `inFacilityLabel`.
- `arrivals[]{style, dot, title, desc, prep, prepStyle, prepLabel, arrive}`.
- `bays[]`:
  - Common: `name`, `drop`, `shellStyle`, `tagStyle`, `occupied`, `free`.
  - Occupied: `badgeStyle`, `badgeLabel`, `worker`, `workerInitials`, `open`, `vehicle`, `customer`, `plate`, `statusColor`, `service`, `showProgress`, `elapsed`, `eta`, `progressStyle`, `progressLabel`, `durLabel`, `doNext`, `primaryStyle`, `nextLabel`.
  - Free: `dropZoneStyle`, `nextUp`, `assign`.

### 6.5 Ready & Completed
- `completedCount`, `noCompleted`.
- `completedJobs[]{shellStyle, accent, open, name, time, vehicleLine, service, togglePay, payChipStyle, payChipLabel, togglePickup, pickupChipStyle, pickupChipLabel}`.

### 6.6 Bay Board
- `bays[]` (the same shape as 6.4, but with different markup).
- `queue[]` (card VM): `open`, `onQDown`, `time`, `badgeStyle`, `badgeLabel`, `name`, `vip`, `vehicleLine`, `service`, `bayLabel`.
- `alerts[]{shellStyle, iconStyle, glyph, title, desc, action, actionStyle, actionLabel, open}`. `alertCount` is exposed but unused.

### 6.7 Staff
- `staffCols[]{avatarStyle, initials, name, role, count, jobs[], empty}`.
- `jobs[]` (card VM): `open`, `statusColor`, `time`, `badgeStyle`, `badgeLabel`, `name`, `vehicleLine`, `service`.

### 6.8 Calendar
- `calPrev`, `calToday`, `calNext`, `calLabel`, `calSub`, `calHint`.
- `calModes[]{onClick, style, label}`.
- `calSwipeStart`, `calSwipeEnd`.
- `calIsWeek`, `calIsMonth`, `calIsDay`.
- `calWeek[]{onClick, style, dow, isToday, num, open, count, countLabel, closed, reason}`.
- `calDow[]`.
- `calMonth[]{onClick, style, numStyle, num, showCount, pillStyle, countLabel, closed, reason}`.
- `calClosed`, `calClosedReason`.
- `calRows[]{drop, rowStyle, time, ampm, items[], empty}`.
- `calRows[].items[]` (card VM): `open`, `onCalDown`, `chipStyle`, `statusColor`, `name`, `vip`, `short`, `badgeStyle`, `badgeLabel`.

### 6.9 Modal (`sel`)
- **Gate and chrome:** `modalOpen`, `closeModal`, `sel.*`.
- **Header:** `initials`, `name`, `vip`, `member`, `memberStyle`, `memberLabel`, `badgeStyle`, `badgeLabel`, `vehicleLine`, `plate`, `when`, `phone`, `quickMsg`, `stages[]{dotStyle, mark, labelStyle, label, lineStyle}`.
- **Tabs:** `tabs[]{onClick, style, icon, label, count, countStyle}`; `tabOverview`, `tabChecklist`, `tabAddons`, `tabPhotos`, `tabMessages`, `tabPayments`, `tabMembership`, `tabHistory`.
- **Overview:** `vehicle`, `color`, `plate`, `bayLabel`, `worker`, `service`, `time`, `durLabel`, `payColor`, `payLabel`, `memberPlain`, `notes`, `special`.
- **Checklist:** `checkPct`, `checkPctLabel`, `checkDone`, `checkTotal`, `checkAllToggle`, `checkAllStyle`, `checkAllLabel`, `checkSections[]{kindStyle, kind, title, countLabel, toggle, btnLabel, items[]{toggle, rowStyle, boxStyle, done, labelStyle, label}}`.
- **Add-ons:** `addonTotal`, `addonCatalog[]{toggle, rowStyle, boxStyle, on, name, price}`.
- **Photos:** `photoSections[]{title, count, tagStyle, tag, slots[]{style, add, icon}}`.
- **Messages:** `messages[]{rowStyle, bubbleStyle, channelTag, tagStyle, text, timeStyle, time}`, `templates[]{send, label}`.
- **Payments:** `payRows[]{style, labelStyle, label, valStyle, val}`, `payCardStyle`, `payStatusLabel`, `payBig`, `payMethod`, `showCollect`, `sendLink`, `collect`, `isPaid`.
- **Membership:** `noMember`, `memberCardStyle`, `renewDate`, `creditsLeft`, `creditsUsed`, `memberMonths`, `perks[]`, `riskStyle`, `riskLabel`, `riskDesc`.
- **History:** `visitCount`, `lifetimeSpend`, `avgFreq`, `history[]{day, mon, service, note, fav, amount}`.
- **Action bar:** `nextHint`, `quickMsg`, `hasNext`, `doNext`, `nextLabel`, `done`.

### 6.10 New appointment
- `newOpen`, `newTitle`, `closeNew`, `createAppt`.
- `newServices[]{pick, style, name, dur, price}`.
- `newSlots[]{pick, style, label}`.

### 6.11 Overlays
- `dragging`, `ghostRef`, `ghostName`, `ghostVehicle`, `ghostHint`.
- `toast`, `toastTitle`, `toastDesc`.

---

## 7. Fidelity risks

1. **Computed inline styles.** Most visual state (status colours, selected states, drag-over states) is generated in script and carries per-theme maths (`hexA` alpha .12 vs .18, `lighten` 45%). Reproduce these exact formulas, not approximated tokens. A Tailwind or token approach needs custom alpha and lighten handling.
2. **Dark-mode exceptions.** These are fixed light colours in both themes (they will look off in dark if "fixed"): the warning box (`#FBEFD9` / `#F0D9A6` / `#8A5A12`), the retention "watch" card (`#FBEAE0` / `#C2410C`), the membership badge default background, the "WhatsApp" green, the notification dot, the swipe-underlay `#2C6E8F`, and the emergency banner. Keep them as-is unless the other design files say otherwise.
3. **Swipe underlay.** A gradient layer sits at `inset:1px` behind an opaque card. It is only revealed through the card's `translateX`. The card is `position:relative;z-index:1`, and the wrapper is `border-radius:15px` with no `overflow:hidden`. It needs `touch-action:pan-y` on the card.
4. **Pointer-event tricks.**
   - Drag uses `window`-level pointer listeners, `elementFromPoint` hit testing against `[data-drop]`, a `pointer-events:none` ghost, and `document.body.style.userSelect='none'`.
   - A non-passive `touchmove` on `document` is needed for iOS.
   - Click suppression uses a 450ms timestamp.
   - `navigator.vibrate(12)` on drag start.
   - Reproduce the thresholds exactly: 380ms long-press, 6px mouse drag threshold, 12px and 1.4 ratio for touch intent, 90px swipe commit, ±150px clamp, 70px, 1.5 ratio and 800ms for the calendar swipe.
5. **`touch-action` values.** Timeline cards and calendar chips use `pan-y`, queue cards use `pan-x`, and week and month cells use `manipulation`. The calendar body uses `pan-y`. Changing these breaks scrolling versus gestures.
6. **Drop-target busy cue.** Occupied bays show a dashed `#C2410C` outline during a drag. Free bays show an accent border and a dashed accent drop zone. Calendar rows show a dashed accent outline with a soft background.
7. **Fonts.**
   - Bricolage 500 to 800 and Manrope 400 to 800 are embedded as woff2 subsets.
   - Weight 800 is used heavily; Manrope must include 800.
   - `font-feature-settings:'tnum'` is global and affects all numerals (timers, prices).
   - Root `letter-spacing:-0.01em` is overridden in places.
   - The Bricolage `font-stretch:100%` axis is fixed.
8. **SVG icons are inline** with `currentColor` and `var(--ink3)` strokes. Some are injected as raw HTML strings (view-tab and modal-tab icons). The full path data for the long paths (recovered): logo wave, sun rays, refresh, staff, checklist, membership star (listed in section 3). The logo wave path is a repeated sine segment, and the prototype's own markup truncates some `d` values in the stripped view only, not in the source.
9. **Broken or dead CSS.** `@keyframes oa-toast` uses an invalid `transl(...)` and is unused. `oa-pulse` and `oa-spin` are unused. The toast uses `oa-rise` instead, which clashes with its centring `translateX(-50%)`: during the animation `transform:none` replaces the centring, so the toast visibly shifts. Decide whether to preserve or fix this.
10. **Hard-coded values in the prototype that must become data.**
    - KPI "12 booked" and "3.5h" (Bay time free).
    - `dateLabel` "Saturday, June 13".
    - `BASE` date `2026-06-13` (a Saturday) and `NOW = 10:36 AM` (while the clock label uses the real time).
    - Membership "Renews Jul 12, 2026", "18 days" cadence, and "4 visits in 60 days".
    - "Visa ···· 4421", and `lifetimeSpend = visits * 148`.
    - Tax rate 7%. The `credit` calculation `Math.min(a.price, a.member==='Exotic'?0:0)` is always 0.
11. **Inconsistencies to be aware of.**
    - Timeline "Today" divider logic can label a day-1 first group "Today".
    - Range tabs "Next 24h" and "Week" do not filter anything.
    - `alertCount` is exposed but not rendered.
    - Needs Attention appears only on the Bay Board.
    - Free-bay UI differs between the two views (dashed drop zone versus plain "Bay available").
    - The Bay Board has no worker avatar.
    - Photo grid has 4 columns, but at most 3 slots render.
    - The `hint-placeholder-count` values are editor hints, not real counts.
    - `n` hotkey does not reset the new-appointment title.
    - `statusColor` for `completed` statuses in the staff view uses the status colour, but `paid` status in `collect()` is set only if status was `ready` (never occurs).
12. **Fixed pixel layout.** Columns 392px / 1fr / 356px with 18px gap and 26px gutters give a 644px centre column at 1480px. There are no breakpoints, and the Bay Board 2x2 plus 356px aside is a different grid. At narrower viewports the design is silent.
13. **Backdrop blur.** Both scrims use `backdrop-filter:blur(3–4px)`. The scrollbar styling is WebKit-only.
14. **Sticky headers on panel backgrounds.** The timeline and completed headers need `background:var(--panel)` and the z-indexes (3 and 2) to avoid content showing through.
15. **Procedural calendar data** (`genDay`) is seeded by an `rng(o*7919+104729)` mulberry-style PRNG, so the same day always produces the same fake schedule. A real backend replaces this, but the visual density (2 to 13 appointments per day) is a design cue.
16. **Cross-design contract.** The Settings design controls hours, closures, the emergency toggle, and checklist overrides via localStorage keys (see Appendix B). The Command Center's calendar and banner depend on those shapes.

---

## Appendix A. Fixture data driving the UI

**Services** (name, price, minutes). Task lists exclude any item matching `/inspection/i`.
- Express Hand Wash: $45, 35 min
- Premium Hand Wash + Interior: $129, 75
- Premium Hand Wash + Interior Refresh: $139, 75
- Executive Detail: $260, 90
- Executive Detail + Ceramic: $420, 120
- Full Detail: $320, 120
- Ceramic Maintenance + Wax: $180, 60
- Exotic Detail Package: $650, 150
- Family Wash + Pet Hair: $95, 50

**Add-ons** (name, price): Interior deep clean 60, Pet hair removal 35, Leather conditioning 45, Wax 40, Clay bar 50, Odor removal 30, Engine bay cleaning 55, Ceramic maintenance 120, Rain repellent 25, Wheel deep clean 40. Each has a task list in `ADDON_TASKS`.

**Seed appointments** (id, day, time, status, staff, name, vehicle, service, bay, member, pay):
- a1: day 0, 8:30 AM, completed, Lena K., Maria Delgado, 2021 Audi Q5, Express Hand Wash, Bay 2, Essential, paid, +Wax, tip $8, pickup collected.
- a2: 9:15 AM, completed, Marco R., David Okafor, 2019 Ford F-150, Full Detail, Bay 1, none, paid, +Engine bay cleaning, tip $20, collected.
- a3: 9:45 AM, completed, Lena K., Priya Nair, 2022 Tesla Model Y, Premium Hand Wash + Interior, Bay 2, Premium, unpaid, +Rain repellent, pickup pending.
- a4: 10:00 AM, cleaning, Marco R., VIP, Jonathan Franco, 2023 Mercedes-Benz GLE, Premium Hand Wash + Interior Refresh, Bay 1, "Premium Care", paid, +Leather conditioning, started 27 min ago.
- a5: 10:30 AM, arrived, Sofia D., Sofia Marchetti, 2024 Porsche Macan, Executive Detail, Bay 2, Executive, deposit $50, `geoIn 10:27 AM`.
- a6: 10:45 AM, confirmed, Marco R., VIP, eta 12, Liam Chen, 2020 BMW M340i, Ceramic Maintenance + Wax, Bay 1, paid.
- a7: 10:15 AM, confirmed, Unassigned, `late`, Marcus Webb, 2017 Jeep Wrangler, Family Wash + Pet Hair, no bay, deposit $20, +Odor removal.
- a8: 11:00 AM, booked, Sofia D., eta 22, Grace Adeyemi, 2018 Lexus RX 350, Express Hand Wash, Bay 2, unpaid.
- a9: 12:00 PM, confirmed, Marco R., Aisha Rahman, 2023 Range Rover Sport, Executive Detail + Ceramic, Bay 1, Exotic, paid, +Ceramic maintenance.
- a10: 1:30 PM, confirmed, Sofia D., Tom Bradley, 2016 Honda Civic, Express Hand Wash, Bay 2, unpaid.
- a11: 3:00 PM, booked, Marco R., VIP, Elena Volkov, 2022 Lamborghini Urus, Exotic Detail Package, Bay 1, Exotic, unpaid; special "Hand-dry only — no automated equipment near paint. Owner inspects before release."
- a12: day 1, 9:00 AM, confirmed, Lena K., Nathan Brooks, 2021 Chevrolet Tahoe, Family Wash + Pet Hair, Bay 2, Essential, paid, +Pet hair removal.
- Other seed notes: a3 "Customer prefers no fragrance products. Parked in the south lot."; a4 "Regular — every other Saturday. Likes a text when 10 min out."; a5 "New ceramic coating — pH-neutral products only."; the rest default to "No special instructions on file."

Derived at hydrate time:
- `visits = 3 + (idx % 9)`.
- Photos: `arrival` 0 if booked else 2; `before` 3 if cleaning or completed; `after` 2 if completed; `issue` 1 when `idx % 4 === 0`.
- History rows: first 3 or 4 rows from the history pool (months MAY, APR, MAR, FEB; days 02, 07, 12, 17).
- The initial checklist is pre-ticked by fraction: cleaning 0.5, completed 1, others 0.

**Computed seed alerts** (before any interaction): "Ready for pickup" (Priya Nair), "Running late · Marcus Webb", "Needs bay assignment" (Marcus Webb), "Unconfirmed" (Grace Adeyemi, Elena Volkov), "Special instructions" (Elena Volkov), "VIP arriving in 12 min · Liam Chen", "Arriving in 22 min · Grace Adeyemi", "Auto checked in · Sofia Marchetti", and "Member credit available" (Priya Nair). VIP-linked alerts sort first.

## Appendix B. Persistence and cross-page contract (localStorage)

- `oasis-theme`: `'light'` or `'dark'`.
- `oasis-hours`: array of 7 entries indexed by `Date.getDay()` (0 = Sunday), each `{open:boolean, from:'h:mm AM', to:'h:mm PM'}`. Default `DEF_HOURS`: Sunday 9:00 AM–3:00 PM; Monday through Friday 8:00 AM–6:00 PM; Saturday 8:00 AM–5:00 PM.
- `oasis-closures`: array of `{date:'YYYY-MM-DD', name, type:'closed'|'reduced', from?, to?}`. Default seed:
  - 2026-05-25 Memorial Day, closed
  - 2026-06-03 Weather closure, closed
  - 2026-07-04 Independence Day, closed
  - 2026-09-07 Labor Day, reduced 10:00 AM–2:00 PM
  - 2026-11-26 Thanksgiving, closed
  - 2026-12-24 Christmas Eve, reduced 8:00 AM–1:00 PM
  - 2026-12-25 Christmas Day, closed
- `oasis-emergency`: `{active, summary, …}`. Shows the banner when `active`.
- `oasis-checklists`: `{packages:{<serviceName>:[task,…]}, addons:{<addonName>:[task,…]}}`. Overrides the default task lists.
- Day info rules (`dayInfo`):
  - A `closed` closure gives `closed: <name>`.
  - A day that is not open per hours gives `closed: 'Regular day off'`.
  - Otherwise it gives `h0 = floor(open/60)`, `h1 = ceil(close/60)`, and uses the closure's from/to when reduced, with note `<name> · reduced hours`.
- Generated-day volume (`dayCount`): base by weekday `[4,6,6,7,7,9,10]` for Sunday to Saturday, plus `floor(rnd*4) - 1`, minimum 2, halved (ceiling) on reduced days, plus the real `day:1` appointments for tomorrow.

**Process note:** I created one helper file, `r.py`, in the session scratchpad before switching to inline heredocs. It is not part of the deliverable and I wrote no other files.