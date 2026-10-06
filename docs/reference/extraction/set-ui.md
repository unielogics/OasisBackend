<!-- Reference material generated during planning (2026-10-06) from the three Claude Design prototypes. Source of truth for the build; see docs/plan.md. -->

# Oasis Settings: UI / visual-fidelity spec

Source: `artifact-0adf91e6-…-6d37.html`. The template is about 67K chars and the script about 43K chars. I read all of both. No `@media` queries and no `@keyframes` exist anywhere. The only motion is the toggle `transition`. Fonts are bundled as woff2 inside the artifact; the `<link>` tags are only `preconnect` hints.

Conventions:
- "tile" means a card with `background:var(--panel2); border:1px solid var(--line)`.
- Time strings are always `h:mm AM/PM` with no leading zero.
- Unicode used in copy: `·` `–` `—` (U+2014) `’` `“ ”` `‹ ›` `−` (U+2212) `✕` `↑ ↓` `≤`.

---

## 1. Page frame & global chrome

### Root and scroll model
- `html, body { margin:0; padding:0; height:100%; overflow:hidden }` and `*{box-sizing:border-box}`.
- The root div is `<div data-theme="{{theme}}" data-screen-label="Oasis Settings">`.
  - Style: `height:100vh; overflow:hidden; display:flex; flex-direction:column; background:var(--bg); color:var(--ink); font-family:'Manrope',system-ui,sans-serif; -webkit-font-smoothing:antialiased; font-feature-settings:'tnum'; letter-spacing:-0.01em`.
- The page never scrolls. Only these regions scroll:
  - the left rail (`overflow-y:auto`);
  - the content body (`overflow-y:auto`);
  - the drawer body.
- Global rules:
  - `button{font-family:inherit;cursor:pointer;border:none;background:none;color:inherit}`
  - `a{color:var(--accent);text-decoration:none}` and `a:hover{color:var(--accentInk)}`
  - `input::placeholder,textarea::placeholder{color:var(--ink3)}`
  - `input:focus,textarea:focus{outline:none;border-color:var(--accent)!important}`. This also overrides the red validation border.
  - Buttons have no custom focus or hover styles.
  - Scrollbar: `::-webkit-scrollbar{width:10px;height:10px}`; thumb `background:var(--line);border-radius:8px;border:3px solid transparent;background-clip:padding-box`.

### Header
`<header>`: `flex:none; display:flex; align-items:center; gap:18px; padding:14px 26px; border-bottom:1px solid var(--line)`.

1. **Brand block**: `display:flex; gap:13px`.
   - Logo tile: 42×42, `border-radius:13px`, `background:var(--accent)`, centred.
   - Logo SVG: 24×24, viewBox `0 0 24 24`. All strokes are `#fff` with `stroke-width:2.1` and round caps. It has three parts:
     - Path `M5 13c0-3.5 2.5-7 7-7s7 3.5 7 7`.
     - Wave path `M3 16.5c1.2-.9 2.1-.9 3.3 0 1.2.9 2.1.9 3.3 0 1.2-.9 2.1-.9 3.3 0 1.2.9 2.1.9 3.3 0 1.2-.9 2.1-.9 3.3 0`, with round join.
     - `circle cx=12 cy=12.5 r=1.6 fill #fff`.
   - Text wrapper: `line-height:1.05`.
   - Title: "Oasis Auto Spa", Bricolage Grotesque 700, 18px, `letter-spacing:-0.02em`.
   - Subtitle: "Settings", 11px, 600, `var(--ink3)`, uppercase, `letter-spacing:0.04em`.
2. **Module nav**: `display:flex; gap:4px; padding:4px; background:var(--panel2); border:1px solid var(--line); border-radius:13px; flex:none`.
   - Three `<a>` items: `height:38px; padding:0 16px; border-radius:10px; font-size:13.5px; font-weight:700; display:flex; align-items:center`.
   - Inactive: `color:var(--ink2)`. Active (Settings): `background:var(--accent); color:#fff`.
   - Labels and hrefs:
     - Operations → `Oasis%20Command%20Center.dc.html`
     - Payments → `Oasis%20Payments.dc.html`
     - Settings → `Oasis%20Settings.dc.html`
3. A `flex:1` spacer.
4. **Theme toggle** (`sc-camel-on-click=toggleTheme`, `title="Toggle theme"`): 46×46, `background:var(--panel); border:1px solid var(--line); border-radius:13px; color:var(--ink2)`.
   - Moon icon only, 19×19, viewBox `0 0 24 24`, path `M20 14.5A8 8 0 019.5 4 7 7 0 1020 14.5z`, `stroke:currentColor`, width 2, round join.
   - The same icon is shown in both themes.
5. **User chip**: `display:flex; gap:9px; padding:4px 12px 4px 4px; background:var(--panel); border:1px solid var(--line); border-radius:13px`.
   - Avatar: 36×36, `border-radius:10px`, `background:var(--accentSoft); color:var(--accentInk)`, 800, 13px, text "RM".
   - Text block: `line-height:1.1`.
   - Name: "Rafael M.", 13px, 700.
   - Sub: "Management · Accounting", 11px, 600, `var(--ink3)`.
   - All of this is static text. It is not bound to the employee list.

### Main grid
`<main>`: `flex:1; min-height:0; display:grid; grid-template-columns:250px minmax(0,1fr); gap:18px; padding:18px 26px`.

### Left settings rail
`<aside>`: `background:var(--panel); border:1px solid var(--line); border-radius:20px; padding:16px 12px; box-shadow:var(--shadow); overflow-y:auto; display:flex; flex-direction:column; gap:3px`.

**Group labels**: `font-size:11px; font-weight:800; color:var(--ink3); text-transform:uppercase; letter-spacing:0.07em`.
- Padding is `6px 12px 8px` for the first group ("Business") and `16px 12px 8px` for the rest.

**Nav button style** (`nav.<key>`, from `navS`): `display:flex; align-items:center; gap:11px; width:100%; min-height:44px; padding:0 12px; border-radius:12px; font-size:14px; font-weight:700`.
- Active: `background:var(--accentSoft); color:var(--accentInk)`.
- Inactive: `background:transparent; color:var(--ink2)`.
- Layout: an 18×18 stroke icon (`stroke:currentColor`, width 2), then `<span style="flex:1;text-align:left">label</span>`, then an optional trailing item.

| Group | Label (verbatim) | Key | Icon (viewBox 0 0 24 24) | Trailing |
|---|---|---|---|---|
| Business | Working hours | hours | `circle 12,12 r9` + `M12 7v5l3 2` (clock) | none |
| Business | Holidays & closures | closures | `rect x3 y5 w18 h16 rx2` + `M3 9h18M8 3v4M16 3v4M9 14l6 4M15 14l-6 4` (calendar with X) | none |
| Business | Emergency closing | emergency | `M12 3l9 16H3z` + `M12 10v4M12 17h.01` (warning triangle) | `ACTIVE` pill when `emActive` |
| Team | Employees | employees | `circle cx9 cy8 r3` + `M3.5 19a5.5 5.5 0 0111 0M16 6.5a3 3 0 010 5.5M18 13a5 5 0 013 4.5` | `{{empCount}}` |
| Team | Roles & permissions | roles | shield `M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z` + check `M9 12l2 2 4-4` | none |
| Clients | VIP program | vip | star `M12 3l2.5 5.2 5.7.8-4.1 4 1 5.7L12 16l-5.1 2.7 1-5.7-4.1-4 5.7-.8L12 3z` | none |
| Clients | Arrival & check-in | arrival | pin `M12 21s7-5.5 7-11a7 7 0 10-14 0c0 5.5 7 11 7 11z` + `circle 12,10 r2.4` | none |
| Services | Packages & checklists | services | `M4 6l2 2 3-3M4 13l2 2 3-3M4 20l2 2 3-3M13 6h7M13 13h7M13 20h7` (checklist) | none |

Rail items in DOM order: Business → Hours, Closures, Emergency; Team → Employees, Roles; Clients → VIP, Arrival; Services → Packages.

Trailing items:
- `ACTIVE` pill: `font-size:10px; font-weight:800; color:#fff; background:#C2410C; padding:3px 7px; border-radius:6px`.
- Employee count: `font-size:11.5px; font-weight:800; color:var(--ink3)`. Example: "7".

### Content panel
`<section>`: `background:var(--panel); border:1px solid var(--line); border-radius:20px; box-shadow:var(--shadow); display:flex; flex-direction:column; min-height:0; overflow:hidden`.

**Section header**: `flex:none; display:flex; align-items:center; gap:16px; padding:20px 26px; border-bottom:1px solid var(--line2)`.
- Title: Bricolage 700, 22px, `letter-spacing:-0.02em`.
- Description: 13px, 600, `var(--ink2)`, `margin-top:3px`.
- Optional head button (`hasHeadBtn`): `height:46px; padding:0 18px; background:var(--accent); color:#fff; border-radius:13px; font-weight:700; font-size:14px; gap:8px; flex:none`. It holds a 17px plus icon (`M12 5v14M5 12h14`, white, stroke 2.2, round) followed by the label.
- Head buttons exist only for Closures ("Add closure"), Employees ("Add employee") and Roles ("Custom role").

**Section titles and descriptions** (verbatim `META`):
- hours: "Working hours" / "Weekly opening hours and booking rules."
- closures: "Holidays & closures" / "Planned closed days and reduced hours. Booked customers are notified automatically."
- emergency: "Emergency closing" / "Close immediately, notify affected customers and pause booking."
- employees: "Employees" / "Create team members, assign roles and set schedules."
- roles: "Roles & permissions" / "What each role can see and do, including money limits."
- vip: "VIP program" / "Booking priority for VIP clients. Built around saving them time."
- arrival: "Arrival & check-in" / "Geofence check-in and bay prep for every client."
- services: "Packages & checklists" / "Checklist tasks for each package and add-on. Jobs combine both automatically."

**Body**: `flex:1; min-height:0; overflow-y:auto; padding:22px 26px 26px`.

### Unsaved-changes bar
Rendered when `hoursDirty`, which is true only when `section==='hours'` and the JSON of `hours` differs from `savedHours`.
- Position: the last child of the section card, below the scroll body. It is a flow element, not fixed, and the body shrinks to make room.
- Style: `flex:none; display:flex; align-items:center; gap:12px; padding:14px 26px; border-top:1px solid var(--line); background:var(--panel2)`.
- Text: `flex:1; font-weight:700; font-size:14px`, "Unsaved changes to working hours".
- **Discard**: `height:46px; padding:0 18px; border-radius:12px; background:var(--panel); border:1px solid var(--line); font-weight:700; font-size:14px`.
- **Save changes**: `height:46px; padding:0 22px; border-radius:12px; background:var(--accent); color:#fff; font-weight:800; font-size:14px`.

