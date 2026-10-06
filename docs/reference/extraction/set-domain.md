<!-- Reference material generated during planning (2026-10-06) from the three Claude Design prototypes. Source of truth for the build; see docs/plan.md. -->

# Oasis Settings: domain, data and business-logic spec

All values below come from the Settings prototype's script block (`class Component extends DCLogic`) and its markup. Where the prototype is silent or fakes a value, that is stated. Everything in the prototype is front-end only. State lives in React-like `state`, and selected parts persist to `localStorage`. The backend must replace both the fixtures and the faked numbers.

**Global conventions in the source**
- Hard-coded "today" is `TODAY='2026-06-13'` (a Saturday). The hard-coded signed-in user is "Rafael M." (initials `RM`, `Management · Accounting`), who is employee `e2`.
- Times are strings in the form `h:mm AM/PM`, with no zero-padding on the hour (for example `9:00 AM`). Parsing and formatting use `parseT` and `fmtT`. Every time stepper moves in 30-minute steps, clamped to 300 minutes (5:00 AM) and 1410 minutes (11:30 PM).
- Day indexes are JS style: 0 = Sunday through 6 = Saturday. `DAYS=['Sunday',…,'Saturday']`. The display order in hours and schedule lists is `ORDER=[1,2,3,4,5,6,0]`, which is Monday to Sunday.
- Section title and description (`META`), plus the sidebar structure:

| Sidebar group | Items |
|---|---|
| Business | Working hours, Holidays & closures, Emergency closing (with an `ACTIVE` badge when an emergency is active) |
| Team | Employees (shows an employee count), Roles & permissions |
| Clients | VIP program, Arrival & check-in |
| Services | Packages & checklists |

| Section | Title | Description |
|---|---|---|
| hours | Working hours | Weekly opening hours and booking rules. |
| closures | Holidays & closures | Planned closed days and reduced hours. Booked customers are notified automatically. |
| emergency | Emergency closing | Close immediately, notify affected customers and pause booking. |
| employees | Employees | Create team members, assign roles and set schedules. |
| roles | Roles & permissions | What each role can see and do, including money limits. |
| vip | VIP program | Booking priority for VIP clients. Built around saving them time. |
| arrival | Arrival & check-in | Geofence check-in and bay prep for every client. |
| services | Packages & checklists | Checklist tasks for each package and add-on. Jobs combine both automatically. |

- The top bar has nav links to Operations, Payments and Settings, a theme toggle, and the user chip.
- Header buttons by section: closures shows "Add closure", employees shows "Add employee", roles shows "Custom role". The other sections have none.
- Deep link: if `location.hash === '#emergency'`, the page opens on the Emergency section. Operations presumably links here.
- Toasts last 2800 ms. All toast strings are collected in section 2.
- Theme tokens are `data-theme="light|dark"`, stored in `localStorage['oasis-theme']`:
  - Light: `--bg:#ECEBE4; --bg2:#F4F3EE; --panel:#FFFFFF; --panel2:#F5F4EF; --panel3:#EEEDE6; --ink:#18211E; --ink2:#5C645F; --ink3:#949A94; --line:#E2E0D7; --line2:#EDEBE3; --accent:#0E7A63; --accentInk:#0A5C49; --accentSoft:#DCEEE8; --accentBrd:#BFE0D5; --shadow:0 1px 2px rgba(24,33,30,.04),0 6px 22px rgba(24,33,30,.07); --shadowLg:0 24px 70px rgba(24,33,30,.22)`
  - Dark: `--bg:#0C100E; --bg2:#10150F; --panel:#161E1A; --panel2:#1C2620; --panel3:#212C26; --ink:#ECF1EE; --ink2:#9BA7A0; --ink3:#69756E; --line:#283330; --line2:#222B27; --accent:#2FB694; --accentInk:#7FE0C6; --accentSoft:#15302A; --accentBrd:#23463D; --shadow:0 1px 2px rgba(0,0,0,.3),0 8px 26px rgba(0,0,0,.35); --shadowLg:0 30px 80px rgba(0,0,0,.6)`
  - Status and alert color: `#C2410C` (emergency, errors, deny). Warning amber: `#B45309` / `rgba(194,116,11,.14)`. Add-on kind badge: `#8A5A06` on `rgba(176,121,8,.15)`.
- UI components used throughout:
  - **Switch (`sw`):** 50×30 track with a 24px knob. Track is `var(--accent)` when on, `var(--line)` when off.
  - **Segmented button (`seg`):** height 38, radius 9, 13px weight 700. Active is accent background with white text.
  - **Chip:** height 40, radius 11. Active is `accentSoft` background, `accentInk` text, `accentBrd` border.

---

## 1. Entities and fields

### 1.1 Business hours (`hours[7]`, indexed by weekday 0–6)
- Fields per day: `{ open:boolean, from:'h:mm AM/PM', to:'h:mm AM/PM' }`. "Closed" is `open:false`, shown as the label `Closed`.
- Seed: Sun 9:00 AM–3:00 PM; Mon to Fri 8:00 AM–6:00 PM; Sat 8:00 AM–5:00 PM. All days open.
- Per-row display is `len` = `(minutes/60)+' hrs'`, for example `10 hrs` or `6 hrs`. Fractions are possible, such as `10.5 hrs`.
- Summary card: `weekHours` = (sum of `len` over open days)/60 + `' hrs'`, labeled `open per week`. The seed gives 65 hrs.
- Card copy: "Hours drive online booking slots, the Operations calendar and the customer app."
- Button "Copy Monday to weekdays" copies Monday's `{open,from,to}` to Tue, Wed, Thu and Fri only (indexes 2 to 5). Saturday and Sunday are not touched.

### 1.2 Booking rules (`rules`, not persisted in the prototype)
Each rule is a segmented choice. Option labels are `{value} min`.

| Key | Label | Choices | Default |
|---|---|---|---|
| `slot` | Slot length | 15, 30, 60 | 30 |
| `buffer` | Buffer between jobs | 0, 10, 15, 20 | 10 |
| `cutoff` | Last booking before close | 30, 60, 90 | 60 |

### 1.3 Closures and holidays (`closures[]`)
- Record: `{ id, date:'YYYY-MM-DD', name, type:'closed'|'reduced', from, to, notify:boolean, emergency?:true }`.
- Defaults merged into every record: `notify:true, from:'10:00 AM', to:'2:00 PM'`. The `from` and `to` are meaningful only when `type==='reduced'`.
- The add form (`nc`) starts as `{date:'', name:'', type:'closed', from:'10:00 AM', to:'2:00 PM'}`. Its form fields are:
  - Date: native date input.
  - Name: placeholder `e.g. Staff training day`.
  - Type: segmented `Closed all day` / `Reduced hours`.
  - From/to steppers: only when `reduced`.
- Display tag label (`typeLabel`):
  - If `emergency`: `Emergency`.
  - Else if `closed`: `Closed all day`.
  - Else: `Reduced · {from} – {to}` (the dash is U+2013).
