<!-- Reference material generated during planning (2026-10-06) from the three Claude Design prototypes. Source of truth for the build; see docs/plan.md. -->

# Oasis Command Center (cc): domain, data and business-logic spec

Source: the full `<script type="text/x-dc">` (82,795 chars, all read) and the markup template. "DESIGN" means observed in the source. "PROPOSED" means my inference where the design is silent. Seed-derived numbers (KPIs, totals, alerts) were computed by hand from the fixtures.

Three global facts affect everything below:
- **There is no server.** All state is React state in one `Component`. The only persistence is five `localStorage` keys.
- **Several handlers only toast** and change nothing: payment link, create appointment, the message input, the photo "add" tile, the "Recommend upgrade" button, the "Present membership offer" button, "Apply credit", and the "Message customer" and "Prep bay" alert actions.
- **A synthetic day generator** fabricates calendar days other than today and tomorrow (see §3.12). The backend should return real data there.

---

## 1. Entities & fields

The design has no standalone customer, vehicle or invoice objects. Everything hangs off the appointment object `a`. Proposed normalization is noted per entity.

### 1.1 Appointment (fixture shape, object `a`)

| field | type / values | notes |
|---|---|---|
| `id` | string | Fixtures `'a1'..'a12'`. Generated calendar days use `'g'+dayOffset+'_'+i` (e.g. `g3_0`, `g-2_1`). |
| `day` | int | Day offset from BASE (2026-06-13). Fixtures use `0` (today) and `1` (tomorrow). Generated days use any int, negative = past. |
| `time` | string `'h:mm AM/PM'` | Scheduled start, e.g. `'8:30 AM'`. Parsed by `parseT` (minutes from midnight). The only start-time field; there is no end time. |
| `status` | `'booked'\|'confirmed'\|'arrived'\|'cleaning'\|'completed'` | Active ORDER. `'canceled'` and `'noshow'` exist only in the `stMeta` label map, with no UI or transition. `'ready'`, `'paid'`, `'checkedin'`, `'qc'` appear only in dead or legacy code paths. |
| `staff` | `'Marco R.'\|'Lena K.'\|'Sofia D.'\|'Unassigned'` | A string, not an id. |
| `cust` | `{name, phone}` | e.g. `{name:'Maria Delgado', phone:'(305) 412-8890'}`. |
| `veh` | `{year:int, make, model, color, plate}` | e.g. `{year:2021,make:'Audi',model:'Q5',color:'Pearl White',plate:'KLP-8842'}`. |
| `svc` | string, key of SERVICES | Package name. |
| `bay` | `1\|2\|null` | Planned or current bay. `null` means "No bay" / "Unassigned" and raises an alert. |
| `member` | `null\|'Essential'\|'Premium'\|'Premium Care'\|'Executive'\|'Exotic'` | The plan key is the first word (`m.split(' ')[0]`). `'Premium Care'` maps to Premium. |
| `pay` | `'paid'\|'unpaid'\|'deposit'` | Payment status. |
| `deposit` | number | Used when `pay==='deposit'`. Fixtures: a5 `50`, a7 `20`. Generated days: `25`. |
| `addons` | fixture: `string[]`. Hydrated: `{name, price}[]` | Price is copied from the ADDONS catalog at hydrate time (snapshot). |
| `tip` | number, default 0 | Fixtures: a1 `8`, a2 `20`. Generated past days: `5*floor(rnd*4)`. |
| `pickup` | `null\|'pending'\|'collected'` | Default: `'pending'` if status is completed, else `null`. |
| `notified` | bool | Ready-for-pickup message sent. Default `true`. No UI reads it. |
| `vip` | bool | On the appointment in the design (a4, a6, a11). Logically a customer attribute. |
| `late` | bool | A manual flag in the fixture (a7). Never computed. `isLate = late && status not in (arrived, cleaning, completed)`. |
| `eta` | int minutes or undefined | Geofence ETA. Fixtures: a6 `12`, a8 `22`. Only meaningful while status is confirmed or booked. |
| `geoIn` | string time | Geofence check-in clock. a5 `'10:27 AM'`. |
| `prepped` | bool | Set by `prepBay`. |
| `startedAgo` | int minutes | Fixture-only seed (a4 `27`). |
| `startedAt` | epoch ms or null | Set when cleaning starts. Drives bay timer and progress. |
| `notes` | string | Default `'No special instructions on file.'`. |
| `special` | string or null | Raises a violet alert. |
| `whatsapp` | bool | Always `true`. The modal shows "WhatsApp opted-in". |
| `price` | number | Package price, snapshotted. |
| `dur` | int minutes | Package duration, snapshotted. |
| `baseList` | string[] | Package task labels, snapshotted. |
| `checks` | `{[key]:true}` | Checklist completion map (§1.5). |
| `photos` | `{arrival,before,after,issue}` ints | Counts only. No file, URL, timestamp or uploader exists in the design. |
| `visits` | int | Fake: `3 + (idx % 9)`. |
| `history` | `{day,mon,service,note,amount,fav}[]` | See §1.10. |
| `messages` | `{from:'staff'\|'system'\|(customer), text, time, channel}[]` | Built lazily by `ensureActivity`. |
| `log` | `{time, text, channel}[]` | Audit/activity log. Built lazily. |

Derived, not stored: `total(a)`, `balance(a)` and `isLate(a)`.

PROPOSED normalization: `customers`, `vehicles`, `appointments`, `appointment_addons` (with price snapshot), `appointment_checks`, `appointment_photos`, `messages`, `activity_log`, `payments`, `memberships`. Store times as timestamptz plus a business timezone (§8).

### 1.2 Service packages (SERVICES: price, duration in min, task list)
The list below is after `/inspection/i` items are filtered out at boot. See §7 for the full lists.

Names: Express Hand Wash, Premium Hand Wash + Interior, Premium Hand Wash + Interior Refresh, Executive Detail, Executive Detail + Ceramic, Full Detail, Ceramic Maintenance + Wax, Exotic Detail Package, Family Wash + Pet Hair.

Package task lists can be overridden at boot from `localStorage['oasis-checklists'].packages[name]` (a Settings feature). The new-appointment panel shows only the first 5 packages (`Object.keys(services).slice(0,5)`).

### 1.3 Add-on (ADDONS: `[name, price]`)
Interior deep clean 60, Pet hair removal 35, Leather conditioning 45, Wax 40, Clay bar 50, Odor removal 30, Engine bay cleaning 55, Ceramic maintenance 120, Rain repellent 25, Wheel deep clean 40.

- **ADDON_TASKS:** a map from add-on name to its task labels (§7).
- **Overrides:** `localStorage['oasis-checklists'].addons` is merged over ADDON_TASKS.
- **Fallback:** an add-on with no task entry yields a single task equal to its name.
- **No duration:** add-ons do not extend appointment duration in the design.

### 1.4 Staff
Hard-coded in `renderVals`. There is no id, and staff are not tied to Settings.

| name | role | avatar color |
|---|---|---|
| Marco R. | Lead Detailer | #2563EB |
| Lena K. | Detailer | #0E9E6E |
| Sofia D. | Front Desk | #7A3B8A |
| Unassigned | Queue | #6B7280 |

The signed-in user is the manager: initials `RM`, "Rafael M.", role "Manager".

### 1.5 Checklist (derived, not stored as sections)
`checklistFor(a)` returns sections:
1. One section `{title: a.svc, kind:'Package'}`. Item key is `'pkg|'+label`.
2. One section per add-on `{title: name, kind:'Add-on'}`. Item key is `'ad|'+name+'|'+task`.

- `a.checks` is the sparse map `{key:true}`.
- Because keys are label-based, renaming a task in Settings orphans any stored check.
- Progress: `done = count of keys in current sections that are true`, `total = all keys`, `pct = round(done/total*100)`.
- `initChecks(svc, addons, fraction)` marks the first `round(total*fraction)` keys true.
- Fixture seeding fractions by status: booked, confirmed and arrived `0`; cleaning `0.5`; completed `1`.

### 1.6 Bay
Exactly two, hard-coded `[bayVM(1), bayVM(2)]`. No bay table, name or capacity field. Status is derived (§2.2).