### Emergency confirm dialog
- Overlay (click cancels): `position:fixed; inset:0; z-index:70; background:rgba(8,12,10,.55); display:flex; align-items:center; justify-content:center; padding:24px`.
- Card (`stop` propagation): `width:100%; max-width:480px; background:var(--panel); border:1px solid var(--line); border-radius:22px; padding:26px; box-shadow:var(--shadowLg)`.
- Title: "Close Oasis Auto Spa now?", Bricolage 700, 22px, `letter-spacing:-0.02em`.
- Body (`confirmText`): 14px, 600, `var(--ink2)`, `margin-top:8px`, `line-height:1.55`.
- Button row: `display:flex; gap:10px; margin-top:22px`. Both buttons are `flex:1; height:52px; border-radius:13px`.
  - "Cancel": `background:var(--panel2); border:1px solid var(--line); font-weight:700; font-size:14.5px`.
  - "Confirm closure": `background:#C2410C; color:#fff; font-weight:800; font-size:14.5px`.

### Toast
- Rendered when `toast` is truthy: `position:fixed; bottom:26px; left:50%; transform:translateX(-50%); z-index:90; padding:14px 20px; background:var(--ink); color:var(--bg); border-radius:14px; box-shadow:var(--shadowLg); font-weight:700; font-size:13.5px; max-width:90vw`.
- It auto-hides after 2800 ms (`flash`, with `clearTimeout` on re-flash). There is no enter or exit animation.

### Employee drawer shell
See §3.9 for the contents.
- Overlay: `position:fixed; inset:0; z-index:60; background:rgba(8,12,10,.5); display:flex; justify-content:flex-end`. Clicking it closes the drawer and discards the draft.
- Panel (`stop`): `width:620px; max-width:96vw; height:100%; background:var(--bg2); border-left:1px solid var(--line); box-shadow:var(--shadowLg); display:flex; flex-direction:column`. There is no slide animation.

---

## 2. Design tokens

### Colour tokens
Light is on `:root, [data-theme="light"]`; dark is on `[data-theme="dark"]`.

| Token | Light | Dark |
|---|---|---|
| --bg | #ECEBE4 | #0C100E |
| --bg2 | #F4F3EE | #10150F |
| --panel | #FFFFFF | #161E1A |
| --panel2 | #F5F4EF | #1C2620 |
| --panel3 | #EEEDE6 | #212C26 |
| --ink | #18211E | #ECF1EE |
| --ink2 | #5C645F | #9BA7A0 |
| --ink3 | #949A94 | #69756E |
| --line | #E2E0D7 | #283330 |
| --line2 | #EDEBE3 | #222B27 |
| --accent | #0E7A63 | #2FB694 |
| --accentInk | #0A5C49 | #7FE0C6 |
| --accentSoft | #DCEEE8 | #15302A |
| --accentBrd | #BFE0D5 | #23463D |
| --shadow | `0 1px 2px rgba(24,33,30,.04),0 6px 22px rgba(24,33,30,.07)` | `0 1px 2px rgba(0,0,0,.3),0 8px 26px rgba(0,0,0,.35)` |
| --shadowLg | `0 24px 70px rgba(24,33,30,.22)` | `0 30px 80px rgba(0,0,0,.6)` |

Usage of the less obvious tokens:
- `--bg2` is used only for the drawer panel background.
- `--panel3` is used for neutral pills and tags (Closed tag, "N exceptions" pill, Inactive status, locked check box).
- `--line2` is used for faint dividers (section header bottom, matrix row tops, past rows).

### Hard-coded colours (not themed; identical in light and dark)
| Value | Use |
|---|---|
| #C2410C | Danger and emergency: ACTIVE pill, emergency banner bg, close button, confirm button, REMOVE, ✕ on tasks, Deny, trash/validation text, deactivate text, reopen text |
| #FBEFD9 bg, #F0D9A6 border, #8A5A12 text | "customers are booked that day" warning in the new-closure form |
| #7A3B8A | VIP purple: VIP chip and "Make VIP" button |
| rgba(194,65,12,.14) bg + #C2410C | "Emergency" tag |
| rgba(194,116,11,.14) bg + #B45309 | "Invite sent" status |
| rgba(176,121,8,.15) bg + #8A5A06 | "Add-on" kind tag |
| rgba(194,65,12,.25) | Shadow of the Close button: `0 10px 24px rgba(194,65,12,.25)` |
| rgba(8,12,10,.5) | Drawer overlay |
| rgba(8,12,10,.55) | Confirm overlay |
| #fff | Text on accent and danger fills, toggle knob |
| rgba(0,0,0,.25) | Knob shadow |
| #E8EEEA | Avatar text in dark theme |

### Avatar palette
`COLORS=['#0E7A63','#2563EB','#7A3B8A','#C2740B','#0D9488','#B45309','#6B7280']`, indexed by `i%7`.
- Background: `color-mix(in oklab, <COLOR> 15%, transparent)` in light and `26%` in dark.
- Text: `<COLOR>` in light and `#E8EEEA` in dark.
- Shape: `border-radius:13px; flex:none; font-weight:800; font-size:size/3.2 px`. Size 46 gives 14.375px; size 54 gives 16.875px.
- The index is the employee's position in the array. A new employee in the drawer uses index 0.

### Fonts
- **Manrope**: UI font. Weights bundled: 400, 500, 600, 700, 800. Used: 600, 700, 800. `font-feature-settings:'tnum'` and `letter-spacing:-0.01em` globally.
- **Bricolage Grotesque**: display font. Weights bundled: 500, 600, 700, 800. Always used at 700 with `letter-spacing:-0.02em`.
- Display uses:
  - brand (18px);
  - section title (22px);
  - confirm title (22px);
  - drawer heading (21px);
  - service name (21px);
  - closure date number (21px);
  - emergency summary and stats (26px);
  - weekly-hours stat (30px).

### Type scale in use (px / weight)
| Size | Where |
|---|---|
| 10 / 800 | ACTIVE pill, LOCKED/REMOVE, closure dow |
| 10 / 700 | closure dow |
| 10.5 / 800 | closure month, VIP chip, service kind tag (uppercase, ls .04em) |
| 11 / 600–800 | header sub, rail group labels, user sub, perm-group labels (uppercase), tags, limit chips, "Preview · WhatsApp to Liam" label (uppercase, ls .05em) |
| 11.5 / 700–800 | counts, role pills, status pill, "Upcoming"/"Past"/"Closure history" labels (uppercase, ls .06em), variables hint, override Role/Allow/Deny, perm source line |
| 12 / 700–800 | field labels, "Notify", sublines, affected count, history, small buttons |
| 12.5 / 600–700 | sub copy, rule labels, "Copy Monday…" |
| 13 / 600–800 | section desc, stepper values, affected rows |
| 13.5 / 600–800 | nav tab, message textarea, task buttons, perm labels, history |
| 14 / 600–800 | rail items, most inputs, row titles |
| 14.5 / 700–800 | day names, Name, confirm buttons |
| 15 / 800 | card titles (and 700 text e.g. "Reopen now" at 15/800) |
| 16 / 800 | "Close the shop now" |
| 18 / 700 | brand |
| 21 / 700 | drawer heading, service name, closure date number |
| 22 / 700 | section title, confirm title |
| 26 / 700 | emergency summary and stats |
| 30 / 700 | weekHours |

### Radii
| px | Used for |
|---|---|
| 6–9 | tiny pills and tags, seg buttons (9) |
| 10 | stepper buttons, nav tab item, small buttons |
| 11 | inputs, chips, avatar-wrapping boxes, stepper pill |
| 12 | seg container, rail nav items, bar buttons, many tiles |
| 13 | header controls, head button, avatar, large buttons |
| 14 | notices, upcoming rows, role cards, confirm toast |
| 15 | employee row, Close button |
| 16 | tiles |
| 18 | emergency active banner |
| 20 | rail and content panels |
| 22 | confirm dialog |
| 50% | status dots, knob |
| 16 | toggle track |

### Spacing
- Page gutters: 26px horizontal, 18px grid gap.
- Cards: 18px padding; 20px padding for drawer-adjacent and service editor tiles.
- Card stack gaps: 18px; list-row gaps: 8–10px.
- Control heights: 36–38 (compact), 40, 44, 46 (standard input/button), 50, 52, 58.
- Toggle: 50×30.

### Toggle (`sw(on)`)
- Track: `flex:none; width:50px; height:30px; border-radius:16px; position:relative; background:on?var(--accent):var(--line); transition:background .15s`.
- Knob: `position:absolute; top:3px; left:on?23px:3px; width:24px; height:24px; border-radius:50%; background:#fff; box-shadow:0 1px 3px rgba(0,0,0,.25); transition:left .15s`.

### Segmented button (`seg(on)`)
- Button: `flex:1; height:38px; padding:0 12px; border-radius:9px; font-size:13px; font-weight:700; white-space:nowrap`.
  - On: `background:var(--accent); color:#fff`.
  - Off: `background:transparent; color:var(--ink2)`.
- Container: `display:flex; gap:4px; padding:4px; background:var(--panel); border:1px solid var(--line); border-radius:12px`.

### Chip (`chip(on)`)
`height:40px; padding:0 14px; border-radius:11px; font-size:13px; font-weight:700`.
- On: `background:var(--accentSoft); color:var(--accentInk); border:1px solid var(--accentBrd)`.
- Off: `background:var(--panel); color:var(--ink2); border:1px solid var(--line)`.

### Z-index and animation
- z-index: sticky matrix header 2; drawer overlay 60; confirm overlay 70; toast 90.
- The "Made with Claude Design" badge uses z-index 2147483646. It is tooling and not part of the design.
- Animation: only `transition: background .15s` and `left .15s` on toggles. No keyframes, no hover states, no loading or skeleton states.

---

## 3. Section-by-section component spec

Common tile: `background:var(--panel2); border:1px solid var(--line); border-radius:16px; padding:18px`.
Card title: `font-weight:800; font-size:15px`.
Two-column grid: `display:grid; grid-template-columns:repeat(auto-fit,minmax(340px,1fr)); gap:18px; align-items:start`.

### 3.1 Working hours (`secHours`)
**Outer grid**: the two-column grid above.
- The weekly card has `grid-column:span 2`. The right stack is one column.
- At content width of about 1056px or more (1440px viewport and up) it shows 2/3 and 1/3 side by side. Below that it stacks.
- Below about 698px the span-2 forces an implicit second column. This is ambiguous.

**Weekly schedule card**: tile with `padding:6px 18px 8px; min-width:0`.
- Head row: `display:flex; justify-content:space-between; padding:12px 0 10px; gap:10px`.
  - Title: "Weekly schedule", 800, 15px.
  - Button "Copy Monday to weekdays": `height:38px; padding:0 13px; border-radius:10px; background:var(--panel); border:1px solid var(--line); font-weight:700; font-size:12.5px; color:var(--ink2)`.