- Tag colors:
  - Emergency: `rgba(194,65,12,.14)` background, `#C2410C` text.
  - Closed: `--panel3` background, `--ink2` text.
  - Reduced: `--accentSoft` background, `--accentInk` text.
- Row display: a date block (`mon` as JAN..DEC, `day`, `dow` as SUN..SAT), the name plus tag, a sub-line, a `Notify` switch, and a remove "✕" with title "Remove".
- Sub-line (the numbers are FAKE in the prototype, derived from `hash = +date.slice(-2)`):
  - `closed`: `Online booking blocked · {hash%4} existing bookings to move`.
  - `reduced`: `Slots outside reduced hours hidden · {hash%3} bookings affected`.
- Lists: "Upcoming" is sorted by date ascending, where `past = date < TODAY` is false. "Past" is sorted descending and shows only `{mon} {day}`, `name` and `typeLabel`. Past rows have no controls.
- Auto US federal holidays: the switch `federal` (default true) has the title "Auto-add US federal holidays" and the sub "Added as closed days each January. Edit or remove any of them below."
  - It is only a boolean in the prototype. It is not persisted, and the prototype contains NO holiday generation logic. See 1.3a for the implied behavior, which the backend must define.
  - There is no "edit" UI for an existing closure other than the `Notify` toggle and Remove.
- Seed closures:

| date | name | type | from–to | emergency |
|---|---|---|---|---|
| 2026-05-25 | Memorial Day | closed | | |
| 2026-06-03 | Weather closure | closed | | true |
| 2026-07-04 | Independence Day | closed | | |
| 2026-09-07 | Labor Day | reduced | 10:00 AM–2:00 PM | |
| 2026-11-26 | Thanksgiving | closed | | |
| 2026-12-24 | Christmas Eve | reduced | 8:00 AM–1:00 PM | |
| 2026-12-25 | Christmas Day | closed | | |

**1.3a Auto-added federal holidays (IMPLIED, not computed in the source)**
The design only says "Added as closed days each January." The seed list contains only five federal holidays, plus the non-federal Christmas Eve:
- Memorial Day, 2026-05-25: last Monday of May.
- Independence Day, 2026-07-04: the literal date. It falls on a Saturday in 2026, and the seed does NOT shift it to the observed Friday.
- Labor Day, 2026-09-07: first Monday of September.
- Thanksgiving, 2026-11-26: fourth Thursday of November.
- Christmas Day, 2026-12-25.

The prototype does not list the other federal holidays, and none are present in the seed. The standard 11 (5 U.S.C. 6103), with date rules INFERRED by me:

| Holiday | Rule |
|---|---|
| New Year's Day | Jan 1 |
| Martin Luther King Jr. Day | 3rd Mon of Jan |
| Washington's Birthday | 3rd Mon of Feb |
| Memorial Day | last Mon of May |
| Juneteenth | Jun 19 |
| Independence Day | Jul 4 |
| Labor Day | 1st Mon of Sep |
| Columbus / Indigenous Peoples' Day | 2nd Mon of Oct |
| Veterans Day | Nov 11 |
| Thanksgiving | 4th Thu of Nov |
| Christmas | Dec 25 |

See open question Q1 on whether all 11 are added.

### 1.4 Emergency closure
- Config (`em`) and the exact copy and options:
  - `reason`, chip single-select, default `Severe weather`. Choices and their `{reason}` template text:
    - `Severe weather` becomes "severe weather"
    - `Power outage` becomes "a power outage"
    - `Equipment failure` becomes "an equipment failure"
    - `Staff shortage` becomes "a staffing issue"
    - `Other` becomes "unforeseen circumstances"
  - `dur` ("Close for"), segmented, default `today`. Choices: `today` is "Rest of today", `until` is "Until a time", `days` is "Multiple days".
  - `until` ("Reopen at", shown when `dur==='until'`): time stepper, default `2:00 PM`.
  - `through` ("Closed through", shown when `dur==='days'`): date input, default `2026-06-15`.
  - Switches, all default true. Labels and subs are verbatim:

| Key | Label | Sub |
|---|---|---|
| `notify` | Notify affected customers | WhatsApp, with SMS fallback |
| `link` | Include one-tap reschedule link | Customers pick a new slot themselves |
| `credits` | Protect member credits | Missed visits don’t use a credit |
| `pause` | Pause online booking | Until you reopen |
| `crew` | Alert on-shift crew | Push notification to the team |

  - `msg` (textarea, 4 rows), default (apostrophe is U+2019): `Hi {first}, due to {reason} Oasis Auto Spa is closed {until}. We’re sorry for the inconvenience. Pick a new time here: {link}`
  - The template variables line reads: `Variables: {first} {reason} {until} {link}`.
- `{until}` text (`untilText`):
  - `today`: `for the rest of today`
  - `until`: `until {em.until} today`
  - `days`: `through ` plus `toLocaleDateString('en-US',{weekday:'long',month:'short',day:'numeric'})` of `em.through` at T12:00:00. For example, `through Monday, Jun 15`.
- Preview: label `Preview · WhatsApp to Liam`. Replace `{first}` with `Liam`, `{reason}` with the reason text, `{until}` with `untilText`, and `{link}` with `oasis.spa/r/8KQ2` (a sample short link). Each replacement is a global regex.
- Affected appointments (see 2.5): a list titled "Affected appointments" with a count chip `{n} customers`. Each row is `time · name · vehicle`.
- Idle status strip (hard-coded text): `Open now · Saturday 8:00 AM – 5:00 PM · 6 appointments left today, 3 vehicles on site`. In the backend this must be live data: open/closed status, today's hours, appointments remaining, and vehicles on site.
- Action button: "Close the shop now". Under it: `Requires Management or Super Admin · you have access`. This maps to the `set.emergency` permission, which is true only for `super` and `mgmt` in the seed.
- Confirm dialog:
  - Title: `Close Oasis Auto Spa now?`
  - Body: `{notify ? N+' customers will be messaged' : 'No customers will be messaged'}{pause ? ', online booking pauses' : ''} and the closure shows on the Operations screen. Reason: {reason lowercased}, {untilText}.`
  - Buttons: `Cancel` / `Confirm closure`.
- Active state (`em.active` and `em.summary`, persisted at `localStorage['oasis-emergency']={active,summary}`):
  - Panel title: `Emergency closure active`.
  - `summary` = `{reason} · closed {untilText}{pause ? ' · online booking paused' : ''}`.
  - Three counters:
    - `emNotified`: `em.notify ? String(REMAINING.length) : '0'` with the label "customers notified". This FAKES the count using all 6 remaining appointments, not the `affected` count.
    - `emRebooked`: hard-coded `'2'`, labeled "rebooked so far".
    - `emBooking`: `em.pause ? 'Paused' : 'Open'`, labeled "online booking".
  - Button: `Reopen now`.
  - The sidebar shows a green `ACTIVE` badge.
- Closure history record: `{date:'Mon D, YYYY', reason, detail}`. Newest first. Seed:
  - `Jun 3, 2026 · Severe weather · Full day · 7 customers notified · 6 rebooked`
  - `Feb 18, 2026 · Power outage · 11:20 AM – 3:00 PM · 4 notified`
  - A new record is added only on Reopen: `{date:'Jun 13, 2026', reason:<current em.reason>, detail:'Reopened by Rafael M. · {REMAINING.length} notified'}`. Its detail format differs from the seed's.