### 1.7 Membership (a plan name on the appointment plus hard-coded display data)
- **Plans:** Essential, Premium, Executive, Exotic (a4's `'Premium Care'` is a Premium variant).
- **Badge colors (`memberMeta`):**

| plan | color | background |
|---|---|---|
| Essential | #7A8B73 | #E9EDE4 |
| Premium | #8A6D3B | #F2E9D6 |
| Executive | #3B5A8A | #E0E8F4 |
| Exotic | #7A3B8A | #EEDFF2 |

- **Card tint (`planTint`):** Essential `#5E7A52`, Premium `#8A6D3B`, Executive `#3B5A8A`, Exotic `#7A3B8A`.
- **Perks (`perksByPlan`):**
  - Essential: `2 express washes / month`, `Priority booking`, `10% off add-ons`, `Free vacuum anytime`
  - Premium: `2 premium washes / month`, `Skip-the-line priority`, `15% off all add-ons`, `Monthly interior refresh`, `Free rain repellent`
  - Executive: `Unlimited express washes`, `2 executive details / month`, `20% off add-ons`, `Dedicated detailer`, `Loaner coordination`
  - Exotic: `Unlimited hand washes`, `Concierge pickup & delivery`, `Paint protection reviews`, `25% off all services`, `Private appointment windows`
- **Hard-coded membership data:** `renewDate:'Jul 12, 2026'` for everyone, credits, months active and risk as in §3.8.

### 1.8 Message / conversation
Per appointment, not per customer. There is no thread entity.

- **Fields:** `{from:'staff'|'system'|<anything else = inbound customer>, text, time, channel}`.
- **Time:** a display string like `'Yesterday 4:02 PM'` or `'10:36 AM'`, not a timestamp.
- **Channels:** `'WhatsApp'`, `'Internal'`, `'Email + WhatsApp'`, `'Automation'`, `'System'`.
- **Rendering:** outbound (`staff` or `system`) is right-aligned. `system` bubbles show the tag `'Automated · '+channel`. Inbound customer messages are supported by the renderer but never created.
- **Templates:** 7 quick replies (§3.9). The free-text input is a non-functional placeholder, `Type a message…`.

### 1.9 Activity log entry
`{time, text, channel}`. The log is not shown in any tab (no Activity tab). It is written by every mutation and is effectively the audit trail.

### 1.10 Visit history entry
`{day:'02', mon:'MAY', service, note, amount:'$129', fav:bool}`.
- `day` is `String(2+i*5).padStart(2,'0')`, giving 02, 07, 12, 17.
- `mon` is `['MAY','APR','MAR','FEB'][i]`.
- Fixture appointments get `histPool.slice(0, 3 + idx%2)`. Generated days get the 3-entry `HIST`.
- Fully fabricated.

### 1.11 Photo / document
Counts only, in 4 categories:

| category | `photos` key | tag text |
|---|---|---|
| Arrival | `arrival` | always "Captured" |
| Before | `before` | "Captured" / "Pending" |
| After | `after` | "Captured" / "Pending" |
| Damage / Issues | `issue` | "Flagged" / "None"; unit is `N notes` rather than `N photos` |

- Per category the UI renders up to 3 thumbnail placeholders plus one dashed "+ add" tile. The tile has no handler.
- Seed counts: `arrival = (status==='booked') ? 0 : 2`. Note this also gives 2 for `confirmed`. `before = 3` if cleaning or completed. `after = 2` if completed. `issue = (idx%4===0) ? 1 : 0` for fixtures.

### 1.12 Invoice / payment
Derived live by `total()` (§3.1). No invoice id, line-item table, payment records, or method list. Display only:
- `payMethod`: `'Visa ···· 4421'` if paid, else `'No payment on file'` (hard-coded).
- Invoice rows: package, `+ addon` rows, optional `Tip`, `Tax (7%)`, `Total`, and when `pay==='deposit'` a `Deposit paid` row showing `– $X`.

### 1.13 Alert ("Needs Attention")
Computed on every render, not persisted. Shape: `{glyph, title, desc, actionLabel, action(), open(), pri, tone}`. Rules are in §3.9.

### 1.14 Arrival event
No entity. Represented by appointment fields `eta`, `geoIn`, `prepped`, plus log and message entries.

### 1.15 Emergency closure
Read from `localStorage['oasis-emergency']`. Observed fields: `active` (bool) and `summary` (string). Other fields live in the Settings design. Only effect here is the banner:
- Text: `Emergency closure active · {summary}`.
- Link: "Manage" → `Oasis Settings.dc.html#emergency`.

### 1.16 Calendar day / hours / closures
- **DEF_HOURS:** indexed by `getDay()` (0 = Sunday), each `{open, from, to}`:

| day | open | hours |
|---|---|---|
| Sun | true | `9:00 AM`–`3:00 PM` |
| Mon–Fri | true | `8:00 AM`–`6:00 PM` |
| Sat | true | `8:00 AM`–`5:00 PM` |

- **DEF_CLOSURES:** `{date:'YYYY-MM-DD', name, type:'closed'|'reduced', from?, to?}`:

| date | name | type | hours |
|---|---|---|---|
| 2026-05-25 | Memorial Day | closed | |
| 2026-06-03 | Weather closure | closed | |
| 2026-07-04 | Independence Day | closed | |
| 2026-09-07 | Labor Day | reduced | `10:00 AM`–`2:00 PM` |
| 2026-11-26 | Thanksgiving | closed | |
| 2026-12-24 | Christmas Eve | reduced | `8:00 AM`–`1:00 PM` |
| 2026-12-25 | Christmas Day | closed | |

- **Overrides:** `localStorage['oasis-hours']` and `['oasis-closures']`, written by Settings.

### 1.17 Other persisted client preferences
- `oasis-theme`: `'light'|'dark'`, default `'light'`.
- `oasis-checklists`, `oasis-hours`, `oasis-closures`, `oasis-emergency` (above).

---

## 2. State machines

### 2.1 Appointment status
`ORDER = ['booked','confirmed','arrived','cleaning','completed']`

`nextStep(a)` gives:

| status | button label | `to` | `hintFor` text | toast title / desc |
|---|---|---|---|---|
| booked | Confirm Appointment | confirmed | `Customer hasn’t confirmed — send the reminder` | `Confirmation sent` / `Reminder via WhatsApp` |
| confirmed | Mark Arrived | arrived | `Mark arrived once the customer pulls in` | `Marked arrived` / `Internal team notified` |
| arrived | Start Cleaning | cleaning | `Drag the card onto an open bay, or start the wash here` | `Cleaning started` / `In-progress message sent` |
| cleaning | Mark Complete | completed | `Wash finished — mark complete and move it to pickup` | `Job completed` / `Ready-for-pickup sent · moved to pickup` |
| completed and `balance(a)>0` | Collect Payment | pseudo-state `pay` | `Collect $X before release` | `Payment collected` / `Receipt sent` |
| completed and balance is 0 | none (card label `Completed`; modal chip `Job Complete`) | | `Job complete — closed and archived` | |
| canceled, noshow, other | none | | | |

**Side effects of `advance(id)`** (messages and log are appended via `ensureActivity` first; `clock = nowClock()`):

| to | log (channel) | message |
|---|---|---|
| confirmed | `Confirmation + reminder sent` (WhatsApp) | `Your appointment is confirmed for {time}.` |
| arrived | `Arrival logged` (Internal) | none |
| cleaning | `In-progress message sent` (WhatsApp) | `Your vehicle is now being cleaned.` |
| completed | `Ready-for-pickup sent` (WhatsApp) | `Your vehicle is ready for pickup!` |
| pay | `Payment captured · receipt sent` (Email + WhatsApp) | `Payment received — receipt sent. Thank you!` |

Other changes per transition:
- `cleaning`: sets `startedAt = Date.now()`.
- `completed`: sets `pickup = pickup || 'pending'`, `notified = true`, and `setFrac(a,1)` (all checklist tasks forced to checked).
- `pay`: sets `pay='paid'`. The status stays `completed`, and `deposit` is not zeroed.

**Other transitions that bypass `advance`:**
- `assignToBay(id, n)` (drag-drop onto a bay): sets `bay=n`, `status='cleaning'`, `startedAt=now`. See guards below.
- `simArrive(id)`: sets `status='arrived'`, `geoIn=clock`, `eta=null`, `late=false`.
- `reschedule(a, hr)`: changes only `time`, and clears `late`.

**Guards:**
- **`assignToBay`:**
  - Reject if `inFacility(a)` (status is cleaning). Toast `Already in a bay` / `That vehicle is in Bay {a.bay}`.
  - Reject if another appointment has `bay===num && status==='cleaning'`. Toast `Bay {n} is busy` / `Finish {FirstName}’s vehicle first`.
  - There is NO guard on source status, so booked, confirmed and arrived all jump straight to cleaning. There is also no guard against `completed` (the UI blocks it only via `canDrag`).
  - There is no `day` guard, so a tomorrow appointment can be dragged into a bay now.
- **`advance` "Start Cleaning" has no bay guard.** It does not check bay occupancy or that `bay` is non-null. A cleaning job with `bay=null` is invisible on the Bay board.
- **`canDrag(a)`** is `!inFacility(a) && status!=='completed'`. In practice booked, confirmed and arrived are draggable. This governs both drag-to-bay and calendar reschedule.
- **Reschedule guard:** if `!canDrag`, toast `Can’t move this job` / `It’s already in progress or done`.
- **Reverse transitions** exist only for payment (`togglePay`) and pickup (`togglePickup`). There is no un-advance and no cancel or no-show command.

### 2.2 Bay status (derived)
`occ = appts.find(a => a.bay===num && status==='cleaning')`
- **No `occ`:** the bay shows "Available". The tag is neutral. `nextUp` is `Next: {cust.name} · {time}` (first appointment in `sorted` with `bay===num`, not cleaning, not completed) or `No vehicles queued`.
- **`occ`:** the badge uses the status meta (always "In Wash"). The card shows elapsed time, Est. completion and a progress bar, plus Worker initials (`occ.staff` initials).
- **Maintenance, blocked or out-of-service bay states do not exist.** The `Bay board` header counter is `{n} in facility` (count of cleaning).

Bay card fields, formulas and copy:
- **elapsed** is `m:ss` from `startedAt`.
- **pct** is `min(100, elapsedMin/dur*100)`.
- **Est. completion** is `fmtT(parseT(occ.time) + occ.dur)`, i.e. scheduled start plus duration, not actual start plus duration. For a4 that is `11:15 AM`.
- **Progress copy:** `{round(pct)}% complete` and `{dur} min total`.
- **Buttons:** primary `nextLabel` (`Mark Complete` while cleaning) and `Open File`.
- **Free-bay copy:** `Bay open`, `Drag or long-press a card onto this bay`, and the `Assign next vehicle` button. That button opens the modal for `next`, or toasts `Nothing queued` / `No vehicles waiting for Bay {n}`.

### 2.3 Payment status
`pay ∈ {unpaid, deposit, paid}`.

| command | transition |
|---|---|
| `togglePay` | paid → unpaid, or (unpaid or deposit) → paid |
| `collect` ("Mark Paid · $X") | any → paid (also tries `ready → paid`, dead code) |
| `advance` pseudo-step `pay` | any → paid |

- `togglePay` to paid: log `Payment captured · receipt sent` (Email + WhatsApp) plus system WhatsApp `Payment received — receipt sent. Thank you!`. Toast `Payment collected` / `Receipt sent to customer`.
- `togglePay` to unpaid: log `Marked unpaid · balance reopened` (Internal). Toast `Marked unpaid` / `Balance reopened`. A deposit is lost in this transition, because `pay` becomes `'unpaid'` while `deposit` is retained but unused.
- `collect` logs the same as the paid path. Toast `Payment collected` / `Receipt sent to customer`.
- **Not enforced:** nothing requires payment before pickup or completion. The hint merely says "Collect $X before release".

### 2.4 Pickup status
`null → 'pending'` on completion (or at seed for completed jobs). `togglePickup` flips pending and collected:
- to collected: log `Vehicle released to customer` (Internal). Toast `Vehicle picked up` / `Released to {FirstName}`.
- to pending: log `Pickup reopened`. Toast `Pickup reopened` / `Back to ready for pickup`.

There is no guard on payment state, and no pickup message is sent.

### 2.5 Checklist progress
- Toggle a task, toggle a section ("Check all"/"Clear", with its own "full" check), or toggle all ("Check all"/"Clear all").
- `checkAll` shows a toast only for the global toggle (`quiet=true` for section toggles):
  - `All tasks checked` / `{n} tasks marked done`, or
  - `Checklist cleared` / `{n} tasks reset`.
- Section count label is `{done} / {total}`. The header reads `{done} of {total} tasks complete` plus a `pct%` ring.
- **No coupling to status in the design:** marking all tasks does not auto-advance the job, and the cleaning to completed transition forces all tasks checked.
- Adding or removing an add-on rebuilds the section list (§3.7). Check keys for removed add-ons persist in the map but are not counted. Re-adding restores them.

### 2.6 Job-modal stage tracker
Five stages with labels `Booked, Confirmed, Arrived, In Wash, Done`. For `curIdx = ORDER.indexOf(status)`, stages before it show ✓ (done), the current stage shows its number, and later ones are grey. A completed job shows "Done" as current, not done-with-✓.

### 2.7 Arrival lifecycle
confirmed or booked with `eta` → (`Prep bay` sets `prepped`, optional) → `Simulate arrival` → status `arrived`, `geoIn=clock`, `eta=null`, `late=false`. See §3.10.

### 2.8 Emergency
`emergency.active` toggles the banner only (§1.15).

---

## 3. Business rules & formulas

### 3.1 Pricing, tax, balance (exact)
```
addon  = Σ addon.price
sub    = a.price + addon
credit = a.member ? Math.min(a.price, a.member==='Exotic'?0:0) : 0   // ALWAYS 0
tax    = Math.round((sub - credit) * 0.07)
grand  = sub - credit + tax + (a.tip||0)
balance(a): pay==='paid' → 0 ; pay==='deposit' → grand - (deposit||0) ; else grand
```
- Tax rate is 7%, rounded to a whole dollar. Tax applies to package plus add-ons, not to tip.
- Tip is included in `grand`, hence in "Revenue today" and "Pending payments".
- **Member credit / discounts are never applied**, though Premium has "1 credit" and the perks mention "% off". The design implies it but the code is inert.
- `money(n)` is `'$' + Math.round(n).toLocaleString('en-US')`. All money is shown in whole dollars, so cents are not modeled.
- **Seed totals (computed):**

| appt | sub | tax | tip | grand | balance |
|---|---|---|---|---|---|
| a1 | 85 | 6 | 8 | 99 | 0 |
| a2 | 375 | 26 | 20 | 421 | 0 |
| a3 | 154 | 11 | 0 | 165 | 165 |
| a4 | 184 | 13 | 0 | 197 | 0 |
| a5 | 260 | 18 | 0 | 278 | 228 (deposit 50) |
| a6 | 180 | 13 | 0 | 193 | 0 |
| a7 | 125 | 9 | 0 | 134 | 114 (deposit 20) |
| a8 | 45 | 3 | 0 | 48 | 48 |
| a9 | 540 | 38 | 0 | 578 | 0 |
| a10 | 45 | 3 | 0 | 48 | 48 |
| a11 | 650 | 46 | 0 | 696 | 696 |
| a12 | 130 | 9 | 0 | 139 | 0 |

### 3.2 Durations / ETA / est. completion
- **Duration:** `dur` is the package duration only. Add-ons do not add time.
- **Bay est. completion:** `fmtT(parseT(time) + dur)`.
- **Progress:** `elapsedMs/60000/dur*100`, capped at 100.
- **a4:** `startedAgo:27` means elapsed starts at about 27:xx and progress at about 36% (27/75).

### 3.3 Bay capacity / overbooking / "bay-aware slots"
**What the code actually does** (not an algorithm):
- Slot grid (new-appointment panel) is the hard-coded list `['10:30 AM','11:00 AM','11:30 AM','12:30 PM','1:00 PM','2:30 PM','4:00 PM','4:30 PM']`.
- `blocked = ['11:00 AM','1:00 PM']` renders greyed, `opacity .6`, `cursor not-allowed`. Click toast: `Slot unavailable` / `Would overbook a bay — override required`.
- `vipHeld = ['11:30 AM','12:30 PM']` renders label `{t} · VIP`. Click toast: `Held for VIP clients` / `Releases to everyone 48h before · VIP clients can book it now`. Slot not selectable in the prototype.
- Panel subtitle: `Booked slots respect bay capacity`. Section label: `Available slots — bay-aware`. Footer: `Greyed slots would overbook a bay — manager override required`.
- **No override UI exists.** There is no PIN, role check or reason capture, and no date picker.
- Defaults: `pickedService='Premium Hand Wash + Interior'`, `pickedSlot='2:30 PM'`. The slot list is the same regardless of selected package or date.

**Consistency check against fixtures (inference):**
- Blocked `11:00 AM` is consistent with a duration-aware interval overlap: bay 1 holds a4 (10:00–11:15), a6 (10:45), and bay 2 holds a5 (10:30–12:00), a8 (11:00).
- Blocked `1:00 PM` is consistent with the default 75-min package: it overlaps a9 (12:00–2:00, bay 1) and a10 (1:30, bay 2).
- The fixtures themselves already overlap within a bay: a4 and a6 on bay 1, and a5 and a8 on bay 2. The `bay` field is therefore a planned or preferred bay, not an exclusive reservation.

**PROPOSED algorithm** (matches the copy):
- A candidate `[start, start+dur)` is available if the number of bays free for the whole interval is ≥ 1.
- A bay is free if its other bookings, as `[time, time+dur)` intervals plus any cleaning job's remaining time, don't overlap.
- Otherwise the slot is `blocked`, and the manager may override with permission plus a reason, logged.
- Candidate slots come from the day's open window (hours or closure override) on a 30-minute grid, with last start at `close − dur`.
- `vipHeld` slots are blocked for non-VIP until 48h before the slot ("Releases to everyone 48h before").
- Drag-to-bay and calendar reschedule are not capacity-checked in the design, so decide whether they should be (§8).

### 3.4 Calendar day info (`dayInfo(d)`)
- Closure for `iso(d)`: if `type==='closed'` → `{closed: name}`.
- Else weekly hours `hours[d.getDay()]`; if `!open` → `{closed:'Regular day off'}`.
- Else open window `from/to` come from the closure's reduced hours if present, else the weekly hours.
- Returned values: `h0 = floor(parseT(from)/60)`, `h1 = ceil(parseT(to)/60)`, `from`, `to`, `note = closure ? name+' · reduced hours' : ''`.
- Day view sub-label: `[Today · ]{n} appointment(s) · [{note} · ]{fmtT(h0*60)} – {fmtT(h1*60)}`.
- **Today is never treated as closed** in the day view or the cells (`o!==0 && inf.closed`), so an emergency or holiday does not close today in the calendar.

### 3.5 Calendar counts
- **`countFor(o)`:**
  - `o===0` → count of fixture appointments with `day===0`.
  - Closed day → `0`.
  - Else `dayCount(o).n`, plus for `o===1` the fixture `day===1` appointments (+1).
- **`dayCount`:** `n = max(2, [4,6,6,7,7,9,10][dow] + floor(rnd()*4) - 1)`, where `rnd` is the seeded `mulberry32(o*7919 + 104729)`. If `inf.note` (reduced day) then `n = ceil(n/2)`.
- **Day grid:** rows are hours `h0..h1-1`. An appointment lands in the row `floor(parseT(time)/60)`. Appointments outside open hours are not rendered.
- **Week:** starts Sunday (`start = off - cd.getDay()`). Label is `Mon D – [Mon ]D, YYYY`. Per day: `dow`, `num`, `count`, `appointment(s)`, TODAY badge. Closed days show `Closed` plus the reason. Sub-label is `{tot} appointments this week · tap a day to open it`.
- **Month:** grid of `ceil((lead+dim)/7)*7` cells. Out-of-month cells at 55% opacity. Cells show `{n} appt(s)` or the closure reason. Sub-label is `{tot} appointments in {Month} · tap a date to open it`.
- **Navigation:**
  - ←/→ step ±1 day, ±7 days or ±1 month, depending on mode.
  - `T` returns to today.
  - A horizontal swipe on touch (|dx|>70 and |dx|>1.5×|dy| and <800 ms) steps the same way.
- **Calendar hint:** day mode `Drag or long-press to reschedule · swipe for next day`, other modes `Swipe or use ← → to move`.
- **Day-label format:** `Dow, Month D` (plus `, YYYY` if not 2026).

### 3.6 KPI strip (exact; the strip ignores search and range)
Terms: `all = all appts` (both days), `day0 = day===0`.

| label | value | sub | accent | notes |
|---|---|---|---|---|
| Appointments 24h | `all.length` (12 at seed) | `'12 booked'` HARD-CODED | `var(--accent)` | |
| Active jobs | count status==='cleaning' (1) | `in bays` | `#C2740B` | |
| Ready for pickup | count `completed && pickup!=='collected'` over all (1) | `notify` if >0 else `clear` | `#0E9E6E` | |
| Pending payments | count of day0 with `pay!=='paid'` and status not canceled/noshow (6) | `money(Σ balance)` ($1,299) | `#C2410C` | |
| Bay time free | `'3.5h'` HARD-CODED | `today` | `#2563EB` | |
| Members today | day0 with `member` (6) | `of {day0.length}` (of 11) | `#7A3B8A` | |
| Revenue today | `money(Σ total.grand)` over day0 with `pay==='paid'` ($1,488) | `paid` | `#0D9488` | |

- Revenue includes tips and tax. It counts deposit-only appointments as zero (they are `pay==='deposit'`, not `paid`).
- Three values are fixed text, not computed: "12 booked", "3.5h" and the 24h label. A formula for bay time free is §8.

### 3.7 Checklist generation and add-on updates
- Sections are rebuilt from the current package list plus `ADDON_TASKS[name]` (fallback `[name]`) on every render.
- `toggleAddon` flips membership in `a.addons`, so the invoice and checklist update instantly. The toast reads `Invoice + checklist updated` / `Added|Removed {name}`.
- **Bug-prone:** the Added/Removed word is computed from `this.byId(id)` after `setState`, which reads pre-update state, so it is likely inverted. Treat the intended behavior as "Added when adding, Removed when removing".
- Adding an add-on adds its price to the invoice (`+ {name}` row) and its tasks (unchecked). Removing deletes both.
- No status restriction: add-ons can be toggled on any status, including completed or paid. Toggling after payment leaves `pay==='paid'` with a changed total. See §8.
- On completion, all current tasks (package and add-ons) are forced to checked.
- Price is snapshotted when added.

### 3.8 Membership / retention (display logic only)
- **creditsLeft:** `'∞'` for Executive or Exotic, else `'1'`.
- **creditsUsed:** `'1'` if Premium, else `'0'`.
- **memberMonths:** `8 + (visits % 6)`.
- **renewDate:** `'Jul 12, 2026'` (constant).
- **Retention risk:**
  - `visits > 6`: label `Loyal · low risk`, desc `Consistent monthly usage — strong retention` (green).
  - Else: label `Watch · 1 missed visit`, desc `Down from 3 to 1 visit last month` (red `#C2410C`).
- **Upgrade:** members get a `Recommend upgrade →` button (no handler). Non-members see the card `Not a member yet` / `{name} is a strong upgrade candidate — 4 visits in 60 days. Offer Essential at check-out.` / button `Present membership offer`. The "upgrade candidate" claim is not computed, and "4 visits in 60 days" is static text.
- **Member credit alert** (blue, `◆`): find the first appointment with `member==='Premium'` (exact, so `'Premium Care'` is excluded), `status==='completed'` and `pay!=='paid'`. Title `Member credit available`, desc `{name} has 1 unused Premium credit this cycle`, action `Apply credit` (toast `Credit applied` / `1 Premium credit redeemed`, no state change).
- **History tab stats:** `visitCount = a.visits`, `lifetimeSpend = money(visits*148)`, `avgFreq = '18 days'` (constant). All fake.

### 3.9 "Needs Attention" alert generation
Evaluated in order. Within the appointment loop, per appointment in `appts` order; then the second loop; then the credit alert. Final sort is by `pri` descending, where `pri = 1` if the referenced appointment is VIP. The sort is stable, so within a priority the generation order stays.

| # | condition | tone / glyph | title | desc | action label (behavior) |
|---|---|---|---|---|---|
| 1 | `completed && pickup!=='collected'` | green `↑` | `Ready for pickup` | `{name}'s {make} is done` + (` · payment due` if `pay!=='paid'`) | `Mark picked up` (`togglePickup`) |
| 2 | `isLate(a)` | red `!` | `Running late · {name}` | `{time} {make} {model} — no arrival logged` | `Message customer` (toast `Reminder sent` / `WhatsApp to {name}`, no message created) |
| 3 | `bay===null && status!=='completed'` | amber `◳` | `Needs bay assignment` | `{name} · {svc}` | `Assign bay` (opens the modal; no bay-assign control exists there) |
| 4 | `status==='confirmed' && !eta && 0 < absMin(a)-NOW <= 15` | blue `→` | `Arriving soon` | `{name} in {n} min · {make} {model}` | `Prep bay {bay or —}` (toast `Bay prepped` / `Ready for {name}`) |
| 5 | `status==='booked'` | amber `?` | `Unconfirmed` | `{name} · {time} hasn't confirmed` | `Send reminder` (calls `advance`, i.e. it confirms) |
| 6 | `special` set | violet `★` | `Special instructions` | `{name}: {special.slice(0,46)}…` (the ellipsis is always appended) | `View file` |
| 7 | `eta && status in (confirmed, booked)` | violet if VIP else blue, `◎` | `VIP arriving in {eta} min · {name}` or `Arriving in {eta} min · {name}` | `Geofence ETA · {make} {model}` + (` · Bay {n}` if bay) | `Prep bay {n\|—}`, or `Bay ready ✓` once prepped (`prepBay`) |
| 8 | `geoIn && status==='arrived'` | green `✓` | `Auto checked in · {name}` | `Geofence at {geoIn} · vehicle in the lot` | `Start cleaning` (`advance`) |
| 9 | Premium member credit (above) | blue `◆` | | | |

- `NOW` is the constant `10*60+36` (10:36 AM), not the real clock. `absMin(a) = day*1440 + parseT(time)`.
- Every alert has an `Open` button (opens the modal on the Overview tab).
- **Expected seed alerts** (my computation; `pri=1` alerts first, so a6's and a11's alerts lead): rule 1 for a3; rule 2 and 3 for a7; rule 5 for a8 and a11; rule 6 for a11; rule 7 for a6 (VIP) and a8; rule 8 for a5; rule 9 for a3. No "Arriving soon" fires because a6 has an `eta`.
- `alertCount` is computed but not rendered.

### 3.10 Arrival simulation and prep-bay
- **Arrival card** (bays column, above the bays): shown for every appointment with `eta` and status in (confirmed, booked), sorted VIP first then ascending `eta`.
  - Title `{VIP arriving in |Arriving in }{eta} min · {name}`.
  - Desc `Geofence ETA · {year} {make} {model} · {svc.split(' + ')[0]}[ · Bay {n}]`.
  - Buttons: `Prep Bay {n|—}` (becomes `Bay {n} ready ✓` after prep) and `Simulate arrival`.
  - VIP uses violet styling (`#7A3B8A`).
- **`prepBay`:**
  - Sets `prepped = true`.
  - Log `Bay {bay} prepped for arrival` (Internal).
  - Toast `Bay {n} prepped` / `{VIP }{name} arrives in {eta} min`.
  - Not reversible, and no bay-availability check.
- **`simArrive`:**
  - Status becomes `arrived`.
  - `geoIn = now clock`, `eta = null`, `late = false`.
  - Log `Auto check-in · geofence` (Automation).
  - System WhatsApp `Welcome to Oasis! You’re checked in — pull into Bay {n}.` (the `— pull into Bay n` part is omitted if no bay).
  - Toast `Checked in automatically` / `{name} · welcome message sent`.
  - The real trigger would be a geofence event from the customer's phone.

### 3.11 Staff job counts
For each staff name, `jobs = sorted.filter(a => a.staff===name)`, where `sorted` is the search- and range-filtered, time-sorted list of ALL statuses (including completed, in-bay, and tomorrow's jobs). The header count is `jobs.length`, labeled `jobs`. Empty column text is `No jobs assigned`. Column cards show time, badge, name, vehicle line and service. There is no drag or assignment in this view.

### 3.12 Sorting, filtering, search, grouping
- **Search** (`/` focuses it; placeholder `Search customer, phone, plate, vehicle…   /`): case-insensitive substring over `[name, phone, make, model, color, plate, svc].join(' ')`. It applies to the timeline, staff, queue and completed lists, not to KPIs, the bays or alerts.
- **Range tabs** (hidden in Calendar view): `Next 24h` (`next24`, default), `Today`, `Tomorrow`, `Week`. Only Today and Tomorrow filter (`day===0` / `day===1`). `Next 24h` and `Week` apply no filter, and both show the 12 fixtures.
- **Order:** `sorted` is `absMin` ascending, tie broken by VIP first.
- **Timeline list:** `sorted` minus completed minus cleaning. Cards are grouped by key `day|time` into time rows (`h:mm` plus AM/PM column). Divider labels: first group `Today`; `Tomorrow` at the first day-1 group. Header `Appointment Timeline` and `{n} in 24h`.
- **Up Next queue** (Bay view): not cleaning, not completed, not `'paid'`, VIP-first, top 6.
- **Ready & Completed column:** every `status==='completed'` appointment from `sorted`, with count badge. Empty text: `No completed jobs yet. Finish a vehicle in a bay and it lands here for payment & pickup.`
  - Accent: green `#0E9E6E` if collected and paid; red `#C2410C` if unpaid; else amber `#B07908`.
  - Chips: `Paid` or `Unpaid · collect`, and `Picked up` or `Needs pickup`. Each chip toggles its state.
- **Synthetic day generator (`genDay`)**, for calendar days other than today and tomorrow, with the same seeded generator:
  - `n` from §3.5; slots every 30 min from `max(h0*60, o===1?11*60:0)` to `max(start, h1*60-60)`.
  - Staff cycles `['Marco R.','Lena K.','Sofia D.'][i%3]`; bay `(i%2)+1`.
  - Past days (`o<0`) are all `completed`, `paid`, `pickup:'collected'`. Future days are 70% `confirmed` and 30% `booked`.
  - Pay on future days: 45% paid, else 50% deposit, else unpaid; `deposit:25`.
  - Member 35% (random of Essential, Premium, Executive); add-on 40% (one random).
  - Names and vehicles are drawn from `POOL_NAMES` (20) and `POOL_VEH` (12). Phone is `(305) 2xx-xxxx` style.
  - Plate is the first 3 letters of the make plus a 4-digit number.
  - Tomorrow (`o===1`) shows the fixture a12 first, then generated rows.
  - The backend should drop this, but the calendar counts rule (§3.5) is the real requirement.

### 3.13 Clock / timezone / date
- `BASE = new Date(2026,5,13)` (Saturday, June 13, 2026) is the "today" anchor. `dateLabel` is the literal `'Saturday, June 13'`.
- **`clockLabel`** is `'Live · ' + nowClock()`, the browser local clock, re-rendered every 1 s via the `tick` interval.
- **`NOW`** (10:36 AM) is a separate constant used only for the "Arriving soon" alert. The display clock and `NOW` are not synchronized.
- All times are local `h:mm AM/PM` strings with no timezone and no seconds. Dates are local `YYYY-MM-DD`.
- Area codes (305, 786) suggest America/New_York, but the design never states it (§8).

### 3.14 Interaction rules that affect state
- **Timeline cards (context `tl`):**
  - **Touch:** long-press 380 ms starts a drag (with a 12 ms vibrate). A horizontal swipe (|dx|>12 and |dx|>1.4×|dy|) begins swiping; card translates clamped ±150 px. Release at dx>90 → `advance`; dx<-90 → open modal on the Messages tab. Any other release springs back.
  - **Mouse:** a move >6 px begins a drag.
  - **Hints:** the timeline header reads `Drag or long-press onto a bay · swipe right to advance, left to message`. The ghost hint is `Drop on an open bay` (timeline, queue) or `Drop on a new time` (calendar). Ghost shows `name` and `{year} {make} {model}`.
- **Drop targets:** `data-drop="bay:N"` runs `assignToBay`; `data-drop="hr:H"` runs `reschedule`. Queue cards (context `q`) and calendar cards (context `cal`) drag too; swipe works only in `tl`.
- **Reschedule:** new time is `fmtT(hr*60 + parseT(a.time)%60)` (the minute offset is preserved). No-op if unchanged.
  - System WhatsApp `Your appointment has been moved to {nt}. Reply if that doesn’t work.`
  - Log `Rescheduled to {nt}` (Internal), and `late=false`.
  - Toast `Moved to {nt}` / `{name} notified via WhatsApp`.
  - It changes only the time, not the day, and has no capacity or open-hours check.
- **Keyboard:**
  - Always: `Esc` closes the modal and the new-appointment panel; `/` focuses search; `N` opens a new appointment. Inside inputs, only `Esc` (blur) works.
  - Calendar view, no modal open: `←`, `→`, `T`.
  - With a modal open: `M` → toast `Message composer opened` / `WhatsApp to {name}` (just a toast); `P` → Payments tab; `S` or `R` → `advance`.
- **Theme toggle** persists to `oasis-theme`.

---

## 4. Commands (mutations) and proposed REST endpoints

Common PROPOSED rules for all commands: auth is the staff user (manager role for overrides), writes go through one transaction that also appends an `activity_log` row and any outbound `message`, and the server returns the updated appointment read model. Base path `/api/v1`. All appointment endpoints return `409` on a state-guard violation with the design's toast text as `error.message`.

| # | Command (design source) | Inputs | Design validation | Outputs / side effects | PROPOSED endpoint |
|---|---|---|---|---|---|
| 1 | Confirm / advance (`advance`, Next buttons, swipe right, `S`/`R` keys, alert actions `Send reminder` and `Start cleaning`) | `id` | Status must have a next step | See §2.1 per-transition log and message | `POST /appointments/{id}/advance` (no body), or explicit `POST /appointments/{id}/transitions {to:'confirmed'\|'arrived'\|'cleaning'\|'completed'}` |
| 2 | Assign to bay by drag-drop (`assignToBay`) | `id`, `bay` (1 or 2) | Not already cleaning; bay not occupied by another cleaning job | Sets bay and status `cleaning`, `startedAt`; log `Assigned to Bay {n} · cleaning started` (Internal); WhatsApp `Your {make} is now being cleaned.`; toast `Moved to Bay {n}` / `{name} · cleaning started` | `POST /appointments/{id}/assign-bay {bay}` |
| 3 | Plan a bay without starting (no UI in the design; needed by alert "Assign bay") | `id`, `bay\|null` | Bay exists | Sets `bay` only | `PATCH /appointments/{id} {bay}` (PROPOSED) |
| 4 | Reschedule (`reschedule`, calendar drop) | `id`, new `time` (minute offset preserved in UI), day | Not cleaning or completed | Time change; WhatsApp `Your appointment has been moved to {nt}. Reply if that doesn’t work.`; log; clears `late` | `POST /appointments/{id}/reschedule {start}` |
| 5 | Toggle pay (`togglePay`, completed-column chip) | `id` | none | See §2.3 | `POST /appointments/{id}/payments/mark-paid` and `POST /appointments/{id}/payments/mark-unpaid` |
| 6 | Mark paid (`collect`, modal `Mark Paid · $X`, advance `Collect Payment`) | `id` (amount = balance) | `pay!=='paid'` | `pay='paid'`; log `Payment captured · receipt sent`; WhatsApp `Payment received — receipt sent. Thank you!`; toast `Payment collected` / `Receipt sent to customer` | `POST /appointments/{id}/payments {method, amount}` |
| 7 | Send payment link (modal `Send payment link`) | `id` | none | Toast `Payment link sent` / `Secure link via WhatsApp`; no state change in the design | `POST /appointments/{id}/payment-links` |
| 8 | Toggle pickup (`togglePickup`, chip, alert `Mark picked up`) | `id` | none | See §2.4 | `POST /appointments/{id}/pickup {state:'collected'\|'pending'}` |
| 9 | Notify ready (`notify`, no UI trigger) | `id` | none | `notified=true`; WhatsApp `Your vehicle is ready for pickup!`; log `Ready-for-pickup sent`; toast `Customer notified` / `Ready-for-pickup sent via WhatsApp` | `POST /appointments/{id}/notify-ready` |
| 10 | Add or remove add-on (`toggleAddon`) | `id`, `name`, `price` | none | Adds or removes `{name, price}`; checklist and invoice recompute; toast `Invoice + checklist updated` / `Added\|Removed {name}` | `PUT /appointments/{id}/addons/{addonId}` and `DELETE …/{addonId}`; server takes the price from the catalog, not the client |
| 11 | Toggle one checklist task (`toggleCheckKey`) | `id`, `key` | none | Flips the check | `PUT /appointments/{id}/checklist/{taskKey} {done}` |
| 12 | Check or clear a section / all (`checkAll`) | `id`, keys, `val`, quiet | none | Bulk set. Global toggle toasts `All tasks checked` / `{n} tasks marked done` or `Checklist cleared` / `{n} tasks reset` | `POST /appointments/{id}/checklist/bulk {keys, done}` |
| 13 | Send template message (`sendTemplate`) | `id`, `text` | none | Appends staff WhatsApp message; log `Staff message sent` (WhatsApp); toast `Message sent` / `Delivered via WhatsApp` | `POST /appointments/{id}/messages {text, channel:'whatsapp', templateKey?}` |
| 14 | Free-text message (input and send button, no handler) | `id`, `text` | n/a | n/a | same as 13 |
| 15 | Add photo (the "+" tile, no handler) | `id`, `category`, file | n/a | Increments the category count | `POST /appointments/{id}/photos` (multipart: `category`, `file`) and `DELETE …/{photoId}` |
| 16 | Prep bay (`prepBay`) | `id` | none | `prepped=true`; log `Bay {n} prepped for arrival` (Internal); toast `Bay {n} prepped` / `{VIP }{name} arrives in {eta} min` | `POST /appointments/{id}/prep-bay` |
| 17 | Simulate arrival (`simArrive`) | `id` | none | See §3.10. Real equivalent is a geofence webhook | `POST /appointments/{id}/arrive {source:'manual'\|'geofence'}`. Demo-only `POST /dev/appointments/{id}/simulate-arrival` |
| 18 | Alert "Message customer" for late (toast only) | `id` | none | Toast `Reminder sent` / `WhatsApp to {name}`. Should send the late-nudge template | `POST /appointments/{id}/messages` with a late-reminder template |
| 19 | Apply member credit (toast only) | `id` | none | Toast `Credit applied` / `1 Premium credit redeemed` | `POST /appointments/{id}/membership-credit/redeem` |
| 20 | Create appointment (`Book Appointment`; toast only) | Form: full name, phone, WhatsApp opt-in (chip), year/make/model, plate, package, slot. Defaults: package `Premium Hand Wash + Interior`, slot `2:30 PM` | Slots: blocked → toast `Slot unavailable` / `Would overbook a bay — override required`; VIP-held → toast `Held for VIP clients` / `Releases to everyone 48h before · VIP clients can book it now` | Toast `Appointment booked` / `{package} · {slot}`. Needs: customer upsert by phone, vehicle upsert by plate, appointment `status:'booked'`, optional deposit link | `POST /appointments {customer, vehicle, packageId, start, bayOverride?:{reason}, source:'dashboard'}` |
| 21 | Create walk-in (`Walk-in` button; same panel, title `Walk-in Booking`) | same as 20 | same as 20 | PROPOSED: sets `walkin=true`, starts at now | `POST /appointments {…, source:'walk-in'}` |
| 22 | Slot availability (panel list) | date, packageId | see §3.3 | Slots with state `available\|blocked\|vip_held` | `GET /availability?date&packageId&vip=` |
| 23 | Theme preference | `light\|dark` | none | Persists `oasis-theme` | `PUT /me/preferences {theme}` |
| 24 | Cancel / no-show / delete | | not in the design (statuses exist only as label entries) | | PROPOSED `POST /appointments/{id}/cancel`, `/no-show` |

Notes:
- **Row 10 server rule:** the price is always read from the catalog, because the client currently sends it.
- **Row 12 payload shape:** `keys` is the list of check keys, `done` true or false.

---

## 5. Queries / read models

**Dashboard shell (every view)**
- Header: user (name, role, initials), the notification-bell dot (no data behind it), emergency state (`active`, `summary`), live clock, and date label.
- KPI strip: the 7 values in §3.6, computed server-side (including a real "Bay time free" and "booked" count).

**Timeline view** (3 columns)
- Column 1: upcoming appointments (not completed, not in bay) for the window, grouped by start time. Each card needs: `id`, `name`, vehicle line, service, time, `status` (or `Late`), bay label, `Est. {dur} min`, pay label, flags (notes, photos before+after>0, addon count), VIP, member plan, `nextLabel`, and `canDrag`.
- Column 2: bays (state, occupant, worker, `startedAt`, `dur`, est. completion), plus the arrivals list with ETAs.
- Column 3: completed jobs with `pay` and `pickup`.
- Window: `Next 24h` (today and tomorrow in the fixtures), `Today`, `Tomorrow`, `Week`. Search filters by customer name, phone, vehicle, plate, service.

**Bay board view:** two bay cards, the Up Next queue (6 items), and the Needs Attention alerts (§3.9).

**Staff view:** per staff, a job list and count, with the same filters.

**Calendar view:**
- Day: appointments for the date plus open window, closure or closed reason.
- Week: 7 counts plus closure reasons.
- Month: per-day counts plus closure reasons.
- Needs hours, closures and appointments-per-day aggregates.

**Appointment file (modal)** needs:
- Overview: customer, vehicle, appointment, notes and special instructions.
- Checklist sections with check state.
- Add-on catalog with selected flags.
- Photo counts and files per category.
- Messages (conversation).
- Invoice rows and totals.
- Membership: plan, perks, credits, renewal date, retention status.
- History: visit count, lifetime spend, average cadence, and past visits.

**Refresh / realtime needs**
- A 1 s UI tick drives bay timers. Elapsed time should be computed client-side from `startedAt`, so no per-second polling.
- Server pushes (PROPOSED SSE or WebSocket): appointment status or bay changes, inbound WhatsApp messages, payment status (link paid), geofence ETA and arrival, photo uploads, emergency toggles, and settings changes (hours, closures).
- A fallback poll of 15–30 s on the board and KPI endpoints.
- ETAs change continuously, so push them.

---

## 6. Integrations & background jobs implied

- **WhatsApp Business:** all outbound templates in §3.9 and §4. The modal shows `WhatsApp opted-in` (opt-in is a per-customer flag, toggled by the `WhatsApp` chip on the new-appointment form).
  - Needs inbound handling, because the renderer supports customer messages.
  - Needs delivery status.
  - Needs template approval.
  - Needs opt-in / opt-out handling.
- **Template triggers:**
  - confirmation and reminder at booking and confirm;
  - check-in / welcome (geofence);
  - in-progress (cleaning started);
  - ready for pickup (job complete);
  - payment receipt;
  - reschedule notice.
  - The legacy auto-timeline also references a review-request message: `Thanks for visiting Oasis Auto Spa! How did we do? ⭐` with log `Job closed · review request scheduled` (channel Automation). Not wired to a transition in the current code.
- **Payment links and receipts:** a secure link via WhatsApp; capture on payment; receipt via `Email + WhatsApp`; deposit link at booking (`Booking created · deposit link sent`, channel System). Card on file appears as `Visa ···· 4421`.
- **Geofence / location arrival:** customer-app or phone ETA feed producing `eta` minutes, and an auto check-in event when the customer enters the lot. Prep-bay is the human action.
- **Photo storage:** object storage for arrival, before, after and issue photos, with thumbnails. Also implies a customer-facing handover set ("Photographic handover" is a task on the Exotic package).
- **Emergency closure:** `active` plus `summary` come from Settings and drive the banner. The design shows no impact on bookings, slots or notifications (§8).
- **Hours, holidays and closures:** drive calendar open windows, counts and closed-day messaging, and should drive slot availability.
- **Scheduled / background jobs (PROPOSED):**
  - appointment reminder sends;
  - VIP-hold release at 48 h before the slot;
  - late detection (`late` flag from clock);
  - membership credit cycle reset and renewals;
  - retention-risk and upgrade-candidate scoring;
  - review request after job completion;
  - ETA staleness cleanup.
- **Auth and roles:** manager override of slot blocks, and a user with initials, name and role.

---

## 7. Seed fixtures

Customers and vehicles are inline on appointments, so they are flattened below.

### 7.1 Staff
Marco R. (Lead Detailer), Lena K. (Detailer), Sofia D. (Front Desk), plus the pseudo-assignee Unassigned (Queue). Manager user: Rafael M., initials RM, Manager.

### 7.2 Bays
Bay 1, Bay 2.

### 7.3 Packages (price, dur min; task list after removing "inspection" items)

| package | price | dur | tasks |
|---|---|---|---|
| Express Hand Wash | 45 | 35 | Exterior rinse; Hand wash; Wheel cleaning; Hand dry & towel; Glass & windows |
| Premium Hand Wash + Interior | 129 | 75 | Exterior pre-rinse; Two-bucket hand wash; Wheel & tire cleaning; Tire shine; Interior vacuum; Dashboard & console wipe; Streak-free windows |
| Premium Hand Wash + Interior Refresh | 139 | 75 | Exterior pre-rinse; Two-bucket hand wash; Wheel & tire cleaning; Tire shine; Interior vacuum; Dashboard & vents wipe; Leather seat refresh; Streak-free windows |
| Executive Detail | 260 | 90 | Foam pre-soak; Two-bucket hand wash; Clay bar treatment; Wheel & caliper detail; Tire dressing; Full interior vacuum; Leather conditioning; Dashboard & vents detail; Streak-free glass; Spray sealant |
| Executive Detail + Ceramic | 420 | 120 | Foam pre-soak; Two-bucket hand wash; Iron decontamination; Clay bar treatment; Ceramic spray coat; Wheel & caliper detail; Full interior detail; Leather conditioning; Streak-free glass |
| Full Detail | 320 | 120 | Engine bay degrease; Foam pre-soak; Hand wash; Clay bar; Wheel deep clean; Carpet shampoo; Full interior vacuum; Leather treatment; Glass polish; Wax & seal |
| Ceramic Maintenance + Wax | 180 | 60 | Pre-rinse; pH-neutral hand wash; Ceramic boost spray; Hand-applied wax; Wheel cleaning; Tire dressing; Glass treatment |
| Exotic Detail Package | 650 | 150 | Hand-dry pre-inspection; Waterless decon; Two-bucket hand wash; Paint correction pass; Ceramic seal; Wheel & caliper detail; Full interior detail; Leather conditioning; Glass & trim restore; Photographic handover |
| Family Wash + Pet Hair | 95 | 50 | Exterior rinse; Hand wash; Pet hair removal; Interior vacuum; Dashboard wipe; Windows; Odor neutralize |

Source lists include `Final inspection` (all packages except Express) and `Hand-dry pre-inspection` was NOT removed (the regex `/inspection/i` matches it!). Correction: the filter removes any item containing "inspection". That removes `Hand-dry pre-inspection` from Exotic too. So Exotic's effective list has 9 items: Waterless decon; Two-bucket hand wash; Paint correction pass; Ceramic seal; Wheel & caliper detail; Full interior detail; Leather conditioning; Glass & trim restore; Photographic handover. The table row above should drop "Hand-dry pre-inspection". The counts used in my math (Exotic = 9) are correct for that.

Effective task counts per package after filtering: Express 5, Premium+Interior 7, Interior Refresh 8, Executive Detail 10, Executive+Ceramic 9, Full Detail 10, Ceramic Maintenance 7, Exotic 9, Family Wash 7.

### 7.4 Add-ons (price; tasks)

| add-on | price | tasks |
|---|---|---|
| Interior deep clean | 60 | Deep vacuum seats & carpets; Steam clean vents & cupholders; Wipe door jambs & panels |
| Pet hair removal | 35 | Rubber-brush pet hair; Lint-roll upholstery; Vacuum seat seams |
| Leather conditioning | 45 | Clean leather surfaces; Apply conditioner; Buff to matte finish |
| Wax | 40 | Apply carnauba wax; Buff off haze |
| Clay bar | 50 | Lubricate panels; Clay bar paint; Wipe residue |
| Odor removal | 30 | Enzyme treatment on fabrics; Odor neutralizer cycle |
| Engine bay cleaning | 55 | Cover electricals; Degrease engine bay; Dress plastics |
| Ceramic maintenance | 120 | Ceramic boost spray; Buff & level coating |
| Rain repellent | 25 | Clean glass; Apply rain repellent to windshield |
| Wheel deep clean | 40 | Remove wheel fallout; Clean barrels & calipers; Seal wheel faces |

### 7.5 Appointments (today = June 13, 2026; NOW = 10:36 AM)

| id | day | time | status | staff | customer / phone | vehicle (year make model, color, plate) | service | bay | member | pay (dep) | add-ons | extras |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| a1 | 0 | 8:30 AM | completed | Lena K. | Maria Delgado (305) 412-8890 | 2021 Audi Q5, Pearl White, KLP-8842 | Express Hand Wash | 2 | Essential | paid | Wax | tip 8; pickup collected |
| a2 | 0 | 9:15 AM | completed | Marco R. | David Okafor (786) 220-1144 | 2019 Ford F-150, Magnetic Gray, FRD-1190 | Full Detail | 1 | null | paid | Engine bay cleaning | tip 20; pickup collected |
| a3 | 0 | 9:45 AM | completed | Lena K. | Priya Nair (305) 778-3321 | 2022 Tesla Model Y, Midnight Silver, TES-2210 | Premium Hand Wash + Interior | 2 | Premium | unpaid | Rain repellent | notified true; pickup pending; notes `Customer prefers no fragrance products. Parked in the south lot.` |
| a4 | 0 | 10:00 AM | cleaning | Marco R. | Jonathan Franco (305) 904-7781 | 2023 Mercedes-Benz GLE, Obsidian Black, ABC-1234 | Premium Hand Wash + Interior Refresh | 1 | Premium Care | paid | Leather conditioning | vip; startedAgo 27; notes `Regular — every other Saturday. Likes a text when 10 min out.` |
| a5 | 0 | 10:30 AM | arrived | Sofia D. | Sofia Marchetti (786) 551-9080 | 2024 Porsche Macan, Carmine Red, POR-9911 | Executive Detail | 2 | Executive | deposit (50) | none | geoIn 10:27 AM; notes `New ceramic coating — pH-neutral products only.` |
| a6 | 0 | 10:45 AM | confirmed | Marco R. | Liam Chen (305) 233-7765 | 2020 BMW M340i, Alpine White, BMW-3401 | Ceramic Maintenance + Wax | 1 | null | paid | none | vip; eta 12 |
| a7 | 0 | 10:15 AM | confirmed | Unassigned | Marcus Webb (786) 119-4420 | 2017 Jeep Wrangler, Sarge Green, JEP-7720 | Family Wash + Pet Hair | null | null | deposit (20) | Odor removal | late true |
| a8 | 0 | 11:00 AM | booked | Sofia D. | Grace Adeyemi (305) 660-2231 | 2018 Lexus RX 350, Silver Lining, LEX-0455 | Express Hand Wash | 2 | null | unpaid | none | eta 22 |
| a9 | 0 | 12:00 PM | confirmed | Marco R. | Aisha Rahman (786) 442-1209 | 2023 Range Rover Sport, Santorini Black, RR-5567 | Executive Detail + Ceramic | 1 | Exotic | paid | Ceramic maintenance | |
| a10 | 0 | 1:30 PM | confirmed | Sofia D. | Tom Bradley (305) 887-0042 | 2016 Honda Civic, Aegean Blue, HND-2218 | Express Hand Wash | 2 | null | unpaid | none | |
| a11 | 0 | 3:00 PM | booked | Marco R. | Elena Volkov (786) 998-0001 | 2022 Lamborghini Urus, Giallo Inti, URS-0001 | Exotic Detail Package | 1 | Exotic | unpaid | none | vip; special `Hand-dry only — no automated equipment near paint. Owner inspects before release.` |
| a12 | 1 | 9:00 AM | confirmed | Lena K. | Nathan Brooks (305) 320-7788 | 2021 Chevrolet Tahoe, Summit White, CHV-6610 | Family Wash + Pet Hair | 2 | Essential | paid | Pet hair removal | |

Derived seed values per `idx` (position in the array: a1=0 … a12=11):

| id | visits | photos (arr/bef/aft/issue) | checklist total, done | history rows |
|---|---|---|---|---|
| a1 | 3 | 2/3/2/1 | 7, 7 | 3 |
| a2 | 4 | 2/3/2/0 | 13, 13 | 4 |
| a3 | 5 | 2/3/2/0 | 9, 9 | 3 |
| a4 | 6 | 2/3/0/0 | 11, 6 | 4 |
| a5 | 7 | 2/0/0/1 | 10, 0 | 3 |
| a6 | 8 | 2/0/0/0 | 7, 0 | 4 |
| a7 | 9 | 2/0/0/0 | 9, 0 | 3 |
| a8 | 10 | 0/0/0/0 | 5, 0 | 4 |
| a9 | 11 | 2/0/0/1 | 11, 0 | 3 |
| a10 | 3 | 2/0/0/0 | 5, 0 | 4 |
| a11 | 4 | 0/0/0/0 | 9, 0 | 3 |
| a12 | 5 | 2/0/0/0 | 10, 0 | 4 |

- Retention label from `visits>6`: Loyal for a5 to a9; Watch for the rest. Months active is `8 + visits%6`; lifetime is `visits*148`.
- **Fixed defaults on every fixture:** `whatsapp:true`, `notified:true`, `special:null` (except a11), and `notes` default `No special instructions on file.`
- Check totals above come from package list length plus add-on tasks. a4's 6 comes from `round(11*0.5)`.

### 7.6 Lazy-built activity (`ensureActivity`)
- First message (all): `{staff}`: `Hi {FirstName}, thanks for booking with Oasis Auto Spa.`, time `Yesterday 4:02 PM`, channel WhatsApp.
- First log (all): `Booking created · deposit link sent`, `Yesterday 4:02 PM`, channel System.
- For each status in ORDER after `booked` up to the current status, append:
  - confirmed → log `Confirmation + reminder sent` (WhatsApp), time `Yesterday 4:12 PM`; message (system) `Your appointment at Oasis Auto Spa is confirmed for {time}. Reply C to confirm.`
  - arrived → log `Arrival logged` (Internal), no message.
  - cleaning → log `In-progress message sent` (WhatsApp); message `Good news — your vehicle is now being cleaned.`
  - completed → log `Job closed · review request scheduled` (Automation); message `Thanks for visiting Oasis Auto Spa! How did we do? ⭐`
- Times for arrived, cleaning and completed are `fmtT(parseT(a.time) + offset)`, where the offset starts at 0 and grows by `max(2, round(dur/6))` after each non-confirmed step.
- Resulting message counts by status: booked 1, confirmed 2, arrived 2, cleaning 3, completed 4. Log counts: 1, 2, 3, 4, 5.
- Note: the live `advance` path writes different wording (`Your appointment is confirmed for {time}.`, `Your vehicle is ready for pickup!`). The seeded history and live advance use two sets of copy.

### 7.7 History pools
- `histPool` (4): `['Premium Hand Wash + Interior','Bi-weekly regular',129,true]`, `['Express Hand Wash','Quick turnaround',45,false]`, `['Executive Detail','Pre-trip deep clean',260,false]`, `['Ceramic Maintenance + Wax','Coating top-up',180,false]`.
- `HIST` (3, used for generated days): the first three of the above.

### 7.8 Generated-day pools
- `POOL_NAMES` (20): Olivia Hart, Ethan Morales, Chloe Bennett, Mateo Silva, Hannah Kim, Isaac Patel, Zoe Laurent, Andre Thompson, Camila Reyes, Noah Fischer, Leah Goldberg, Omar Haddad, Ruby Castillo, Victor Nguyen, Ava Sinclair, Diego Ramos, Nina Petrova, Caleb Owens, Mia Torres, Julian Brooks.
- `POOL_VEH` (12, `[year, make, model, color]`): 2022 BMW X5 Carbon Black; 2021 Toyota 4Runner Lunar Rock; 2023 Audi e-tron GT Tactical Green; 2020 Honda Accord Platinum White; 2024 Rivian R1S Glacier White; 2019 Mercedes-Benz C300 Selenite Grey; 2022 Ford Bronco Cactus Gray; 2023 Porsche 911 Carrera GT Silver; 2021 Kia Telluride Gravity Gray; 2022 Tesla Model 3 Deep Blue; 2024 Lexus GX 550 Wind Chill Pearl; 2023 Genesis GV80 Uyuni White.

### 7.9 Other fixed UI data
- **Quick-reply templates (label → text):**
  - `Confirmed` → `Your appointment is confirmed. See you soon!`
  - `We’re ready` → `We’re ready for you — come on in!`
  - `Checked in` → `Your vehicle has been checked in.`
  - `Being cleaned` → `Your vehicle is now being cleaned.`
  - `Ready for pickup` → `Your vehicle is ready for pickup!`
  - `Approve add-on?` → `We recommend an add-on — would you like to approve it?`
  - `Payment link` → `Here is your secure payment link.`
- **Status meta (label, color):** booked `#6B7280`, confirmed `#2563EB`, arrived `#7C3AED`, cleaning `In Wash` `#C2740B`, completed `#0E9E6E`, canceled `#9F1239`, noshow `No-Show` `#B91C1C`. Late overrides to `#C2410C` with the label `Late`.
- **Alert tones:** red `#C2410C`, amber `#B07908`, blue `#2563EB`, green `#0E9E6E`, violet `#7A3B8A`.
- **Theme tokens** (from the template CSS):

| token | light | dark |
|---|---|---|
| `--bg` | #ECEBE4 | #0C100E |
| `--panel` | #FFFFFF | #161E1A |
| `--panel2` | #F5F4EF | #1C2620 |
| `--panel3` | #EEEDE6 | #212C26 |
| `--ink` | #18211E | #ECF1EE |
| `--ink2` | #5C645F | #9BA7A0 |
| `--ink3` | #949A94 | #69756E |
| `--line` | #E2E0D7 | #283330 |
| `--line2` | #EDEBE3 | #222B27 |
| `--accent` | #0E7A63 | #2FB694 |
| `--accentInk` | #0A5C49 | #7FE0C6 |
| `--accentSoft` | #DCEEE8 | #15302A |
| `--accentBrd` | #BFE0D5 | #23463D |

- **Headings and nav:** brand `Oasis Auto Spa` / `Command Center`; nav `Operations`, `Payments`, `Settings` (links to the sibling designs); buttons `New Appointment`, `Walk-in`; view tabs `Timeline`, `Bay Board`, `Staff`, `Calendar`; modal tabs `Overview`, `Checklist`, `Add-ons`, `Photos`, `Messages`, `Payments`, `Membership`, `History`.

---

## 8. Ambiguities & open questions

1. **Bay assignment vs. start cleaning are conflated.** The only UI to set a bay is dragging onto a bay, which immediately starts cleaning. The "Needs bay assignment" alert (and `Assign bay` action) just opens the modal, which has no bay field. Do we need a separate "plan a bay" action, and can an `arrived` job be bay-assigned without starting?
2. **Start Cleaning via the Next button has no bay guard.** It can start with `bay=null` or into an occupied bay. Is that allowed, and should it auto-pick a free bay?
3. **Capacity model unspecified.** The slot list and blocked slots are hard-coded. Open points:
   - Is capacity strictly 2 concurrent jobs?
   - Is a booking's `bay` a fixed reservation or advisory (the fixtures overlap within a bay)?
   - Do all packages occupy a bay for their whole duration?
   - Is there buffer or cleanup time between jobs?
   - Do add-ons extend duration (the design says no)?
4. **Manager override:** no UI, role model, reason capture or audit. Who may override, and is a reason required? Do drag-to-bay and reschedule respect capacity or open hours?
5. **VIP hold:** only a 48 h release rule is quoted. Which slots are held, how many, and who can book them. Is VIP an attribute of the customer or of a visit?
6. **"Bay time free 3.5h" and "12 booked"** are literals. Define the formulas (free bay-minutes remaining in today's open window, and what "booked" counts).
7. **Time basis.** No timezone is stated (area codes suggest Eastern). The "24h" window is not defined (rolling from now or today plus tomorrow). `NOW` (10:36), `BASE` (June 13) and the real clock all coexist. Need one server clock and a business timezone.
8. **Late detection.** `late` is a manual fixture flag. Define the rule (for example now > start + grace, with no arrival), the grace period, and whether it auto-clears.
9. **"Arriving soon" threshold** is ≤15 min and only for confirmed jobs with no ETA. What produces the ETA (customer app vs. SMS link vs. WhatsApp location)? What happens when the ETA is stale or location is off?
10. **Membership.** The following are unspecified or inert:
    - How credits are consumed (the code credits nothing; `credit` is always 0).
    - Percent-off perks are listed but never applied.
    - Credit cycle length and renewal (`Jul 12, 2026` for everyone).
    - What "Premium Care" is versus Premium.
    - The retention-risk rule (`visits>6` is a stand-in).
    - How "upgrade candidate" is determined (the copy "4 visits in 60 days" is static).
    - Behavior of `Recommend upgrade →` and `Present membership offer`.
    - Are Executive and Exotic truly unlimited in billing?
11. **Tax, tip and money.** Is 7% fixed or configurable? Is tax applied to tips and to pre-paid memberships? Money shows whole dollars only, so are cents tracked? Tip entry is not in the UI (only fixture values). Deposit rules (amount, refundability, when charged) are not defined, and `togglePay` to unpaid on a deposit job loses deposit semantics.
12. **Payment edge cases.** Partial payments, refunds, split tenders, card-on-file, and payment-link expiry or webhook updates. "Collect Payment" (via `advance`) vs. "Mark Paid" vs. the chip toggle are three overlapping paths. Is payment required before pickup? Can pickup be marked while unpaid?
13. **Add-on mutability.** Can add-ons change after completion or payment? Does the customer approve them (template `Approve add-on?`)? If a job is already paid, how does the extra charge flow? The toast Added/Removed wording is likely inverted (see §3.7).
14. **Checklist keying and overrides.** Keys are label-based, so editing task text in Settings breaks stored checks. Per-appointment snapshot or live template? Are tasks mandatory before completion? Who checks (worker identity and timestamp are not recorded)? The inspection items were removed deliberately, but the `qc` log step remains vestigial.
15. **Unwired statuses.** `canceled` and `noshow` have colors and labels but no UI, transition, KPI exclusion beyond one filter, or customer message. Where do cancel, no-show and refund of deposit live? No-show timing rules.
16. **Messages.**
    - The composer is non-functional, and the `M` shortcut only toasts.
    - Inbound messages: threading by customer or by appointment? Message times are display strings.
    - WhatsApp 24-hour session window and template-vs-free-text rules.
    - The timeline's left-swipe `Message` and the late alert's `Message customer` do not send anything.
    - Two sets of auto-message copy exist (seeded history vs. live advance).
    - Reminder cadence (is `Send reminder` on an unconfirmed booking the same as confirming?).
17. **Photos.** No capture flow, file types, size limits, per-photo metadata, or customer visibility. The `Arrival` tag always shows "Captured" even at 0. The count rule gives `arrival=2` to `confirmed` jobs, which is probably unintended.
18. **Customer vs. appointment data.** `vip`, `member`, `notes` and `special` live on the appointment; they are semantically customer-level (and `notes` mixes the two). Customer identity key (phone? plate?), duplicate handling, multiple vehicles per customer. `visits`, `lifetime spend` and `avg cadence` are fabricated and need real definitions.
19. **Staff.** Is `Sofia D.` (Front Desk) really assigned washes? How is staff assignment chosen or reassigned (no UI, no drag between staff columns)? Staff live in Settings? Does the `Unassigned` queue auto-assign, and do staff have shifts or capacity?
20. **Emergency closure.** The design shows only a banner. Do bookings, available slots, auto-messages (cancel and rebook) and the calendar react? The calendar does not treat today as closed even when a closure is configured. What other fields does the emergency object carry?
21. **Closed-day behavior for existing bookings**, and whether reduced hours should displace bookings outside the new window (calendar rows silently drop out-of-hours appointments).
22. **Calendar.** Week starts Sunday and the month grid is 7 columns; no timezone-aware date math is specified. The unfiltered `Week` range tab behaves the same as `Next 24h`. Reschedule can only change the hour within the same day (keeps the minutes), not move across days, and does not check capacity or hours.
23. **Search and range semantics.** `Week` and `Next 24h` are not distinguished. Search does not apply to KPIs, bays or alerts (intended?). Are KPIs "today only" (labelled "24h" but several use `day===0`)? Mixed scopes are inconsistent in the design.
24. **Card payment labels.** Card shows `Deposit · $X due` with `X = balance`. Confirm that means remaining balance, not the deposit amount.
25. **Time ordering.** a7 (10:15 AM, late) sorts before a4 and a5 in the timeline and is tagged "Late". Sorting among equal times is VIP-first only (no stable secondary rule such as creation time).
26. **Concurrency and offline.** The design is single-user. Multi-user conflict handling (two people advancing the same job, drag races), optimistic UI, and undo are unspecified. The advance toast has no undo.
27. **Permissions and audit.** Roles beyond "Manager", who can mark paid, override, or reopen pickup; the activity `log` is written but never shown, so the intended audit UI is unknown.
28. **Settings coupling.** Hours, closures, emergency, checklist templates and theme are read from `localStorage` keys. The Settings design owns the schema; confirm shapes for `oasis-hours` (7 entries by `getDay`), `oasis-closures`, `oasis-emergency` and `oasis-checklists` (`{packages:{name:string[]}, addons:{name:string[]}}`). Whether package/add-on price and duration are also editable in Settings is not visible here.
29. **Misc placeholders to confirm as static copy or data:** `Rafael M.` / `Manager`, the bell dot, `Visa ···· 4421`, `Jul 12, 2026`, `18 days`, and the `4 visits in 60 days` copy.