- Rows (`hourRows`): shown in `ORDER=[1,2,3,4,5,6,0]`, which is Monday through Sunday, using `DAYS` names Sunday–Saturday.
  - Style: `display:flex; align-items:center; gap:14px; padding:11px 0; border-top:1px solid var(--line); flex-wrap:wrap; min-height:66px`.
  - The first row also has a top border.
  - Contents, in order:
    - toggle (50×30);
    - day name `width:104px; font-weight:700; font-size:14.5px`;
    - if `h.open`: from-stepper, the word "to", to-stepper, right-aligned length;
    - if `h.closed`: the text "Closed" (`font-weight:700; font-size:13.5px; color:var(--ink3)`).
  - **Stepper** (`display:flex; align-items:center; background:var(--panel); border:1px solid var(--line); border-radius:11px; height:44px`):
    - Dec and inc buttons are `width:38px; height:100%; color:var(--ink2)` with 15px chevron SVGs, stroke `2.4`, round. Left chevron is `M15 6l-6 6 6 6`; right is `M9 6l6 6-6 6`.
    - The value is `<span min-width:76px; text-align:center; font-weight:800; font-size:13.5px>`.
    - "to": `color:var(--ink3); font-weight:700`.
  - Length label: `margin-left:auto; font-size:12.5px; font-weight:700; color:var(--ink3)`. It is `len/60 + ' hrs'`, so "10 hrs", "9 hrs", "6 hrs", "9.5 hrs".
- Steppers move in 30-minute steps, clamped to 5:00 AM (300 min) through 11:30 PM (1410 min).
- There is no check that from is before to. A negative length is clamped to 0 hrs.

**Right column** (`display:flex; flex-direction:column; gap:18px; min-width:0`):
- **Booking rules** tile.
  - Title "Booking rules", `margin-bottom:14px`.
  - Each rule block has `margin-bottom:14px`. Label is `font-size:12.5px; font-weight:700; color:var(--ink2); margin-bottom:7px`, above a seg container.
  - Rules and defaults:
    - "Slot length": 15 / 30 / 60 min, default 30.
    - "Buffer between jobs": 0 / 10 / 15 / 20 min, default 10.
    - "Last booking before close": 30 / 60 / 90 min, default 60.
  - Option labels are `${v} min`.
- **Summary tile**: `background:var(--accentSoft); border:1px solid var(--accentBrd); border-radius:16px; padding:18px; color:var(--accentInk)`.
  - Stat `{{weekHours}}`: Bricolage 700, 30px. Default is "65 hrs" (5×10 + Saturday 9 + Sunday 6).
  - "open per week": 13px, 700, `margin-top:2px`.
  - Note: "Hours drive online booking slots, the Operations calendar and the customer app." at 12.5px, 600, `margin-top:10px; line-height:1.5; opacity:.9`.

**Default hours**: Mon–Fri 8:00 AM–6:00 PM, Sat 8:00 AM–5:00 PM, Sun 9:00 AM–3:00 PM. All seven days are `open:true`.

**States**:
- Dirty: the bar appears (§1).
- Copy Monday to weekdays: copies `H[1]` (Monday) onto Tuesday, Wednesday, Thursday and Friday (`[2,3,4,5]`) only, including the open flag. It does not touch Saturday or Sunday.
- Save: writes localStorage `oasis-hours`, updates `savedHours`, toast "Working hours saved · booking and calendar updated".
- Discard: restores `savedHours`.

### 3.2 Holidays & closures (`secClosures`)
**New closure form** (`addingClosure`, opened by the head button "Add closure"; resets `nc` and `ncError`):
- Card: `background:var(--panel2); border:1.5px solid var(--accentBrd); border-radius:16px; padding:20px; margin-bottom:20px`.
- Title "New closure" (800, 15px, `mb:14px`).
- Grid: `grid-template-columns:200px minmax(0,1fr); gap:12px`.
  - "Date": native `<input type="date">`, `height:46px; padding:0 12px; border-radius:11px; border:1px solid var(--line); background:var(--panel); color:var(--ink); font-size:14px; font-weight:600; width:100%`.
  - "Name": text input, `padding:0 14px`, placeholder "e.g. Staff training day".
  - Labels: `font-size:12px; font-weight:700; color:var(--ink2); margin-bottom:6px`.
- Type row: `display:flex; align-items:center; gap:12px; margin-top:14px; flex-wrap:wrap`.
  - A seg container with "Closed all day" and "Reduced hours". Default is closed.
  - If `ncIsReduced`, a stepper row: `‹ [from] ›  to  ‹ [to] ›`.
    - The `‹ ›` are plain text characters in buttons `width:36px; height:40px; border-radius:10px; background:var(--panel); border:1px solid var(--line)`.
    - Values are `min-width:74px; text-align:center`; container `font-size:13.5px; font-weight:700; gap:8px`; "to" is `var(--ink3)`.
    - Defaults are 10:00 AM and 2:00 PM.
- Warning (`ncAffected`): `margin-top:14px; padding:12px 14px; background:#FBEFD9; border:1px solid #F0D9A6; border-radius:12px; font-size:13px; font-weight:700; color:#8A5A12`.
  - Copy: `"{N} customers are booked that day — they’ll get a reschedule link when you add this."`
  - N is `(dayOfMonth%5)+2`. It only shows if `nc.date >= '2026-06-13'` (hard-coded TODAY). It is fake data.
- Error (`ncError`): `margin-top:10px; font-size:12.5px; font-weight:700; color:#C2410C`.
  - "Add a date and a name."
  - "There’s already a closure on that date." (a duplicate date is rejected).
  - Errors clear on date or name edit.
- Buttons, right-aligned (`gap:10px; margin-top:16px`):
  - "Cancel": `height:46px; padding:0 18px; border-radius:12px; background:var(--panel); border:1px solid var(--line); font-weight:700; font-size:14px`.
  - "Add closure": `padding:0 22px; background:var(--accent); color:#fff; font-weight:800; font-size:14px`.
- On add: the new row gets `{...nc, name:trimmed, notify:true, id:'c'+Date.now()}`; it persists to `oasis-closures`; toast `"{name} added · calendar updated"`.

**Auto-add row** (always visible): `display:flex; align-items:center; gap:14px; padding:16px 18px; background:var(--panel2); border:1px solid var(--line); border-radius:14px; margin-bottom:22px`.
- Title: "Auto-add US federal holidays", 700, 14.5px.
- Sub: "Added as closed days each January. Edit or remove any of them below.", 12.5px, 600, `var(--ink3)`, `mt:2px`.
- Toggle at the right. The default is on. It is state only: it is not persisted and has no effect.

**Section labels**: "Upcoming" and "Past" (`11.5px/800 uppercase ls .06em var(--ink3) mb:10px`).

**Upcoming list** (`display:flex; flex-direction:column; gap:10px; margin-bottom:26px`), sorted ascending by date.
- Row: `display:flex; align-items:center; gap:16px; padding:14px 16px; background:var(--panel); border:1px solid var(--line); border-radius:14px`.
- Date tile: `flex:none; width:56px; text-align:center; padding:6px 0; border-radius:11px; background:var(--panel2); border:1px solid var(--line)`.
  - Month in caps, 10.5px/800 `var(--ink3)`.
  - Day, Bricolage 700, 21px, `line-height:1.1`.
  - Day-of-week in caps, 10px/700 `var(--ink3)`.
- Middle block: name (800, 15px) plus a tag (`11px/800; padding:3px 8px; border-radius:7px`), then the sub line (12.5px/600 `var(--ink2)`, `mt:3px`).
- Tag labels and colours:
  - "Emergency" (`c.emergency`): `rgba(194,65,12,.14)` bg, `#C2410C` text.
  - "Closed all day": `var(--panel3)` bg, `var(--ink2)` text.
  - "Reduced · {from} – {to}": `var(--accentSoft)` bg, `var(--accentInk)` text.
- Sub copy:
  - closed: `"Online booking blocked · {N} existing bookings to move"` with N = day-of-month % 4;
  - reduced: `"Slots outside reduced hours hidden · {N} bookings affected"` with N = day-of-month % 3.
  - These are placeholders. Real counts need backend logic.
- "Notify" label (`12px/700 var(--ink2)`) plus a toggle. It defaults on and persists.
- Remove button: 44×44, `border-radius:11px; background:var(--panel2); border:1px solid var(--line); color:var(--ink3)`, `title="Remove"`, trash icon 17px (`M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13`, stroke 2, round).
  - It removes immediately, with no confirm, and toasts `"{name} removed"`.

**Past list** (`gap:8px`), sorted most recent first.
- Row: `padding:12px 16px; background:var(--panel2); border:1px solid var(--line2); border-radius:12px; opacity:.85`.
- Contents: `"{MON} {day}"` (`font-weight:800; font-size:13px; width:70px; color:var(--ink2)`), name (`700/13.5px; flex:1`), tag.
- Past rows have no Notify and no Remove.

**Past/upcoming split**: `date < '2026-06-13'` string comparison. TODAY is hard-coded.

**Seed closures** (`oasis-closures` default):
| Date | Name | Type | Extra |
|---|---|---|---|
| 2026-05-25 | Memorial Day | closed | |
| 2026-06-03 | Weather closure | closed | emergency:true |
| 2026-07-04 | Independence Day | closed | |
| 2026-09-07 | Labor Day | reduced | 10:00 AM – 2:00 PM |
| 2026-11-26 | Thanksgiving | closed | |
| 2026-12-24 | Christmas Eve | reduced | 8:00 AM – 1:00 PM |
| 2026-12-25 | Christmas Day | closed | |

Each gets `notify:true`, from `'10:00 AM'`, to `'2:00 PM'` defaults, and `id:'c'+index`.

### 3.3 Emergency closing (`secEmergency`)
This section has two mutually exclusive top blocks, plus an always-visible history list.

**ACTIVE state** (`emActive`): `padding:22px; background:#C2410C; color:#fff; border-radius:18px; margin-bottom:20px`.
- Kicker: "Emergency closure active", 12px/800 uppercase, `letter-spacing:.06em; opacity:.9`.
- Summary `{{emSummary}}`: Bricolage 700, 26px, `margin-top:6px`.
  - Format: `"{reason} · closed {untilText}"` plus `" · online booking paused"` if pause is on.
  - Example: "Severe weather · closed for the rest of today · online booking paused".
- Stats row (`display:flex; gap:26px; margin-top:16px; flex-wrap:wrap`). Each stat has a value (Bricolage 700, 26px) and a label (12px/700, `opacity:.85`):
  - `{{emNotified}}` → "customers notified". It is `REMAINING.length` (6) if notify is on, else "0".
  - `{{emRebooked}}` → "rebooked so far". Hard-coded "2".
  - `{{emBooking}}` → "online booking". "Paused" if pause is on, else "Open".