- The seed closure `2026-06-03 Weather closure` (`emergency:true`) corresponds to the Jun 3 history record. This implies an emergency closure should create an `emergency:true` closure row, but the prototype does not do this on Close.

### 1.5 Employees
Fields:

| Field | Values and notes |
|---|---|
| `id` | `e1`..`e7` in seed. New employees get `'e'+Date.now()`. |
| `first` (required), `last` | strings |
| `title` | free text, placeholder `e.g. Detailer`. Shown as `—` when empty. |
| `phone` (required, label "Mobile *", placeholder `(305) 555-0000`) | string |
| `email` | placeholder `name@oasisautospa.com`. Seed default is `first.toLowerCase()@oasisautospa.com`. |
| `roles` | array of role ids. At least one is required. Default for new is `['crew']`. |
| `status` | `active` (label "Active"), `invited` (label "Invite sent"), `inactive` (label "Inactive") |
| `type` (Employment) | `Full-time`, `Part-time`, `Contractor`. Default `Full-time`. |
| `payType` (Pay) | `Hourly`, `Commission`, `Salary`. Default `Hourly`. |
| `rate` | string. Placeholder depends on payType: Hourly `$ / hour`, Commission `% per job`, Salary `$ / year`. |
| `skills` | multi-select chips from the fixed `SKILLS` list below |
| `sched[7]` | per-weekday `{on, from, to}` |
| `overrides` | map `{permId: 'allow'|'deny'}` |

- Skills (fixed list): Interior detailing, Paint correction, Ceramic coating, Exotic vehicles, Front desk, Mobile service.
- New-employee defaults: `status:'invited'`, `sched` has Mon to Fri on and Sat and Sun off, all days 8:00 AM–6:00 PM, `overrides:{}`.
- Seed `sch(days)`: `from` is 9:00 AM on Sunday and 8:00 AM otherwise. `to` is 3:00 PM on Sunday, 5:00 PM on Saturday, and 6:00 PM otherwise. This matches the business hours.
- Drawer:
  - Header: heading is `First Last`, or `New employee`. Sub is `{title} · {role names joined ' + '}`, or `They’ll get an SMS invite to set up their login.` for new employees. Avatar is initials, or `+` for new.
  - Tabs: `Profile`, `Roles & access`, `Schedule`.
  - Profile tab: the five fields above, then `Employment`, `Pay` (segmented plus the rate input), and `Skills`.
  - Access tab:
    - A "Roles" label with the hint `Assign one or more. Permissions combine.` Role cards show name and description, with checkboxes.
    - "Effective permissions" with a count chip `{n} of 27 allowed`, the hint `Use Allow or Deny to make an exception for this person only.`, and rows per module and permission.
    - Each permission row has a dot, a label, a source string, and a 3-way button `Role` (inherit), `Allow`, `Deny`.
  - Schedule tab: hint `Availability used when assigning jobs and bays. Must sit inside business hours.` Each day has a switch, the label, from/to steppers, or `Off`.
  - Footer buttons: `Deactivate`/`Reactivate` (existing employees only), `Cancel`, and `Save changes` / `Create & send invite`.
- List view:
  - Search placeholder: `Search name, phone, role…`. It matches first, last, phone, title and role names. It does not match email.
  - Role filter chips: `All` plus each role.
  - Row: avatar initials, name, `{title} · {type}`, role badges, an optional `{n} exception(s)` badge (`exception` is pluralized for n>1), phone, and `{n} days / week`.
  - Status badge colors: active uses `accentSoft`/`accentInk`; invited uses `rgba(194,116,11,.14)`/`#B45309`; inactive uses `panel3`/`ink3`.
  - Empty state: `No employees match.`
  - Avatar colors by list index mod 7: `#0E7A63,#2563EB,#7A3B8A,#C2740B,#0D9488,#B45309,#6B7280`.
- Seed employees:

| id | Name | Title | Phone | Roles | Status | Type | Pay | Rate | Skills | Schedule | Overrides |
|---|---|---|---|---|---|---|---|---|---|---|---|
| e1 | Amara Okoye | Owner | (305) 555-0101 | super | active | Full-time | Salary | '' | Exotic vehicles | Mon–Sat | none |
| e2 | Rafael Mendes | General Manager | (305) 555-0140 | mgmt, acct | active | Full-time | Salary | '' | none | Mon–Sat | none |
| e3 | Marco Ruiz | Lead Detailer | (786) 555-0172 | crew | active | Full-time | Commission | 30 | Paint correction, Ceramic coating, Exotic vehicles | Mon–Sat | none |
| e4 | Lena Kim | Detailer | (305) 555-0119 | crew | active | Full-time | Hourly | 22 | Interior detailing | Sun, Tue–Sat | none |
| e5 | Sofia Duarte | Front Desk | (786) 555-0133 | support, crew | active | Full-time | Hourly | 21 | Front desk | Mon–Sat | `sched.override: allow` |
| e6 | Daniel Price | Bookkeeper | (305) 555-0188 | acct | active | Part-time | Hourly | 34 | none | Mon, Wed, Fri | none |
| e7 | Kevin Tran | Detailer | (786) 555-0151 | crew | invited | Full-time | Hourly | 19 | none | Mon–Fri | none |

  - Emails are all `first@oasisautospa.com`, lowercase.

### 1.6 Roles and permissions
- Role record: `{ id, name, desc, locked?, custom? }`. The people count is derived: `employees.filter(roles.includes(id)).length`, shown as `1 person` / `N people`. The permission count is shown as `{n} of 27 permissions`.
- Seed roles and descriptions:

| id | Name | Description | Locked |
|---|---|---|---|
| super | Super Admin | Owner level. Everything, including billing. | yes |
| mgmt | Management | Runs the shop day to day. | |
| acct | Accounting | Payments, refunds, credits and reports. | |
| support | Customer Support | Front desk, bookings and messaging. | |
| crew | Crew | Bay work: jobs, checklists, photos. | |

- A `locked` role shows a `LOCKED` tag, its checkboxes are gray with `cursor:not-allowed`, and clicking one shows the toast `Super Admin always has every permission`. Its limit chip cannot be changed.
- A custom role (`custom:true`) shows a `REMOVE` button.
- "Custom role" button: creates `{id:'custom'+Date.now(), name:'Shift Lead', desc:'Custom role — starts from Crew.', custom:true}`.
  - Its perms are a copy of `crew`'s plus `sched.edit:true`.
  - Its limits are `{refund:25,adjust:25,credit:25}`.
  - Toast: `Custom role added — adjust its permissions below`.
  - There is no rename or description edit UI, so every new custom role is named "Shift Lead".