- "Reopen now": `margin-top:18px; height:50px; padding:0 24px; border-radius:13px; background:#fff; color:#C2410C; font-weight:800; font-size:15px`.
- Reopen effects:
  - writes `oasis-emergency {active:false}`;
  - prepends a history item `{date:'Jun 13, 2026', reason, detail:'Reopened by Rafael M. · 6 notified'}`;
  - toast "Shop reopened · online booking resumed".

**IDLE state** (`emIdle`):
- Status banner: `display:flex; align-items:center; gap:14px; padding:16px 18px; background:var(--accentSoft); border:1px solid var(--accentBrd); border-radius:14px; margin-bottom:20px; color:var(--accentInk)`.
  - A 10×10 dot (`background:var(--accent); border-radius:50%`) and the text `flex:1; font-weight:700; font-size:14px`.
  - Text is **static**: "Open now · Saturday 8:00 AM – 5:00 PM · 6 appointments left today, 3 vehicles on site".
- Two-column grid.

**Left column** (`gap:18px`):
1. **Reason tile**.
   - Title "Reason".
   - Chips (`gap:8px; flex-wrap:wrap`): "Severe weather" (default selected), "Power outage", "Equipment failure", "Staff shortage", "Other".
   - Then a second heading, "Close for" (800, 15px, `margin:20px 0 12px`).
   - A seg with three options: "Rest of today" (key `today`, default), "Until a time" (`until`), "Multiple days" (`days`).
   - If `emIsUntil`: row `display:flex; gap:8px; margin-top:12px; font-weight:700; font-size:14px`.
     - The text "Reopen at", then `‹` / `[time]` / `›`.
     - Buttons are 40×44, `border-radius:10px; panel bg; line border`; the value is `min-width:80px; font-weight:800`.
     - Default is 2:00 PM, 30-minute steps.
   - If `emIsDays`: row `gap:10px; margin-top:12px; font-weight:700; font-size:14px`. The text "Closed through" followed by a native date input (`height:46px`, 14px/600). The default is `2026-06-15`.
2. **Customer message tile**.
   - Title "Customer message".
   - Textarea: `rows=4; width:100%; padding:12px 14px; border-radius:12px; border:1px solid var(--line); background:var(--panel); font-size:13.5px; font-weight:600; line-height:1.5; resize:vertical`.
   - Hint: "Variables: {first} {reason} {until} {link}" (`11.5px/700 var(--ink3); margin:8px 0 10px`).
   - Preview label: "Preview · WhatsApp to Liam".
   - Preview bubble: `padding:12px 14px; border-radius:14px 14px 14px 4px; background:var(--panel); border:1px solid var(--line); font-size:13.5px; font-weight:600; line-height:1.5`.
   - Default message: `Hi {first}, due to {reason} Oasis Auto Spa is closed {until}. We’re sorry for the inconvenience. Pick a new time here: {link}`.
   - Variable substitution in the preview (regex global replace):
     - `{first}` → "Liam".
     - `{reason}` → `reasonText`: Severe weather → "severe weather"; Power outage → "a power outage"; Equipment failure → "an equipment failure"; Staff shortage → "a staffing issue"; Other → "unforeseen circumstances".
     - `{until}` → `untilText`: today → "for the rest of today"; until → `"until {time} today"`; days → `"through " + toLocaleDateString('en-US', {weekday:'long', month:'short', day:'numeric'})` (example "through Monday, Jun 15").
     - `{link}` → "oasis.spa/r/8KQ2".

**Right column** (`gap:18px`):
3. **Options tile**: tile with `padding:6px 18px`. Rows are `display:flex; align-items:center; gap:14px; padding:13px 0; border-bottom:1px solid var(--line)`.
   - Label `700/14px` over sub `12px/600 var(--ink3) mt:2px`, then a toggle. All default on.

   | Key | Label | Sub |
   |---|---|---|
   | notify | Notify affected customers | WhatsApp, with SMS fallback |
   | link | Include one-tap reschedule link | Customers pick a new slot themselves |
   | credits | Protect member credits | Missed visits don’t use a credit |
   | pause | Pause online booking | Until you reopen |
   | crew | Alert on-shift crew | Push notification to the team |

4. **Affected appointments** tile.
   - Heading row: "Affected appointments" and the count `"{N} customers"` (12px/800 `var(--ink3)`). There is no singular form.
   - Rows: `display:flex; gap:12px; padding:9px 0; border-top:1px solid var(--line); font-size:13px`. Time (`width:70px; 800`), name (`flex:1; 700`), vehicle (`600 var(--ink3)`).
   - The fixed `REMAINING` list:
     - 10:15 AM Marcus Webb, Jeep Wrangler
     - 10:45 AM Liam Chen, BMW M340i
     - 11:00 AM Grace Adeyemi, Lexus RX 350
     - 12:00 PM Aisha Rahman, Range Rover Sport
     - 1:30 PM Tom Bradley, Honda Civic
     - 3:00 PM Elena Volkov, Lamborghini Urus
   - In "until" mode it filters to times strictly before the reopen time. "Today" and "days" show all six. In "days" mode only today's remaining appointments are listed. Future days are not modelled.
5. **Close the shop now** button: `height:58px; border-radius:15px; background:#C2410C; color:#fff; font-weight:800; font-size:16px; box-shadow:0 10px 24px rgba(194,65,12,.25)`.
6. Helper text: `font-size:12px; font-weight:600; color:var(--ink3); text-align:center; margin-top:-8px`. Copy: "Requires Management or Super Admin · you have access". Static.

**Confirm text**:
`{notify ? N+' customers will be messaged' : 'No customers will be messaged'}{pause ? ', online booking pauses' : ''} and the closure shows on the Operations screen. Reason: {reason lowercased}, {untilText}.`
- Confirm closure writes `oasis-emergency {active:true, summary}`.
- Toast: `"Shop closed · {N} customers notified"` or `"Shop closed · no messages sent"`.
- It does not add a history row. It does not add an entry to the closures list.

**Closure history** (always visible; label "Closure history" `margin:26px 0 10px`).
- Row: `padding:12px 16px; background:var(--panel2); border:1px solid var(--line2); border-radius:12px; margin-bottom:8px; font-size:13px`. Date (`800; width:90px`), reason (`700; flex:1`), detail (`600 var(--ink3)`).
- Seeds:
  - "Jun 3, 2026" / "Severe weather" / "Full day · 7 customers notified · 6 rebooked"
  - "Feb 18, 2026" / "Power outage" / "11:20 AM – 3:00 PM · 4 notified"
- History is not persisted.

**Deep link**: `componentDidMount` opens the emergency section if `location.hash === '#emergency'`.

### 3.4 Employees (`secEmployees`)
**Toolbar**: `display:flex; align-items:center; gap:12px; margin-bottom:16px; flex-wrap:wrap`.
- Search input: `flex:1; min-width:220px; height:46px; padding:0 16px; border-radius:12px; border:1px solid var(--line); background:var(--panel2); font-size:14px; font-weight:600`. Placeholder "Search name, phone, role…".
  - It matches `first last phone title` plus role names, case-insensitive substring.
- Filter chips (`display:flex; gap:6px; flex-wrap:wrap`): "All" plus one chip per role. Role chips are built from live roles, including custom ones. The default is All.

**List**: `display:flex; flex-direction:column; gap:9px`. Each row is a `<button>` (click opens the drawer).
- Style: `display:flex; align-items:center; gap:16px; width:100%; text-align:left; padding:14px 16px; background:var(--panel); border:1px solid var(--line); border-radius:15px; flex-wrap:wrap`.
- Parts:
  - Avatar: 46px, initials (first letter of first plus last), `border-radius:13px`, 800.
  - Name block `width:200px`: name (800, 15px) and `"{title or —} · {type}"` (12.5px/600 `var(--ink2)`, `mt:1px`).
  - Roles area (`flex:1; min-width:200px; display:flex; gap:6px; flex-wrap:wrap`):
    - Role pill: `11.5px/800; padding:4px 9px; border-radius:7px; background:var(--accentSoft); color:var(--accentInk)`.
    - Exception pill: `background:var(--panel3); color:var(--ink2)`, text "N exception" / "N exceptions".
  - Phone block `width:150px` (12.5px/600 `var(--ink2)`) over the schedule line (11.5px `var(--ink3)`, `mt:1px`), for example "6 days / week".
  - Status pill (`width:96px; text-align:center; 11.5px/800; padding:5px 9px; border-radius:8px`):
    - "Active": `accentSoft` bg / `accentInk` text.
    - "Invite sent": `rgba(194,116,11,.14)` bg / `#B45309` text.
    - "Inactive": `panel3` bg / `ink3` text.
  - Chevron-right icon: 18px, `stroke:var(--ink3)`, path `M9 6l6 6-6 6`.
- Empty: "No employees match." (`padding:40px; text-align:center; color:var(--ink3); font-weight:600`).

**Seed employees** (email auto = `first.toLowerCase()+'@oasisautospa.com'`; defaults: status active, type Full-time, payType Hourly, rate '', skills [], sched = Mon–Sat on):

| Id | Name | Title | Phone | Roles | Overrides |
|---|---|---|---|---|---|
| e1 | Amara Okoye | Owner | (305) 555-0101 | super | none |
| e2 | Rafael Mendes | General Manager | (305) 555-0140 | mgmt, acct | none |
| e3 | Marco Ruiz | Lead Detailer | (786) 555-0172 | crew | none |
| e4 | Lena Kim | Detailer | (305) 555-0119 | crew | none |
| e5 | Sofia Duarte | Front Desk | (786) 555-0133 | support, crew | `sched.override: allow` |
| e6 | Daniel Price | Bookkeeper | (305) 555-0188 | acct | none |
| e7 | Kevin Tran | Detailer | (786) 555-0151 | crew | none |

Extra fields:
- e1: payType Salary, skills Exotic vehicles.
- e2: payType Salary.
- e3: payType Commission, rate "30", skills Paint correction, Ceramic coating, Exotic vehicles.
- e4: rate "22", skills Interior detailing, schedule on for Sun and Tue–Sat (off Monday).
- e5: rate "21", skills Front desk.
- e6: type Part-time, rate "34", schedule Mon/Wed/Fri only.
- e7: status invited, rate "19", schedule Mon–Fri.

Default per-day schedule times: Sunday 9:00 AM–3:00 PM, Saturday 8:00 AM–5:00 PM, other days 8:00 AM–6:00 PM.

### 3.5 Employee drawer
**Header**: `flex:none; padding:20px 24px 0; background:var(--panel); border-bottom:1px solid var(--line)`.
- Top row (`display:flex; align-items:center; gap:14px`):
  - Avatar 54px (new employee shows "+").
  - Heading: Bricolage 700, 21px (`"First Last"` or "New employee").
  - Sub: 13px/600 `var(--ink2)`, `mt:2px`.
    - Existing: `"{title} · {role names joined ' + '}"`.
    - New: "They’ll get an SMS invite to set up their login."
  - Close button: 44×44, `border-radius:12px; background:var(--panel2); border:1px solid var(--line); color:var(--ink2)`, X icon 17px (`M6 6l12 12M18 6L6 18`, stroke 2.2).
- Tabs row (`display:flex; gap:4px; margin-top:16px`): "Profile", "Roles & access", "Schedule".
  - Each tab: `height:44px; padding:0 16px; font-size:14px; font-weight:700; border-bottom:3px solid transparent`.
  - Active: `color:var(--accentInk); border-bottom:3px solid var(--accent)`. Inactive: `color:var(--ink2)`.
  - The default tab on open is Profile.

**Body**: `flex:1; min-height:0; overflow-y:auto; padding:22px 24px`.

**Profile tab** (`isProfile`):
- Fields grid `grid-template-columns:1fr 1fr; gap:12px`. Five fields, so the sixth cell is empty.

  | Label | Placeholder |
  |---|---|
  | First name * | First |
  | Last name | Last |
  | Mobile * | (305) 555-0000 |
  | Email | name@oasisautospa.com |
  | Job title | e.g. Detailer |

  - Label: `12px/700 var(--ink2); mb:6px`.
  - Input: `width:100%; height:46px; padding:0 14px; border-radius:11px; border:1px solid var(--line) (#C2410C if invalid first/phone after a failed save); background:var(--panel); font-size:14px; font-weight:600`.
- "Employment": heading `12px/700 var(--ink2); margin:18px 0 7px`, then a seg of "Full-time" / "Part-time" / "Contractor". Default Full-time.
- "Pay": heading in the same style.
  - Row: `display:flex; gap:10px; align-items:center; flex-wrap:wrap`.
  - A seg of "Hourly" / "Commission" / "Salary", then a rate input (`width:140px; height:46px; padding:0 14px; border-radius:11px; font-size:14px; font-weight:700`).
  - Rate placeholders: Hourly "$ / hour"; Commission "% per job"; Salary "$ / year". The rate is a free text string.
- "Skills": heading, then chips with `gap:8px; flex-wrap:wrap`, multi-select: "Interior detailing", "Paint correction", "Ceramic coating", "Exotic vehicles", "Front desk", "Mobile service".

**Roles & access tab** (`isAccess`):
- Heading "Roles" (800, 15px) and sub "Assign one or more. Permissions combine." (12.5px/600 `var(--ink3)`, `margin:3px 0 12px`).
- Role options grid `1fr 1fr; gap:8px`. Each is a button:
  - `display:flex; align-items:flex-start; gap:10px; padding:12px; border-radius:12px; min-height:60px`.
  - On: `background:var(--accentSoft); border:1px solid var(--accentBrd)`. Off: `background:var(--panel); border:1px solid var(--line)`.
  - Checkbox: 22×22, `border-radius:7px; margin-top:1px`.
    - On: `background:var(--accent)`, with a 13px white check (`M5 12.5l4.5 4.5L19 7`, stroke 2.8).
    - Off: transparent with `border:2px solid var(--ink3)`.
  - Name (`800/13.5px`) over desc (`11.5px/600 var(--ink3); mt:1px`).
- Effective permissions:
  - Header row: `margin:22px 0 4px`. "Effective permissions" (800, 15px) at left. `"{n} of 27 allowed"` (12px/800 `var(--accentInk)`) at right.
  - Sub: "Use Allow or Deny to make an exception for this person only." (12.5px/600 `var(--ink3); mb:10px`).
  - Module label (11px/800 uppercase `var(--ink3)`, `ls .06em`, `margin:14px 0 6px`) followed by permission rows.
  - Row: `display:flex; align-items:center; gap:10px; padding:9px 12px; background:var(--panel); border:1px solid var(--line); border-radius:11px; margin-bottom:6px`.
    - Dot: 10×10, `var(--accent)` if allowed else `var(--line)`.
    - Label (`700/13px`) over source line (`11.5px/600 var(--ink3); mt:1px`).
    - A 3-button toggle group: `display:flex; gap:2px; padding:3px; background:var(--panel2); border:1px solid var(--line); border-radius:9px`.
      - Buttons "Role", "Allow", "Deny": `height:30px; padding:0 10px; border-radius:7px; font-size:11.5px; font-weight:800`.
      - Active: white text on a fill: Role `var(--ink2)`, Allow `var(--accent)`, Deny `#C2410C`. Inactive: transparent, `color:var(--ink3)`.
      - "Role" is active when there is no override.
  - Source labels (`eff`):
    - Deny override → "Exception · denied" (off).
    - Allow override → "Exception · allowed" + tail (on).
    - From roles → `"via {RoleA + RoleB}"` + tail (on).
    - Otherwise → "Not included in assigned roles" (off).
  - Tail (for `pay.refund`, `pay.adjust`, `pay.credit` only): `" · ≤ $N"` or `" · No limit"`.
    - The limit is the max across roles that grant the permission. Any null means "No limit". An Allow exception with no granting role defaults to "≤ $25".

**Schedule tab** (`isSched`):
- Note: "Availability used when assigning jobs and bays. Must sit inside business hours." (`12.5px/600 var(--ink3); mb:10px`). The constraint is not enforced in code.
- Rows (Mon–Sun): `display:flex; align-items:center; gap:12px; padding:10px 0; border-top:1px solid var(--line); flex-wrap:wrap; min-height:62px`.
  - Toggle (50×30), day name (`width:96px; 700/14px`).
  - If on: `‹ [from] ›  to  ‹ [to] ›`. Buttons are `36×42; border-radius:10px; panel bg; line border`; values are `min-width:74px; 800/13px`.
  - If off: "Off" (`700/13px var(--ink3)`).

**Footer**: `flex:none; padding:16px 24px; border-top:1px solid var(--line); background:var(--panel)`.
- Validation error (`dr.error`): `12.5px/700 #C2410C; mb:10px`.
  - "First name and mobile number are required." (switches to the Profile tab).
  - "Assign at least one role." (switches to the Roles & access tab).
  - Any draft edit clears it.
- Button row (`display:flex; align-items:center; gap:10px`):
  - Deactivate/Reactivate (only for existing employees): `height:50px; padding:0 16px; border-radius:13px; background:transparent; border:1px solid var(--line); font-weight:700; font-size:13.5px; color:#C2410C`. The label is "Deactivate" or "Reactivate" depending on whether the draft status is `inactive`.
  - Spacer `flex:1`.
  - "Cancel": `height:50px; padding:0 18px; border-radius:13px; background:var(--panel2); border:1px solid var(--line); font-weight:700; font-size:14px`.
  - Save: `height:50px; padding:0 24px; border-radius:13px; background:var(--accent); color:#fff; font-weight:800; font-size:14.5px`. The label is "Save changes" for existing and "Create & send invite" for new.
- On save:
  - existing: toast `"Saved {First} {Last}"`;
  - new: `id:'e'+Date.now()`, `status:'invited'`, toast `"Invite sent to {phone}"`.
- **Deactivate behaviour**: it only changes the draft status, to `inactive`. Reactivating sets it to `active`, even if the original status was `invited`. Nothing applies until Save.

**New-employee defaults**: roles `['crew']`, status invited, type Full-time, payType Hourly, rate '', skills [], overrides {}. Schedule is Mon–Fri on and Sat/Sun off, all days 8:00 AM–6:00 PM.

### 3.6 Roles & permissions (`secRoles`)
**Role cards**: `display:grid; grid-template-columns:repeat(auto-fill,minmax(190px,1fr)); gap:12px; margin-bottom:18px`.
- Card: `padding:15px; background:var(--panel2); border:1px solid var(--line); border-radius:14px`.
- Top row: name (800, 14.5px) and people count (11.5px/800 `var(--ink3)`, "1 person" / "N people").
- Desc: `12px/600 var(--ink2); mt:5px; line-height:1.4`.
- Count: `11.5px/800 var(--accentInk); mt:8px`, `"{n} of 27 permissions"`.

**Roles** (seeds):
| id | Name | Description | Locked |
|---|---|---|---|
| super | Super Admin | Owner level. Everything, including billing. | yes |
| mgmt | Management | Runs the shop day to day. | |
| acct | Accounting | Payments, refunds, credits and reports. | |
| support | Customer Support | Front desk, bookings and messaging. | |
| crew | Crew | Bay work: jobs, checklists, photos. | |

**Info note**: `display:flex; gap:10px; align-items:flex-start; padding:13px 15px; background:var(--panel2); border:1px solid var(--line); border-radius:12px; margin-bottom:16px; font-size:12.5px; font-weight:600; color:var(--ink2); line-height:1.5`.
- Info icon: 16px, `margin-top:2px`; circle plus `M12 8v5M12 16h.01`; `stroke:var(--ink3)`.
- Copy: "People with several roles get every permission from each role, and the highest money limit. Per-person exceptions are set on the employee's profile. Tap a limit chip to change it." Note the straight apostrophe in "employee's".

**Matrix**: wrapper `border:1px solid var(--line); border-radius:16px` with no `overflow:hidden`.
- Columns (`matrixCols`): `minmax(220px,1.6fr) repeat(N, minmax(96px,1fr))` where N is the role count.
- Sticky header: `display:grid; position:sticky; top:-22px; z-index:2; background:var(--panel2); border-bottom:1px solid var(--line); border-radius:16px 16px 0 0`. The `-22px` offsets the body's top padding.
  - First cell "Permission": `padding:14px 16px; 11px/800 uppercase ls .06em var(--ink3)`.
  - Role cells: `padding:10px 6px; text-align:center; flex column; gap:3px`. Role name `800/12.5px; line-height:1.2`. Under it:
    - "LOCKED" (10px/800 `var(--ink3)`) for locked roles;
    - "REMOVE" (10px/800 `#C2410C`, a button) for custom roles.
- Module group label row: `padding:10px 16px; background:var(--panel2); border-top:1px solid var(--line); 11px/800 uppercase ls .06em var(--ink3)`.
- Permission row: `display:grid; matrixCols; border-top:1px solid var(--line2); align-items:center`.
  - Label cell: `padding:12px 16px; 700/13.5px`.
  - Role cell: `flex column; align-items:center; gap:5px; padding:9px 4px`.
    - Checkbox button 36×36, `border-radius:10px`.
      - On: `background:var(--accent)`, white check (15px, `M5 12.5l4.5 4.5L19 7`, stroke 2.8).
      - Off: transparent with `border:2px solid var(--line)`.
      - Locked role on: `background:var(--panel3); color:var(--ink2)` with `cursor:not-allowed`.
    - Limit chip (only for the three money permissions, and only when on): `font-size:11px; font-weight:800; padding:3px 7px; border-radius:6px; background:var(--panel2); border:1px solid var(--line); color:var(--ink2); white-space:nowrap`. Label "≤ $N" (en-US thousands separator) or "No limit".
      - Click cycles through 25 → 50 → 100 → 250 → 500 → 1000 → No limit → 25.