- Removing a custom role deletes its perms and limits, strips that role from every employee's `roles`, and shows the toast `{name} removed`.
- Info banner: "People with several roles get every permission from each role, and the highest money limit. Per-person exceptions are set on the employee's profile. Tap a limit chip to change it."
- Matrix: columns are `minmax(220px,1.6fr) repeat(N roles, minmax(96px,1fr))`. A checkbox is shown per role and permission. A limit chip is shown beside the checkbox only for the 3 money permissions, and only when that permission is ON.

**Permission modules and keys (27 total; `†` marks a money-limited permission, the third tuple element `1`)**

| Module | Key | Label |
|---|---|---|
| Schedule & jobs | `sched.view` | View schedule & calendar |
| | `sched.edit` | Create & edit appointments |
| | `sched.cancel` | Cancel & mark no-shows |
| | `sched.override` | Override bay capacity |
| | `jobs.status` | Move jobs between stages |
| | `jobs.checklist` | Complete checklists & photos |
| Clients | `cli.view` | View client files |
| | `cli.contact` | See phone & email |
| | `cli.edit` | Edit client & vehicle details |
| | `cli.export` | Export client data |
| | `cli.member` | Manage memberships & VIP |
| Payments | `pay.collect` | Collect payments |
| | `pay.refund` † | Issue refunds |
| | `pay.adjust` † | Apply adjustments & discounts |
| | `pay.credit` † | Issue account credits |
| | `pay.void` | Void transactions |
| | `pay.reports` | View payment reports |
| Messaging | `msg.send` | Message customers |
| | `msg.auto` | Edit automations & templates |
| | `msg.broadcast` | Send offers & broadcasts |
| Team | `team.view` | View team |
| | `team.edit` | Add & edit employees |
| | `team.roles` | Assign roles & permissions |
| Settings | `set.hours` | Working hours & holidays |
| | `set.emergency` | Emergency closing |
| | `set.services` | Services, pricing & checklists |
| | `set.billing` | Billing & integrations |

**Money limit chips**
- Limit keys come from the permission suffix: `refund`, `adjust`, `credit`.
- Choice list (`LIMITS`): `[25, 50, 100, 250, 500, 1000, null]`. Clicking a chip cycles to the next value and wraps around.
- Chip label: `null` is `No limit`; otherwise `≤ $` plus `toLocaleString('en-US')`, for example `≤ $1,000`. An undefined limit is treated as 25.

**Seed role permissions** (the set of permissions that are true; all others are false)

| Role | Permissions granted |
|---|---|
| super | all 27 |
| mgmt | all except `set.billing` (26) |
| acct (13) | `sched.view, cli.view, cli.contact, cli.export, cli.member, pay.collect, pay.refund, pay.adjust, pay.credit, pay.void, pay.reports, team.view, set.billing` |
| support (13) | `sched.view, sched.edit, sched.cancel, cli.view, cli.contact, cli.edit, cli.member, pay.collect, pay.refund, pay.adjust, pay.credit, msg.send, team.view` |
| crew (4) | `sched.view, jobs.status, jobs.checklist, cli.view` |

**Seed limits**

| Role | refund | adjust | credit |
|---|---|---|---|
| super | null (No limit) | null | null |
| mgmt | 1000 | 500 | 500 |
| acct | 500 | 250 | 250 |
| support | 50 | 25 | 50 |
| crew | 25 | 25 | 25 |

- Crew has 25 for all three even though it lacks those permissions.
- Per-person overrides (`overrides[permId]='allow'|'deny'`) are described in 2.1.

### 1.7 VIP program (`vip`, persisted in `localStorage['oasis-vip']={vip,arrival}`)
- **Reserved slots** (`holds[]` of `{d:weekday, t:'h:mm AM/PM'}`).
  - Title: "Reserved VIP slots". Copy: "Prime times only VIP clients can book. If no VIP takes one, it opens to everyone before the slot."
  - Seed holds: Sat 8:00 AM, Sat 9:00 AM, Sat 10:00 AM, Fri 4:00 PM, Sun 9:00 AM.
  - Sort order is Monday-first (`(d+6)%7`), then time. Chip label is `{DayName} · {time}`, for example `Saturday · 8:00 AM`, with a `VIP` tag and a "✕" remove.
  - The "add hold" picker has a day stepper (cycling, default Saturday, index 6), a time stepper (default `11:00 AM`, 30-minute steps), and an `Add hold` button.
  - A duplicate shows the toast `That slot is already held`. A success shows `{Sun..Sat abbrev} {time} held for VIPs`, for example `Sat 11:00 AM held for VIPs`.
- **Release**: "Release unbooked holds to everyone", segmented `24h before` / `48h before` / `72h before`. Key `release`, default 48.
- **Steppers** (`−`/`+`):

| Key | Label | Sub | Min | Max | Step | Default | Unit |
|---|---|---|---|---|---|---|---|
| `windowVip` | VIP booking window | How far ahead VIPs can book | 7 | 90 | 7 | 30 | ` days` |
| `windowStd` | Standard booking window | Everyone else | 7 | 60 | 7 | 14 | ` days` |
| `sameDay` | Same-day guarantee | Per VIP, per month — we fit them in even when full | 0 | 8 | 1 | 2 | ` / mo` |

- **Toggles** (all default true):
  - `waitlist`: "Waitlist priority" / "Cancellations are offered to VIPs first"
  - `standing`: "Standing appointments" / "VIPs can set a repeating slot"
  - `autoConfirm`: "Auto-confirm standing visits" / "Confirmed 48h before without a reply". The 48h is hard-coded copy.
- **Waitlist claim window**: label "Waitlist: VIPs get first claim for", segmented `10 min` / `15 min` / `30 min`. Key `offerMin`, default 15.
- **Standing cadences offered**: label "Standing appointment cadences offered", chip multi-select over `Weekly`, `Every 2 weeks`, `Every 3 weeks`, `Monthly`. Default selected: Weekly, Every 2 weeks, Monthly.
- **VIP clients**: `clients[]` is a list of NAME STRINGS, with seed `Jonathan Franco, Liam Chen, Aisha Rahman, Elena Volkov`.
  - Count chip: `{n} clients`, which is also used for n=1.
  - Row has a `Remove` button. Add uses a "Client name" input and a `Make VIP` button.
  - On add: the name is trimmed, empty is ignored, the toast is `{name} is now VIP`, and the input is cleared. Removal shows no toast.

### 1.8 Arrival and check-in (`arrival`, persisted with VIP)
- Intro: "Applies to every client who has the app and allows location, not only VIPs."
- Toggles (label / sub), all default true:
  - `on`: "Geofence auto check-in" / "Turn off to require check-in at the desk"
  - `autoArrive`: "Mark as Arrived automatically" / "Job moves to Arrived on the Operations screen"
  - `welcome`: "Send welcome message" / "“You’re checked in — pull into Bay 2”"
  - `crew`: "Alert the crew" / "Push notification to whoever is on shift"
  - `vipFirst`: "VIP arrivals first" / "VIP arrivals sit at the top of alerts"
- Choices:
  - "Check-in radius": `150 m` / `300 m` / `500 m`. Key `radius`, default 300.
  - "Prep-bay alert when ETA is": `10 min away` / `15 min away` / `20 min away`. Key `prepAt`, default 15.