**Permission catalogue** (27 items, ids and verbatim labels). The 🔒 marker is not used in the design; items marked "limit" show chips.

| Module | id: label |
|---|---|
| Schedule & jobs | sched.view: View schedule & calendar; sched.edit: Create & edit appointments; sched.cancel: Cancel & mark no-shows; sched.override: Override bay capacity; jobs.status: Move jobs between stages; jobs.checklist: Complete checklists & photos |
| Clients | cli.view: View client files; cli.contact: See phone & email; cli.edit: Edit client & vehicle details; cli.export: Export client data; cli.member: Manage memberships & VIP |
| Payments | pay.collect: Collect payments; pay.refund: Issue refunds (limit); pay.adjust: Apply adjustments & discounts (limit); pay.credit: Issue account credits (limit); pay.void: Void transactions; pay.reports: View payment reports |
| Messaging | msg.send: Message customers; msg.auto: Edit automations & templates; msg.broadcast: Send offers & broadcasts |
| Team | team.view: View team; team.edit: Add & edit employees; team.roles: Assign roles & permissions |
| Settings | set.hours: Working hours & holidays; set.emergency: Emergency closing; set.services: Services, pricing & checklists; set.billing: Billing & integrations |

**Default grants**:
- super: all 27.
- mgmt: all except `set.billing` (26).
- acct (13): sched.view, cli.view, cli.contact, cli.export, cli.member, pay.collect, pay.refund, pay.adjust, pay.credit, pay.void, pay.reports, team.view, set.billing.
- support (13): sched.view, sched.edit, sched.cancel, cli.view, cli.contact, cli.edit, cli.member, pay.collect, pay.refund, pay.adjust, pay.credit, msg.send, team.view.
- crew (4): sched.view, jobs.status, jobs.checklist, cli.view.

**Default limits** (refund / adjust / credit):
- super: no limit / no limit / no limit.
- mgmt: 1000 / 500 / 500.
- acct: 500 / 250 / 250.
- support: 50 / 25 / 50.
- crew: 25 / 25 / 25.

**Behaviour**:
- Locked role toggle: toast "Super Admin always has every permission". Its chip click does nothing.
- "Custom role" head button:
  - creates a role named "Shift Lead", desc "Custom role — starts from Crew.", `custom:true`;
  - permissions are Crew's plus `sched.edit`, with all limits 25;
  - toast "Custom role added — adjust its permissions below".
- Every click on "Custom role" adds another role named "Shift Lead". There is no rename.
- REMOVE: deletes the role and its permissions and limits, strips the role from every employee, and toasts `"{name} removed"`. There is no confirm.

### 3.7 VIP program (`secVip`)
Two-column grid.

**Left column**:
1. **Reserved VIP slots** tile.
   - Title "Reserved VIP slots".
   - Sub: "Prime times only VIP clients can book. If no VIP takes one, it opens to everyone before the slot." (`12.5px/600 var(--ink3); margin:3px 0 14px; line-height:1.45`).
   - Hold rows (`gap:8px`): `display:flex; align-items:center; gap:12px; padding:10px 12px; background:var(--panel); border:1px solid var(--line); border-radius:12px`.
     - "VIP" chip: `10.5px/800; padding:3px 8px; border-radius:6px; background:#7A3B8A; color:#fff`.
     - Label `"{Day} · {time}"` (`flex:1; 700/14px`).
     - ✕ button 40×40, `border-radius:10px; background:var(--panel2); border:1px solid var(--line); color:var(--ink3)`. It removes the hold with no toast.
   - Add row: `display:flex; align-items:center; gap:8px; margin-top:12px; flex-wrap:wrap; font-weight:700; font-size:13.5px`.
     - `‹ [Day] ›` (value `min-width:92px`) and `‹ [Time] ›` (value `min-width:76px`). Buttons are 38×44, `border-radius:10px; panel bg; line border`.
     - "Add hold": `height:44px; padding:0 16px; border-radius:11px; background:var(--accent); color:#fff; font-weight:800; font-size:13px`.
   - Defaults are Saturday and 11:00 AM. The day stepper wraps Sun–Sat in order; the time stepper uses 30-minute steps.
   - A duplicate toasts "That slot is already held"; success toasts `"{Sun|Mon|…} {time} held for VIPs"`.
   - "Release unbooked holds to everyone": `12.5px/700 var(--ink2); margin:18px 0 7px`, then a seg "24h before" / "48h before" / "72h before". Default 48.
   - Seeded holds: Sat 8:00 AM, Sat 9:00 AM, Sat 10:00 AM, Fri 4:00 PM, Sun 9:00 AM.
   - Display sort is Monday-first by day, then time, giving Fri 4:00 PM, Sat 8/9/10 AM, Sun 9:00 AM.
2. **VIP clients** tile.
   - Header: "VIP clients" and `"{n} clients"` (12px/800 `var(--ink3)`). It has no singular form.
   - Rows: `padding:10px 0; border-top:1px solid var(--line)`. Name (`flex:1; 700/14px`) plus a "Remove" button (`height:36px; padding:0 12px; border-radius:9px; background:var(--panel); border:1px solid var(--line); font-weight:700; font-size:12px; color:var(--ink2)`).
   - Add row (`gap:8px; margin-top:10px`): input (placeholder "Client name", `height:44px; padding:0 14px; border-radius:11px; font-size:14px; font-weight:600; flex:1`) and "Make VIP" (`height:44px; padding:0 16px; border-radius:11px; background:#7A3B8A; color:#fff; font-weight:800; font-size:13px`).
   - Blank names are ignored; there is no duplicate check; toast `"{name} is now VIP"`.
   - Seeds: Jonathan Franco, Liam Chen, Aisha Rahman, Elena Volkov.

**Right column**:
3. **Steppers tile**: tile with `padding:6px 18px`. Rows `display:flex; align-items:center; gap:14px; padding:14px 0; border-bottom:1px solid var(--line)`. Label (`700/14px`) over sub (`12px/600 var(--ink3); mt:2px`), then `−` button, value, `+` button.
   - Buttons: 40×44, `border-radius:10px; panel bg; line border; font-weight:800`.
   - Value: `min-width:64px; text-align:center; 800/14px`.

   | Label | Sub | Default | Range | Step | Display |
   |---|---|---|---|---|---|
   | VIP booking window | How far ahead VIPs can book | 30 | 7–90 | 7 | "30 days" |
   | Standard booking window | Everyone else | 14 | 7–60 | 7 | "14 days" |
   | Same-day guarantee | Per VIP, per month — we fit them in even when full | 2 | 0–8 | 1 | "2 / mo" |

4. **Toggles + options tile**: tile with `padding:6px 18px`.
   - Toggle rows (same layout as above; all default on):
     - "Waitlist priority" / "Cancellations are offered to VIPs first".
     - "Standing appointments" / "VIPs can set a repeating slot".
     - "Auto-confirm standing visits" / "Confirmed 48h before without a reply".
   - "Waitlist: VIPs get first claim for" (`12.5px/700 var(--ink2); margin:14px 0 7px`) over a seg "10 min" / "15 min" / "30 min". Default 15.
   - "Standing appointment cadences offered" (same label style) over chips (multi-select, `gap:8px; margin-bottom:16px`): "Weekly", "Every 2 weeks", "Every 3 weeks", "Monthly". Defaults Weekly, Every 2 weeks, Monthly.

### 3.8 Arrival & check-in (`secArrival`)
- Banner: `display:flex; align-items:center; gap:12px; padding:14px 16px; background:var(--accentSoft); border:1px solid var(--accentBrd); border-radius:14px; margin-bottom:18px; color:var(--accentInk); font-size:13.5px; font-weight:700`. Copy: "Applies to every client who has the app and allows location, not only VIPs."
- Two-column grid.
- **Left tile**: `padding:6px 18px 18px`. Toggle rows (`padding:14px 0; border-bottom:1px solid var(--line)`), all default on:

  | Label | Sub |
  |---|---|
  | Geofence auto check-in | Turn off to require check-in at the desk |
  | Mark as Arrived automatically | Job moves to Arrived on the Operations screen |
  | Send welcome message | “You’re checked in — pull into Bay 2” |
  | Alert the crew | Push notification to whoever is on shift |
  | VIP arrivals first | VIP arrivals sit at the top of alerts |

  - Then "Check-in radius" (label `12.5px/700 var(--ink2); margin:16px 0 7px`) over a seg "150 m" / "300 m" / "500 m" (default 300).
  - Then "Prep-bay alert when ETA is" over a seg "10 min away" / "15 min away" / "20 min away" (default 15).
- **Right tile** ("What happens", `padding:18px`): title `margin-bottom:12px`. Step rows `display:flex; gap:12px; padding:10px 0`.
  - Number badge: 28×28, `border-radius:9px; background:var(--accent); color:#fff; 800/13px`.
  - Title `800/13.5px`; desc `12.5px/600 var(--ink2); mt:2px; line-height:1.45`.
  - Step 1: "{prepAt} min out" / "Operations gets an “Arriving” alert with a Prep bay button. VIPs show in purple at the top."
  - Step 2: "Within {radius} m" / `(autoArrive ? "Checked in automatically and the job moves to Arrived. " : "Staff confirm the check-in. ") + (welcome ? "Customer gets a welcome message." : "")`. The trailing space is in the source.
  - Step 3: "Ready to start" / "Crew sees “Auto checked in” with a Start cleaning button."
  - The "Geofence auto check-in" toggle does not change this text.

### 3.9 Packages & checklists (`secServices`)
Grid: `grid-template-columns:280px minmax(0,1fr); gap:18px; align-items:start`.

**Left list tile**: `padding:12px`.
- Seg "Packages" / "Add-ons" (`margin-bottom:10px`).
  - "Packages" selects the second package ("Premium Hand Wash + Interior").
  - "Add-ons" selects the first add-on ("Interior deep clean").
- List (`gap:4px`), one button per item:
  - `display:flex; align-items:center; gap:8px; width:100%; min-height:44px; padding:0 12px; border-radius:10px`.
  - Selected: `background:var(--panel); border:1px solid var(--line); color:var(--ink)`. Unselected: transparent with a transparent border and `color:var(--ink2)`.
  - Name `flex:1; text-align:left; 700/13.5px`; count `11.5px/800 var(--ink3)` (task count).

**Editor tile**: `padding:20px; min-width:0`.
- Kind tag: `10.5px/800; padding:4px 8px; border-radius:6px; uppercase; ls .04em`.
  - "Package": `accentSoft` bg / `accentInk` text.
  - "Add-on": `rgba(176,121,8,.15)` bg / `#8A5A06` text.
- Name: Bricolage 700, 21px, `mt:8px`.
- Meta: `13px/600 var(--ink2); mt:3px`.
  - Packages: `"${price} · {dur} min · {n} tasks"`, for example "$129 · 75 min · 7 tasks".
  - Add-ons: `"+${price} · {n} tasks"`, for example "+$60 · 3 tasks".
  - Price and duration are not editable in this screen. Only checklist tasks are.
- Note: `margin:16px 0; padding:12px 14px; background:var(--accentSoft); border:1px solid var(--accentBrd); border-radius:12px; 12.5px/700 var(--accentInk); line-height:1.5`.
  - Package: "Every job booked with this package starts with these tasks. Selected add-ons append their own tasks underneath."
  - Add-on: "When this add-on is on a job — booked, approved in the app, or added at the desk — these tasks are appended to the job checklist."
- Task rows (`display:flex; flex-direction:column; gap:8px`; each row `display:flex; align-items:center; gap:8px`):
  - Number: `width:26px; text-align:center; 800/12.5px var(--ink3)`.
  - Input: `flex:1; min-width:0; height:46px; padding:0 14px; border-radius:11px; border:1px solid var(--line); background:var(--panel); 14px/600`. It saves on every keystroke.
  - Buttons: ↑ (`title="Move up"`, `color:var(--ink2)`), ↓ (`title="Move down"`, `color:var(--ink2)`), ✕ (`title="Remove"`, `color:#C2410C`). Each is 40×44, `border-radius:10px; panel bg; line border`.
  - Up/down at the ends do nothing. Remove has no confirm. There is no minimum task count and no drag.
- Add row: `display:flex; gap:8px; margin-top:12px; padding-left:34px`.
  - Input: placeholder "Add a task…", `height:46px; border:1.5px dashed var(--line); border-radius:11px; flex:1`. Enter key adds.
  - "Add task": `height:46px; padding:0 18px; border-radius:11px; background:var(--accent); color:#fff; font-weight:800; font-size:13.5px`.
  - A blank trim is ignored.
- Edits persist to localStorage `oasis-checklists` as `{packages:{name:tasks[]}, addons:{name:tasks[]}}`.

**Catalogue** (price / duration; tasks in order):
- **Express Hand Wash** ($45 / 35 min): Exterior rinse; Hand wash; Wheel cleaning; Hand dry & towel; Glass & windows.
- **Premium Hand Wash + Interior** ($129 / 75): Exterior pre-rinse; Two-bucket hand wash; Wheel & tire cleaning; Tire shine; Interior vacuum; Dashboard & console wipe; Streak-free windows.
- **Premium Hand Wash + Interior Refresh** ($139 / 75): Exterior pre-rinse; Two-bucket hand wash; Wheel & tire cleaning; Tire shine; Interior vacuum; Dashboard & vents wipe; Leather seat refresh; Streak-free windows.
- **Executive Detail** ($260 / 90): Foam pre-soak; Two-bucket hand wash; Clay bar treatment; Wheel & caliper detail; Tire dressing; Full interior vacuum; Leather conditioning; Dashboard & vents detail; Streak-free glass; Spray sealant.
- **Executive Detail + Ceramic** ($420 / 120): Foam pre-soak; Two-bucket hand wash; Iron decontamination; Clay bar treatment; Ceramic spray coat; Wheel & caliper detail; Full interior detail; Leather conditioning; Streak-free glass.
- **Full Detail** ($320 / 120): Engine bay degrease; Foam pre-soak; Hand wash; Clay bar; Wheel deep clean; Carpet shampoo; Full interior vacuum; Leather treatment; Glass polish; Wax & seal.
- **Ceramic Maintenance + Wax** ($180 / 60): Pre-rinse; pH-neutral hand wash; Ceramic boost spray; Hand-applied wax; Wheel cleaning; Tire dressing; Glass treatment.
- **Exotic Detail Package** ($650 / 150): Waterless decon; Two-bucket hand wash; Paint correction pass; Ceramic seal; Wheel & caliper detail; Full interior detail; Leather conditioning; Glass & trim restore; Photographic handover.
- **Family Wash + Pet Hair** ($95 / 50): Exterior rinse; Hand wash; Pet hair removal; Interior vacuum; Dashboard wipe; Windows; Odor neutralize.

Add-ons (price; tasks):
- **Interior deep clean** (+$60): Deep vacuum seats & carpets; Steam clean vents & cupholders; Wipe door jambs & panels.
- **Pet hair removal** (+$35): Rubber-brush pet hair; Lint-roll upholstery; Vacuum seat seams.
- **Leather conditioning** (+$45): Clean leather surfaces; Apply conditioner; Buff to matte finish.
- **Wax** (+$40): Apply carnauba wax; Buff off haze.
- **Clay bar** (+$50): Lubricate panels; Clay bar paint; Wipe residue.
- **Odor removal** (+$30): Enzyme treatment on fabrics; Odor neutralizer cycle.
- **Engine bay cleaning** (+$55): Cover electricals; Degrease engine bay; Dress plastics.
- **Ceramic maintenance** (+$120): Ceramic boost spray; Buff & level coating.
- **Rain repellent** (+$25): Clean glass; Apply rain repellent to windshield.
- **Wheel deep clean** (+$40): Remove wheel fallout; Clean barrels & calipers; Seal wheel faces.

---

## 4. Interaction map

### Global
- Theme toggle → flips theme and writes `oasis-theme`.
- Rail buttons → set `section` to `hours | closures | emergency | employees | roles | vip | arrival | services`.
- Head button → per section:
  - closures: open the new-closure form (resets `nc`, `ncError`).
  - employees: open the drawer for a new employee.
  - roles: add a custom role.
- No handler exists for Escape, focus trapping, or anywhere else.

### Working hours
| Control | Handler |
|---|---|
| Day toggle | flips that day's `open` |
| Stepper ‹ / › (from, to) | ±30 min via `step`, clamp 5:00 AM–11:30 PM |
| Copy Monday to weekdays | copies Monday onto Tue–Fri |
| Booking-rule segs | set `rules.slot` / `buffer` / `cutoff` (in-memory only) |
| Discard | restore `savedHours` |
| Save changes | persist `oasis-hours`, reset baseline, toast |

### Closures
| Control | Handler |
|---|---|
| Date input (`on-input`) | sets `nc.date` |
| Name input (`on-input`) | sets `nc.name` |
| Closed all day / Reduced hours | sets `nc.type` |
| ‹ › from / to | ±30 min on `nc.from` / `nc.to` |
| Cancel | closes the form |
| Add closure | validate, persist, toast |
| Auto-add toggle | flips `federal` (state only) |
| Notify toggle | flips and persists `notify` |
| Trash | removes immediately and toasts |

### Emergency
| Control | Handler |
|---|---|
| Reason chips | set `em.reason` |
| Close-for seg | sets `em.dur` |
| Reopen-at ‹ › | ±30 min on `em.until` |
| Closed-through date (`on-input`) | sets `em.through` |
| Message textarea (`on-input`) | sets `em.msg` |
| Option toggles | flip `notify`, `link`, `credits`, `pause`, `crew` |
| Close the shop now | opens the confirm dialog |
| Dialog overlay or Cancel | `cancelClose` |
| Confirm closure | `doClose` |
| Reopen now | `reopen` |

### Employees
| Control | Handler |
|---|---|
| Search (`on-input`) | sets `empQuery` |
| Role chips | set `roleFilter` |
| Row click | `openEmp(e)` (deep-clones the employee into `draft`) |

### Employee drawer
| Control | Handler |
|---|---|
| Overlay or X or Cancel | `closeDrawer` (discards the draft) |
| Panel body | stops propagation |
| Tabs | set `drTab` |
| Field inputs (`on-input`) | `setDraft`; also clears `drError` |
| Employment / Pay segs | set `type` / `payType` |
| Rate input (`on-input`) | sets `rate` |
| Skill chips | toggle membership in `skills` |
| Role options | toggle membership in `roles` |
| Role / Allow / Deny | set or clear `overrides[pid]` |
| Schedule toggle | flips `sched[d].on` |
| Schedule ‹ › | ±30 min on that day's from/to |
| Deactivate / Reactivate | toggles draft `status` between `inactive` and `active` |
| Save | validate, then update the list in memory and toast |

### Roles
| Control | Handler |
|---|---|
| Permission checkbox | toggles the permission for that role, and persists. If the role is locked it only toasts |
| Limit chip | cycles through `LIMITS` and persists. Silent no-op for locked roles |
| REMOVE | removes the role, strips it from employees, toasts |

### VIP
| Control | Handler |
|---|---|
| Hold ✕ | removes the hold |
| Day ‹ › | wraps Sun–Sat |
| Time ‹ › | ±30 min |
| Add hold | duplicate check, add, toast |
| Release seg | sets `release` |
| Steppers − / + | clamp to min/max with the step shown in §3.7 |
| Toggles | flip `waitlist`, `standing`, `autoConfirm` |
| Offer seg | sets `offerMin` |
| Cadence chips | toggle in `cadences` |
| Client Remove | removes by name |
| Client name input (`on-input`) | sets `vipNew` |
| Make VIP | adds, clears the input, toasts |

All VIP changes persist immediately to `oasis-vip {vip, arrival}`.

### Arrival
- Toggles flip `on`, `autoArrive`, `welcome`, `crew`, `vipFirst`.
- Radius seg sets `radius` (150 / 300 / 500).
- Prep seg sets `prepAt` (10 / 15 / 20).
- All persist immediately.

### Packages & checklists
| Control | Handler |
|---|---|
| Packages / Add-ons seg | switch kind and reset the selection |
| List item | selects it |
| Task input (`on-input`) | edits and persists |
| ↑ / ↓ | swap with neighbour |
| ✕ | remove |
| Add input (`on-input`) | sets `newTask` |
| Add input (`on-key-down`) | Enter adds |
| Add task button | adds |

---

## 5. View-model contract

Bindings are shown by section. `sc-for` item shapes are in parentheses. `style` values are inline-style objects from the helper functions in §2.

### Global
- `theme`, `toggleTheme`.
- `nav.{hours,closures,emergency,employees,roles,services,vip,arrival}` (style objects).
- `goHours`, `goClosures`, `goEmergency`, `goEmployees`, `goRoles`, `goServices`, `goVip`, `goArrival`.
- `emActive` (rail pill and emergency banner).
- `empCount`.
- `secTitle`, `secDesc`.
- `hasHeadBtn`, `headBtnLabel`, `headBtn`.
- `secHours`, `secClosures`, `secEmergency`, `secEmployees`, `secRoles`, `secVip`, `secArrival`, `secServices`.
- `hoursDirty`, `discardHours`, `saveHours`.
- `toast`.
- `drawerOpen`, `confirmOpen`.
- `stop`.