- "What happens" explainer (dynamic):
  1. Title `{prepAt} min out`: "Operations gets an “Arriving” alert with a Prep bay button. VIPs show in purple at the top."
  2. Title `Within {radius} m`: if `autoArrive` is on, "Checked in automatically and the job moves to Arrived. ", otherwise "Staff confirm the check-in. ". Then, if `welcome` is on, "Customer gets a welcome message."
  3. Title `Ready to start`: "Crew sees “Auto checked in” with a Start cleaning button."

### 1.9 Services (packages and add-ons)
- Only checklist tasks are editable in Settings. Name, price and duration are display-only. They are fixtures, with no edit UI.
- Packages: `{price, dur(min), tasks[]}`. There are 9.
- Add-ons: `{price, tasks[]}`. There are 10.
- No add-on duration, no add-on `kind` or `note`, and no vehicle-size pricing exist anywhere in Settings.
- Package meta line: `${price} · {dur} min · {n} tasks`. Add-on meta line: `+${price} · {n} tasks`.
- Kind badges: `Package` uses an accent badge, `Add-on` an amber badge.
- List: a segmented `Packages` / `Add-ons` switch above a list of `name` plus a task-count number. Switching to Packages selects the SECOND package (`Premium Hand Wash + Interior`) by default. Switching to Add-ons selects the first add-on.
- Notes:
  - Package: "Every job booked with this package starts with these tasks. Selected add-ons append their own tasks underneath."
  - Add-on: "When this add-on is on a job — booked, approved in the app, or added at the desk — these tasks are appended to the job checklist."
- Task editor: a numbered list with an inline text input, `↑` (title "Move up"), `↓` (title "Move down"), and `✕` (title "Remove"). An add row has the placeholder `Add a task…` (Enter key or the `Add task` button) and ignores empty or whitespace input. All edits persist to `localStorage['oasis-checklists']={packages:{name:tasks[]},addons:{name:tasks[]}}` immediately.

**Packages** (price, duration, tasks)
- Express Hand Wash: $45, 35 min. Tasks: Exterior rinse; Hand wash; Wheel cleaning; Hand dry & towel; Glass & windows.
- Premium Hand Wash + Interior: $129, 75 min. Tasks: Exterior pre-rinse; Two-bucket hand wash; Wheel & tire cleaning; Tire shine; Interior vacuum; Dashboard & console wipe; Streak-free windows.
- Premium Hand Wash + Interior Refresh: $139, 75 min. Tasks: Exterior pre-rinse; Two-bucket hand wash; Wheel & tire cleaning; Tire shine; Interior vacuum; Dashboard & vents wipe; Leather seat refresh; Streak-free windows.
- Executive Detail: $260, 90 min. Tasks: Foam pre-soak; Two-bucket hand wash; Clay bar treatment; Wheel & caliper detail; Tire dressing; Full interior vacuum; Leather conditioning; Dashboard & vents detail; Streak-free glass; Spray sealant.
- Executive Detail + Ceramic: $420, 120 min. Tasks: Foam pre-soak; Two-bucket hand wash; Iron decontamination; Clay bar treatment; Ceramic spray coat; Wheel & caliper detail; Full interior detail; Leather conditioning; Streak-free glass.
- Full Detail: $320, 120 min. Tasks: Engine bay degrease; Foam pre-soak; Hand wash; Clay bar; Wheel deep clean; Carpet shampoo; Full interior vacuum; Leather treatment; Glass polish; Wax & seal.
- Ceramic Maintenance + Wax: $180, 60 min. Tasks: Pre-rinse; pH-neutral hand wash; Ceramic boost spray; Hand-applied wax; Wheel cleaning; Tire dressing; Glass treatment.
- Exotic Detail Package: $650, 150 min. Tasks: Waterless decon; Two-bucket hand wash; Paint correction pass; Ceramic seal; Wheel & caliper detail; Full interior detail; Leather conditioning; Glass & trim restore; Photographic handover.
- Family Wash + Pet Hair: $95, 50 min. Tasks: Exterior rinse; Hand wash; Pet hair removal; Interior vacuum; Dashboard wipe; Windows; Odor neutralize.

**Add-ons** (price, tasks)
- Interior deep clean: $60. Tasks: Deep vacuum seats & carpets; Steam clean vents & cupholders; Wipe door jambs & panels.
- Pet hair removal: $35. Tasks: Rubber-brush pet hair; Lint-roll upholstery; Vacuum seat seams.
- Leather conditioning: $45. Tasks: Clean leather surfaces; Apply conditioner; Buff to matte finish.
- Wax: $40. Tasks: Apply carnauba wax; Buff off haze.
- Clay bar: $50. Tasks: Lubricate panels; Clay bar paint; Wipe residue.
- Odor removal: $30. Tasks: Enzyme treatment on fabrics; Odor neutralizer cycle.
- Engine bay cleaning: $55. Tasks: Cover electricals; Degrease engine bay; Dress plastics.
- Ceramic maintenance: $120. Tasks: Ceramic boost spray; Buff & level coating.
- Rain repellent: $25. Tasks: Clean glass; Apply rain repellent to windshield.
- Wheel deep clean: $40. Tasks: Remove wheel fallout; Clean barrels & calipers; Seal wheel faces.

---

## 2. Rules and formulas

### 2.1 Effective permissions (`eff(employee, permId)`)
```
from = employee.roles.filter(r => role.perms[r][permId] === true)
limitKey = permId has limit flag ? suffix : null
lims = limitKey ? from.map(r => role.limits[r][limitKey]) : []
lim  = lims.length
         ? (lims.includes(null) ? null : Math.max(...lims))
         : (limitKey ? 25 : undefined)
tail = limitKey ? ' · ' + (lim===null ? 'No limit' : '≤ $'+fmt(lim)) : ''
if override==='deny'  → { on:false, src:'Exception · denied' }
if override==='allow' → { on:true,  src:'Exception · allowed'+tail }
if from.length        → { on:true,  src:'via '+roleNames.join(' + ')+tail }
else                  → { on:false, src:'Not included in assigned roles' }
```
- Multiple roles produce a union of permissions. For money, the limit is the highest limit among only the roles that GRANT that permission, and `null` (no limit) wins.
- Deny beats everything. Allow with no granting role gives the default limit of 25. Allow with granting roles keeps the roles' limit.
- The count `effCount` is the number of permissions with `on===true`, shown as `{n} of 27 allowed`.
- Example: Sofia Duarte is support + crew with `sched.override: allow`. Her refund limit is 50, since only support grants `pay.refund`. Her `sched.override` is allowed with source "Exception · allowed".
- Role-level checkbox toggle: flips `rc.perms[role][perm]`, except on a locked role.
- Role-level limit chip: cycles `LIMITS`, except on a locked role.
- Known quirk: if a role has a permission but its `limits[role]` entry is undefined, `Math.max(undefined)` yields NaN. The backend must always default limits to 25.

### 2.2 Hours
- `len(day)` = `open ? max(0, parseT(to) − parseT(from)) : 0`. The week total is the sum of `len`. `weekHours` is `total/60` plus ` hrs`.
- No validation exists that `from < to`, no maximum, and no check of any relationship to employee schedules or closures.
- Steps are ±30 minutes, clamped to 5:00 AM–11:30 PM.

### 2.3 Schedule-within-business-hours validation
- The only statement is the copy in the Schedule tab: "Availability used when assigning jobs and bays. Must sit inside business hours."
- There is NO validation code and NO error message in the prototype. `saveEmp` checks only name, phone and roles.
- The backend must implement this and define an error string. This is a gap to flag. Proposed rule: for each day with `on:true`, the employee's `[from,to]` must lie within `[hours[d].from, hours[d].to]`, and the day must be `open`. Proposed message, my own invention: `{Day}: availability must sit inside business hours ({from} – {to}).`

### 2.4 Closure affected count (`ncAffected`)
- Shown in the add form only when `nc.date && nc.date >= TODAY`. The copy is `{(dayOfMonth % 5) + 2} customers are booked that day — they’ll get a reschedule link when you add this.` The number is FAKE.
- The backend equivalent is the real count of non-cancelled appointments on that date. For `reduced`, count those outside the reduced window. Always compute server-side.
- Both the count and the reschedule-link message are shown regardless of closure type.
- The row sub-lines for existing closures also use fake `hash%4` and `hash%3` values. These must also be real counts.

### 2.5 Emergency closure
- `affected`: if `dur==='until'`, `REMAINING.filter(appt.time < parseT(em.until))`. For `today` and `days`, it is all of `REMAINING`. The `days` option does NOT include future days' appointments through `through` (a design gap).
- Confirm text uses `affected.length`. The toast `Shop closed · N customers notified` also uses `affected.length`. If `notify` is off, the toast is `Shop closed · no messages sent`.
- Counters:
  - `emNotified` uses `REMAINING.length` (inconsistent with `affected` when `dur==='until'`).
  - `emRebooked` is a hard-coded 2.
  - The history detail on reopen also uses `REMAINING.length`.
- The prototype implements NO server effects. It only toggles flags and persists `{active,summary}`. Side effects stated or implied by the UI copy:
  - Send WhatsApp (SMS fallback) to the affected customers with the rendered message.
  - Include a one-tap reschedule link if `link` is on.
  - Do not deduct a member credit for missed visits if `credits` is on.
  - Pause online booking if `pause` is on.
  - Push-alert the on-shift crew if `crew` is on.
  - The closure shows on the Operations screen.
  - Close and Confirm requires `set.emergency`.
- `link` quirk: if `link` is off, `{link}` is NOT stripped from the message template.
- The idle-strip numbers (6 appointments left, 3 vehicles on site) are static text.

### 2.6 "Reopen now" semantics
- Sets `active:false` and persists `{active:false}`.
- Prepends a history record `{date:'Jun 13, 2026', reason:<current>, detail:'Reopened by Rafael M. · {REMAINING.length} notified'}`.
- Toast: `Shop reopened · online booking resumed`.
- It does not clear `em.summary`. It leaves all `em` options as they were.
- Online booking resumes even if `pause` was false.
- Nothing in the prototype auto-reopens at the `until` time or the `through` date. These are implied but unimplemented (open question Q5).

### 2.7 VIP hold release logic
- Copy: "If no VIP takes one, it opens to everyone before the slot." Together with "Release unbooked holds to everyone: 24h/48h/72h before", the implied rule is: a held slot is bookable only by VIP clients until `slotStart − release hours`. If still unbooked then, it becomes public.
- Every hold is a weekly recurring `{weekday,time}` pair, not a date.
- The prototype contains no booking engine. The release logic is not computed anywhere. The backend defines it.
- Related implied rules:
  - VIPs can book up to `windowVip` days ahead, others up to `windowStd` days.
  - `sameDay` is the number of guaranteed same-day fit-ins per VIP per calendar month, even if the schedule is full.
  - Waitlist: if `waitlist` is on, a cancelled slot is offered first to VIPs for `offerMin` minutes.
  - Standing appointments: if `standing` is on, VIPs can create repeats using cadences in `cadences`. If `autoConfirm` is on, standing visits are auto-confirmed 48h before with no reply needed.
- Stepper quirk: bounds are 7 to 90 in steps of 7, but the default is 30, so ±7 drifts off the 7-multiple grid (30 goes to 23 or 37).

### 2.8 Dirty tracking and persistence behavior
- Only Working hours has explicit save. `hoursDirty = (section==='hours') && JSON.stringify(hours) !== savedHours`.
  - A sticky bar appears with the text `Unsaved changes to working hours`, plus `Discard` and `Save changes`.
  - Discard resets `hours` to the parsed `savedHours`.
  - Save writes to `oasis-hours`, updates `savedHours`, and shows the toast `Working hours saved · booking and calendar updated`.
  - The bar is hidden when another section is open. There is no navigation guard.
- All other sections auto-save on change:
  - Closures: on toggle, add or remove.
  - Roles and limits: on every change.
  - Checklists: on every edit.
  - VIP and arrival: on every change.
  - Emergency: on close and reopen.
  - Employees save through the drawer's `Save` button.
- Not persisted: booking rules (slot/buffer/cutoff), the `federal` toggle, employees (re-seeded on load), em options, and em history.
- `localStorage` keys: `oasis-hours`, `oasis-roles`, `oasis-closures`, `oasis-checklists`, `oasis-emergency`, `oasis-vip`, `oasis-theme`.

### 2.9 Toast and error strings (exact)

Toasts:
- `Working hours saved · booking and calendar updated`
- `{name} added · calendar updated` (closure added)
- `{name} removed` (closure or custom role removed)
- `Shop closed · {n} customers notified`
- `Shop closed · no messages sent`
- `Shop reopened · online booking resumed`
- `Super Admin always has every permission`
- `Custom role added — adjust its permissions below`
- `Saved {first} {last}`
- `Invite sent to {phone}`
- `That slot is already held`
- `{Day} {time} held for VIPs`
- `{name} is now VIP`

Inline errors:
- `Add a date and a name.`
- `There’s already a closure on that date.`
- `First name and mobile number are required.` (jumps to the Profile tab; first/phone borders turn `#C2410C`)
- `Assign at least one role.` (jumps to the Access tab)

---

## 3. Commands and queries (proposed REST)

All are scoped to a single location or tenant. Permission gates are in brackets.

**Hours and rules** [`set.hours`]
- `GET /api/settings/hours` returns `{days:[{weekday,open,from,to}], rules:{slot,buffer,cutoff}, weekHours}`.
- `PUT /api/settings/hours` with body `{days:[{weekday:0..6, open, from, to}], rules:{slotMinutes:15|30|60, bufferMinutes:0|10|15|20, lastBookingBeforeCloseMinutes:30|60|90}}`.
  - Side effects: regenerate bookable slots, the calendar, and the customer app's availability. Return the toast data "booking and calendar updated".
  - Proposed validation: `from<to` and times in 5:00 AM–11:30 PM on a 30-minute grid. Also return a warning when existing employee schedules fall outside new hours.
  - Store times as minutes-from-midnight.