### Working hours
- `copyWeekdays`.
- `hourRows` (`{day, open, closed, from, to, len, track, knob, toggle, fromDec, fromInc, toDec, toInc}`).
- `ruleRows` (`{label, opts:[{label, onClick, style}]}`).
- `weekHours`.

### Closures
- `addingClosure`.
- `nc` (`{date, name, type, from, to}`), `ncDate`, `ncName`.
- `ncClosed`, `ncClosedStyle`, `ncReduced`, `ncReducedStyle`, `ncIsReduced`.
- `ncFromDec`, `ncFromInc`, `ncToDec`, `ncToInc`.
- `ncAffected`, `ncError`.
- `cancelClosure`, `addClosure`.
- `federalSw` (`{track, knob}`), `toggleFederal`.
- `upcoming` (`{mon, day, dow, name, typeLabel, tagStyle, sub, track, knob, toggleNotify, remove}`).
- `past` (`{mon, day, name, typeLabel, tagStyle}`).

### Emergency
- `emActive`, `emIdle`.
- `emSummary`, `emNotified`, `emRebooked`, `emBooking`.
- `reopen`.
- `emReasons` (`{label, onClick, style}`), `emDurations` (same shape).
- `emIsUntil`, `emUntil`, `emUntilDec`, `emUntilInc`.
- `emIsDays`, `emThrough`, `emThroughSet`.
- `emMsg`, `emMsgSet`, `emPreview`.
- `emOpts` (`{label, sub, track, knob, toggle}`).
- `emAffected` (`{time, name, veh}`), `emAffectedCount`.
- `askClose`, `cancelClose`, `doClose`, `confirmText`.
- `emHistory` (`{date, reason, detail}`).

### Employees
- `empQuery`, `empSearch`.
- `roleFilters` (`{label, onClick, style}`).
- `empRows` (`{name, initials, title, type, phone, sched, roles:string[], hasOverrides, overrides, avatar, status, statusStyle, open}`).
- `noEmp`.

### Drawer (`dr`)
- `heading`, `sub`, `initials`, `avatar`.
- `tProfile`, `tAccess`, `tSched`, and `tabProfile`, `tabAccess`, `tabSched`.
- `isProfile`, `isAccess`, `isSched`.
- `fields` (`{label, value, ph, set, style}`).
- `types`, `pays`, `skills` (`{label, onClick, style}`).
- `rate`, `ratePh`, `setRate`.
- `roleOpts` (`{name, desc, on, onClick, style, box}`).
- `effCount`.
- `effGroups` (`{mod, rows:[{label, src, dot, inherit, allow, deny, sInherit, sAllow, sDeny}]}`).
- `sched` (`{day, on, off, from, to, track, knob, toggle, fromDec, fromInc, toDec, toInc}`).
- `error`, `canDeactivate`, `activeLabel`, `saveLabel`.
- `toggleActive`, `saveEmp`, `closeDrawer`.

### Roles
- `roleCards` (`{name, desc, people, count}`).
- `matrixCols`.
- `roleCols` (`{name, locked, custom, remove}`).
- `permGroups` (`{mod, rows:[{label, cells:[{on, hasLimit, limitLabel, box, limitStyle, toggle, cycle}]}]}`).

### VIP
- `vipHolds` (`{label, remove}`).
- `holdDay`, `holdDayDec`, `holdDayInc`, `holdTime`, `holdTimeDec`, `holdTimeInc`, `addHold`.
- `releaseOpts`, `offerOpts`, `cadenceOpts` (`{label, onClick, style}`).
- `vipSteppers` (`{label, sub, val, dec, inc}`).
- `vipToggles` (`{label, sub, track, knob, toggle}`).
- `vipClients` (`{name, remove}`), `vipCount`.
- `vipNew`, `vipNewSet`, `addVip`.

### Arrival
- `arrToggles` (`{label, sub, track, knob, toggle}`).
- `radiusOpts`, `prepOpts` (`{label, onClick, style}`).
- `arrSteps` (`{n, title, desc}`).

### Services
- `kindPkg`, `kindPkgStyle`, `kindAddon`, `kindAddonStyle`.
- `svcList` (`{name, count, onClick, style}`).
- `svcKindStyle`, `svcKindLabel`, `svcName`, `svcMeta`, `svcNote`.
- `tasks` (`{n, label, edit, up, down, remove}`).
- `newTask`, `newTaskSet`, `newTaskKey`, `addTask`.

### State-shape hints for the backend
- **hours**: array of 7 `{open, from, to}`, indexed Sunday = 0.
- **rules**: `{slot, buffer, cutoff}`.
- **closure**: `{date, name, type:'closed'|'reduced', from, to, notify, emergency?}`.
- **emergency**: `{active, summary, reason, dur:'today'|'until'|'days', until, through, notify, link, credits, pause, crew, msg}`.
- **history**: `{date, reason, detail}`.
- **employee**: `{id, first, last, title, phone, email, roles[], status:'active'|'invited'|'inactive', type, payType, rate, skills[], sched[7]:{on, from, to}, overrides:{[permId]:'allow'|'deny'}}`.
- **roles**: `{id, name, desc, locked?, custom?}` plus `perms[roleId][permId]:boolean` and `limits[roleId]:{refund, adjust, credit}` where each limit is a number or null.
- **vip**: `{holds:[{d, t}], release, windowVip, windowStd, sameDay, waitlist, offerMin, standing, autoConfirm, cadences[], clients[]}`.
- **arrival**: `{on, radius, prepAt, autoArrive, welcome, crew, vipFirst}`.
- **checklists**: `packages[name] = {price, dur, tasks[]}` and `addons[name] = {price, tasks[]}`.

---

## 6. Fidelity risks

**Faked or hard-coded values the backend must replace**
- TODAY is fixed at `'2026-06-13'` and treated as Saturday. It drives the Upcoming/Past split, the new-closure warning and the history date ("Jun 13, 2026").
- Idle emergency banner "Open now · Saturday 8:00 AM – 5:00 PM · 6 appointments left today, 3 vehicles on site" is static.
- "Requires Management or Super Admin · you have access" is static. The user chip "Rafael M. / Management · Accounting" is static.
- `emRebooked` is always "2". The reopen history detail always says "6 notified", even when notify is off.
- Closure sub-line counts (`day%4`, `day%3`) and the new-closure warning count (`day%5 + 2`) are fake.
- The affected-appointments list is a fixed six-row array. "Multiple days" mode ignores future days.
- The preview recipient "Liam" and link "oasis.spa/r/8KQ2" are fixed.
- "Auto-confirm … 48h" copy is fixed text and does not reflect any setting.
- "Pull into Bay 2" in the welcome message sub is fixed text.

**Logic gaps in the design (silent or ambiguous)**
- Only working hours use a Save/Discard bar. Everything else persists immediately in the mock.
- The Booking rules (slot, buffer, cutoff) and the federal-holiday toggle are not part of dirty detection and are not persisted.
- Employees and emergency history are not persisted. They reset on reload.
- Dirty hours stay in memory when you leave the Hours section. The bar disappears because it only shows on `section==='hours'`, but the edits remain.
- Emergency Confirm closure does not create a history row and does not add the emergency entry to the closures list. The seed closure "Weather closure" (2026-06-03, `emergency:true`) shows that an emergency should appear there. This is ambiguous.
- Nothing validates that from is before to (hours, reduced hours, drawer schedule). The "Must sit inside business hours" copy is not enforced.
- The role filter stays selected after its role is removed, which leaves an empty list.
- Custom roles are always named "Shift Lead" with no rename and no limit on count.
- Deactivate then Reactivate turns an "invited" employee into "active".
- VIP clients are plain name strings with no link to a client record and no duplicate check.
- Singular forms are missing: "1 clients", "1 customers".
- Past closures cannot be edited or removed. Upcoming rows are only removable, not editable, despite the copy "Edit or remove any of them below".
- Package price and duration are shown but have no edit control.
- The "Reduced · {from} – {to}" values are stored on closed-type closures too.

**CSS and visual traps**
- The warning banner colours (`#FBEFD9`, `#F0D9A6`, `#8A5A12`) are not themed and will look wrong in dark mode. The same applies to the other hard-coded tints.
- Native `<input type="date">` has no `color-scheme` set. The calendar icon and popup will be mismatched in dark mode.
- The root `data-theme` is on the inner div, not `html`. Body background uses the `:root` (light) tokens, so in dark mode only overscroll shows light. Put the theme attribute on `html` in the real build.
- The matrix has no `overflow:hidden` so the sticky header works. The header carries its own top radii. The sticky `top:-22px` depends on the body's 22px top padding, so changing that padding breaks the sticky offset.
- The matrix has a minimum width of 220 + N×96px. With 5 roles that is 700px; custom roles widen it and the body scrolls horizontally.
- The weekly schedule's `grid-column:span 2` produces an extra implicit column in narrow viewports.
- The Weekly-schedule top border sits directly under the card title, so the first row has a divider above it.
- Pill, tag and chip sizes are specified in half-pixels (10.5, 11.5, 12.5, 13.5, 14.5). Do not round.
- Font weights 600/700/800 for Manrope and 700 for Bricolage must be loaded. Substituting a variable font without those weights changes the density noticeably.
- `font-feature-settings:'tnum'` is global, so digits are tabular everywhere. Easy to drop by accident.
- `letter-spacing:-0.01em` is global and `-0.02em` on display text.
- Avatar tints use `color-mix(in oklab, …)`. Older browsers will not render them.
- The `‹ ›` and `−` `+` `↑ ↓ ✕` controls are text glyphs (not SVG) in several places, while the working-hours steppers use SVG chevrons. Both patterns must be kept as they are.
- There is no hover or active state anywhere except link colour. Do not add any, if the design is to be followed literally.
- Drawer and dialog appear instantly with no animation. Toast has no fade.
- Only text inputs have a focus style (accent border). Buttons rely on the browser default.
- No `@media` rules exist. Responsiveness comes only from `auto-fit` / `auto-fill` grids, so layout below about 1100px width is untested in the design.
- Date strings are built with `new Date(date+'T12:00:00')` to dodge timezone shifts. Server-side logic should treat dates as plain local dates.

**Data notes for the plan**
- Each employee's email is derived from the first name in the seeds, but the drawer treats it as editable, and a new employee starts with an empty email.
- Stored time strings use the 12-hour "h:mm AM/PM" format. The backend should store minutes or 24-hour times and format on output, but the 30-minute steps, the 5:00 AM–11:30 PM clamp and the display format must be reproduced.
- Weekday order is Sunday-indexed (0–6) in data and Monday-first in display (`ORDER=[1,2,3,4,5,6,0]`). VIP holds sort Monday-first too.
- Money limits use the ordered scale `[25,50,100,250,500,1000,null]`, where null means no limit.