- "Copy Monday to weekdays" is client-only.

**Closures** [`set.hours`]
- `GET /api/closures?from=&to=` returns items with real `affectedCount`. Replaces the fake hash numbers.
- `POST /api/closures/preview` with body `{date, type, from?, to?}` returns `{affected:n}`. Drives `ncAffected`.
- `POST /api/closures` with body `{date, name, type:'closed'|'reduced', from?, to?, notify:true}`.
  - Validation: date and a trimmed name are required, and the date must be unique. Errors are the strings above, as 422.
  - Side effects: block or trim online slots, update the calendar, and message affected customers with a reschedule link (if `notify`).
- `PATCH /api/closures/:id` with body `{notify}`.
- `DELETE /api/closures/:id`.
- `PUT /api/settings/auto-federal-holidays` with body `{enabled}`.

**Emergency** [`set.emergency`; the UI says Management or Super Admin]
- `GET /api/emergency` returns `{active, summary, counters:{notified,rebooked,bookingPaused}, openStatus, history[]}`.
- `GET /api/emergency/preview?reason=&dur=&until=&through=` returns `{affected:[{time,name,vehicle}], count, renderedMessage}`.
- `POST /api/emergency/close` with body `{reason, dur:'today'|'until'|'days', until?, through?, message, notify, link, credits, pause, crew}`.
  - Side effects: set active, create an `emergency:true` closure row, notify, pause booking, protect credits, push-alert the crew, and write history.
  - Response: `{summary, notifiedCount}`.
- `POST /api/emergency/reopen` resumes online booking, writes history `Reopened by {user}`, and closes the emergency closure row.
- `GET /api/emergency/history`.

**Employees** [`team.view` / `team.edit` / `team.roles`]
- `GET /api/employees?q=&role=`.
- `POST /api/employees` with body `{first, last?, phone, email?, title?, roles[], type, payType, rate?, skills[], schedule[7], overrides{}}`.
  - Validation: first and phone are required. Roles must be non-empty. Proposed: the schedule must sit inside business hours.
  - Side effects: `status='invited'` and an SMS invite.
- `PUT /api/employees/:id` (same body, plus status).
- `POST /api/employees/:id/deactivate` and `/reactivate` toggle `inactive` and `active`.
- Role changes and overrides need `team.roles`.

**Roles** [`team.roles`]
- `GET /api/roles` returns roles, the permission catalog, the matrix, limits and people counts.
- `POST /api/roles` with body `{name?, desc?}`. The prototype fixes the name "Shift Lead", copies the Crew perms plus `sched.edit`, and sets limits 25/25/25.
- `PUT /api/roles/:id/permissions/:permKey` with body `{granted}`. Locked roles are rejected.
- `PUT /api/roles/:id/limits/:limitKey` with body `{value: 25|50|100|250|500|1000|null}`. Locked roles are rejected.
- `DELETE /api/roles/:id` for custom roles only. It also removes the role from all employees.
- `GET /api/employees/:id/effective-permissions` returns the per-permission `{on, src, ov, limit}`.

**VIP and arrival** [`cli.member` (probably; the design is silent)]
- `GET /api/vip` and `PUT /api/vip` with body `{release:24|48|72, windowVip, windowStd, sameDay, waitlist, standing, autoConfirm, offerMin:10|15|30, cadences[]}`.
- `POST /api/vip/holds` with body `{weekday,time}`. A duplicate returns 409 with "That slot is already held".
- `DELETE /api/vip/holds`.
- `GET /api/vip/clients`.
- `POST /api/vip/clients` with body `{clientId}`. The design uses a free-text name, so the backend should resolve it to a client.
- `DELETE /api/vip/clients/:clientId`.
- `GET /api/arrival-settings` and `PUT /api/arrival-settings` with body `{on, radius:150|300|500, prepAt:10|15|20, autoArrive, welcome, crew, vipFirst}`.

**Services and checklists** [`set.services`]
- `GET /api/services` returns packages and add-ons.
- `PUT /api/packages/:id/checklist` and `PUT /api/addons/:id/checklist` with body `{tasks:string[]}` (ordered, trimmed, non-empty). The UI does add, edit, reorder and remove, then persists the whole array.
- Package and add-on CRUD for price, duration and name has no UI in Settings. See Q8.

---

## 4. Settings values that drive Operations and Payments

I did not read the Operations or Payments designs. Dependencies below are those stated or implied by Settings copy only.

| Setting | Consumer and effect |
|---|---|
| Business hours | Stated: "Hours drive online booking slots, the Operations calendar and the customer app." Today's open/closed status and hours. Closed days: no slots. |
| Booking rules (slot length, buffer, last booking cutoff) | Online and desk slot generation: length is the grid, buffer is time between jobs, cutoff is the last start before close. Inferred, not stated. |
| Closures | Closed all day: "Online booking blocked · N existing bookings to move". Reduced: "Slots outside reduced hours hidden · N bookings affected". Appears on the Operations calendar ("calendar updated" toast). Past closures are history only. |
| Emergency closure | "the closure shows on the Operations screen". Online booking paused. Crew push alert. Member credits protected, which relates to memberships and Payments. |
| Employee schedules and skills | "Availability used when assigning jobs and bays." Skills are likely used for matching jobs (for example Exotic vehicles, Ceramic coating). Employee `type`, `payType` and `rate` are likely used for payroll and commission, but nothing in Settings consumes them. |
| Roles and permissions | Gate every action in Operations and Payments: `sched.*`, `jobs.*`, `cli.*`, `pay.*`, `msg.*`, `team.*`, `set.*`. Role-based visibility, for example crew sees `sched.view` only. |
| Money limits | Payments: maximum refund, adjustment/discount and account credit amounts a user may apply. The effective limit is the highest among the user's roles that grant the permission, `null` meaning unlimited, and the exception default is $25. `pay.void` has no limit. |
| Per-person overrides | Allow or deny at the single-permission level for one employee, for example Sofia's `sched.override` (override bay capacity). |
| VIP holds, windows and release | Booking availability: reserved slots visible only to VIPs until release. `windowVip` and `windowStd` cap how far ahead each group can book. Same-day guarantee and waitlist priority. Standing appointments. VIP purple display in Operations alerts. |
| Arrival settings | Operations: an "Arriving" alert with a "Prep bay" button at ETA ≤ `prepAt`. Auto-moves the job to "Arrived" within `radius`. The crew sees "Auto checked in" and a "Start cleaning" button. VIP-first ordering. The welcome message example mentions "Bay 2". |
| Packages and add-ons | Price and duration feed booking, the calendar block length, and Payments line items. `dur` per package drives appointment length. Add-on prices add to the total. Add-ons have no duration in Settings, so the calendar length impact is undefined. |
| Checklists | "Jobs combine both automatically": a job's checklist is the package tasks, then each selected add-on's tasks appended. This applies whether the add-on was booked, approved in the app, or added at the desk. Operations "Complete checklists & photos" (`jobs.checklist`). |
| VIP list | Clients flagged VIP. The seed names Liam Chen, Aisha Rahman and Elena Volkov also appear in Settings' fixture appointments. |

---

## 5. Seed fixtures

All seed data is covered in sections 1.1 to 1.9: hours, employees, roles, permissions, limits, closures, packages and add-ons with checklist tasks, VIP holds and clients, and arrival settings. Additional fixtures not listed there:
- **Remaining today (`REMAINING`)**, used for emergency "affected appointments" and fake counters:

| Time | Client | Vehicle |
|---|---|---|
| 10:15 AM | Marcus Webb | Jeep Wrangler |
| 10:45 AM | Liam Chen | BMW M340i |
| 11:00 AM | Grace Adeyemi | Lexus RX 350 |
| 12:00 PM | Aisha Rahman | Range Rover Sport |
| 1:30 PM | Tom Bradley | Honda Civic |
| 3:00 PM | Elena Volkov | Lamborghini Urus |

- **Emergency history:** see 1.4 (two records).
- **Header user:** Rafael M., `Management · Accounting`, initials `RM`.
- **Preview sample:** first name `Liam`, link `oasis.spa/r/8KQ2`.

---

## 6. Integrations and background jobs implied

1. **WhatsApp** for emergency and closure notifications ("WhatsApp, with SMS fallback"). Requires templates, delivery status, and fallback to SMS. Includes a rendered `{first} {reason} {until} {link}` message.
2. **Reschedule link:** a one-tap short link (`oasis.spa/r/<code>`) that opens the customer app or web to pick a new slot. Rebooked counts come from link usage.
3. **SMS invites** to new employees ("They’ll get an SMS invite to set up their login"). Needs an invite token flow, with status `invited`, then `active`.
4. **Push notifications** to the on-shift crew: emergency alerts, and arrival alerts ("Alert the crew").
5. **Federal holiday auto-add job:** annually in January, if the toggle is on, add closed-day closures for each federal holiday for that year. Dates are deterministic (see 1.3a). Avoid duplicates, since the closure date must be unique.
6. **Customer app and online booking:** reads hours, rules, closures, VIP holds and windows, and the paused state. "Online booking blocked" on closure days. Reduced hours hide slots outside the window.
7. **Geofence:** location from the customer app within `radius` meters triggers auto check-in. The ETA alert fires at `prepAt` minutes away. Applies "to every client who has the app and allows location".
8. **VIP hold release job:** open unbooked holds to everyone at `slotStart − release` hours.
9. **Waitlist offer timer:** offer a cancelled slot to VIPs for `offerMin` minutes, then to everyone.
10. **Standing appointment materialization and auto-confirm:** generate occurrences by cadence, then confirm 48h before if no reply when `autoConfirm` is on.
11. **Auto-reopen** at `until` time or after the `through` date (implied by the options, not implemented).
12. **Same-day guarantee counter** per VIP per month.
13. **Member credit protection:** missed visits during an emergency closure don't consume a membership credit.

---

## 7. Ambiguities and open questions

- **Q1. Which federal holidays are auto-added?** The seed has only 5 (Memorial, Independence, Labor, Thanksgiving, Christmas), plus non-federal Christmas Eve. Juneteenth (Jun 19, between "today" and Jul 4) is absent. Is the intent all 11, or a curated subset? Is the observed-date shift (Sat to Fri, Sun to Mon) applied? The seed uses Jul 4, 2026 literally even though it is a Saturday.
- **Q2. Labor Day is `reduced`, yet auto-add creates "closed days".** The copy says "Added as closed days each January. Edit or remove any of them below." There is no edit UI to change type or hours of an existing closure, only Notify and Remove. How was Labor Day made reduced?
- **Q3. Closure `notify` toggle semantics.** The add form has no notify control (it is always true), and the row toggle `Notify` is editable afterward. Does toggling it later send or retract messages, or does it only control a pending send? When exactly are customers notified, and are they notified again on reopen or removal?
- **Q4. Affected count for `reduced` closures** in the add form uses the same copy as `closed`. Should it count only appointments outside the reduced window?
- **Q5. Emergency `days` and `until` handling.**
  - The `days` option ignores appointments on future days through the `through` date in `affected`.
  - There is no automatic reopen.
  - In-progress jobs and vehicles already on site ("3 vehicles on site") are not addressed.
  - The `rebooked` counter has no source (hard-coded 2).
  - Should Close create a `closures` row with `emergency:true`? The fixture implies yes.
  - The history record is created only on Reopen, in a different format from the seed.
- **Q6. `link` off:** should `{link}` and the sentence containing it be stripped from the message?
- **Q7. Employee schedule validation** has only a hint, with no code or message (see 2.3). Is it a hard block or a warning? What if business hours later change so that existing schedules fall outside?
- **Q8. Services editing scope.** `set.services` is labeled "Services, pricing & checklists", but the UI only edits checklists. Price, duration and name are fixtures. There is no create or delete for packages or add-ons, no add-on duration, no add-on `kind` or `note`, and no vehicle-size pricing (that was in the assignment's checklist; it does not exist in the Settings design).
- **Q9. Roles.** Custom roles can't be renamed or described, and each new one is named "Shift Lead". Non-custom, non-locked roles cannot be removed. Role removal can leave employees with zero roles, with no validation until their next save. Do removed roles' per-person overrides get cleaned up?
- **Q10. Limit semantics:** crew has 25/25/25 limits without the permissions. Money limits are per-transaction or cumulative per day? The design says only "≤ $N". Does the `pay.void` permission have a limit? (No.)
- **Q11. Permissions without Settings UI.** `msg.auto` ("Edit automations & templates"), `msg.broadcast`, `set.billing` ("Billing & integrations") and `cli.export` have no surfaces in this design.
- **Q12. VIP model.**
  - VIP clients are stored as a free-text name list. Should this be linked to client records, with matching and de-duplication?
  - Holds are weekly recurring weekday/time pairs, with no check against business hours or closures. A hold may land outside open hours.
  - Do hold times use the slot-length grid?
  - Stepper increments of 7 on a default of 30 drift off the grid.
- **Q13. The "autoConfirm 48h" copy** is fixed text, and is separate from `release` hours. Is it configurable?
- **Q14. Geofence `on=false`:** the explainer steps do not change when the master toggle is off.
- **Q15. Persistence and multi-tenant:** the prototype stores per-browser. The backend needs to define location scoping, audit logs (who changed what), and optimistic concurrency. Only hours has "Save"/"Discard"; the rest auto-saves immediately, so decide whether the dashboard should keep that behavior. Booking rules (slot/buffer/cutoff) are not saved or tracked in the dirty state in the prototype, so it is unclear whether they should be part of the hours save.
- **Q16. Time zone and dates.** The design is US, formatted `h:mm AM/PM`. There is no time zone or "store timezone" setting. `TODAY` is hard-coded to `2026-06-13`.
- **Q17. Employee fields:** the `rate` is a free string with no validation. Pay type (Salary, Commission) has no payroll consumer. Deactivating then Reactivating an `invited` employee sets `active` rather than restoring `invited`. Email is not validated or unique-checked. Phone is not validated.