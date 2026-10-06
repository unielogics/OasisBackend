<!-- Reference material generated during planning (2026-10-06) from the three Claude Design prototypes. Source of truth for the build; see docs/plan.md. -->

# Oasis Auto Spa: cross-design contracts and consistency audit (Operations "cc", Payments "pay", Settings "set")

This is from reading the full `<script type="text/x-dc">` block of all three designs and the visible copy of each markup. File names in links are `Oasis%20Command%20Center.dc.html`, `Oasis%20Payments.dc.html` and `Oasis%20Settings.dc.html`.

Four things apply to every table below:
- "Design silent" means the designs do not say.
- Derived and hard-coded values are marked as such.
- I could not run Node here. The duplicate-ID and closed-day findings in section 2 come from reading the code, not from executing it.
- Anything marked "(inference)" is my reading, not something the designs state.

---

## 1. Shared constants & catalogs (side by side)

### 1.1 Packages (service catalog)

Names and prices are identical in all three. Duration exists only in cc and set.

| Package (exact name) | Price | Duration | cc | pay | set |
|---|---|---|---|---|---|
| Express Hand Wash | 45 | 35 min | yes | PRICE | yes |
| Premium Hand Wash + Interior | 129 | 75 | yes | yes | yes |
| Premium Hand Wash + Interior Refresh | 139 | 75 | yes | yes | yes |
| Executive Detail | 260 | 90 | yes | yes | yes |
| Executive Detail + Ceramic | 420 | 120 | yes | yes | yes |
| Full Detail | 320 | 120 | yes | yes | yes |
| Ceramic Maintenance + Wax | 180 | 60 | yes | yes | yes |
| Exotic Detail Package | 650 | 150 | yes | yes | yes |
| Family Wash + Pet Hair | 95 | 50 | yes | yes | yes |

- **Checklists:** the cc source lists `'Final inspection'` as the last task of every package. For Exotic it lists `'Hand-dry pre-inspection'` as the first task. `Object.values(this.SERVICES).forEach(s => s.list = s.list.filter(x => !/inspection/i.test(x)))` strips every task matching `/inspection/i` at load.
- After that filter, cc matches set exactly: 5, 7, 8, 10, 9, 10, 7, 9 and 7 tasks, in the table's package order.
- **Task keys:** cc keys checks by label: `'pkg|'+label` and `'ad|'+addon+'|'+label`.
- **Display shortening:** cc shortens names with `svc.split(' + ')[0]`. "Executive Detail + Ceramic" shows as "Executive Detail" and "Premium Hand Wash + Interior" as "Premium Hand Wash".
- **New Appointment picker:** cc offers only `Object.keys(s.services).slice(0,5)`: Express, Premium+Interior, Refresh, Executive, Executive+Ceramic.

### 1.2 Add-ons

| Add-on | Price | Tasks (cc `ADDON_TASKS` = set `AD`, identical) |
|---|---|---|
| Interior deep clean | 60 | Deep vacuum seats & carpets / Steam clean vents & cupholders / Wipe door jambs & panels |
| Pet hair removal | 35 | Rubber-brush pet hair / Lint-roll upholstery / Vacuum seat seams |
| Leather conditioning | 45 | Clean leather surfaces / Apply conditioner / Buff to matte finish |
| Wax | 40 | Apply carnauba wax / Buff off haze |
| Clay bar | 50 | Lubricate panels / Clay bar paint / Wipe residue |
| Odor removal | 30 | Enzyme treatment on fabrics / Odor neutralizer cycle |
| Engine bay cleaning | 55 | Cover electricals / Degrease engine bay / Dress plastics |
| Ceramic maintenance | 120 | Ceramic boost spray / Buff & level coating |
| Rain repellent | 25 | Clean glass / Apply rain repellent to windshield |
| Wheel deep clean | 40 | Remove wheel fallout / Clean barrels & calipers / Seal wheel faces |

Prices match across cc `ADDONS`, pay `ADD` and set `AD`. Add-on durations are not defined anywhere.

### 1.3 Staff

| Person | cc (hard-coded `staffNames`, `roles`, `avatarColors`) | pay | set (employees) |
|---|---|---|---|
| Marco | "Marco R." / role label "Lead Detailer" / avatar #2563EB | "Marco R." (default invoice staff) | e3 Marco Ruiz, Lead Detailer, roles `['crew']`, Commission 30, skills Paint correction/Ceramic coating/Exotic vehicles, works Mon–Sat (`sch([1..6])`), (786) 555-0172 |
| Lena | "Lena K." / "Detailer" / #0E9E6E | "Lena K." | e4 Lena Kim, Detailer, `['crew']`, Hourly 22, Interior detailing, works Sun + Tue–Sat (`sch([0,2,3,4,5,6])`, off Monday), (305) 555-0119 |
| Sofia | "Sofia D." / "Front Desk" / #7A3B8A. Also assigned washes: a5, a8, a10. | "Sofia D." (also `by` on refunds, `byRole:'Customer Support'`) | e5 Sofia Duarte, Front Desk, `['support','crew']`, Hourly 21, skill Front desk, exception `sched.override:'allow'`, Mon–Sat, (786) 555-0133 |
| (none) | "Unassigned" / "Queue" / #6B7280 | "Unassigned" | none |
| Rafael | top bar "Rafael M." / "Manager" | hard-coded `by:'Rafael M.'` on every event | e2 Rafael Mendes, General Manager, `['mgmt','acct']`, Salary; header "Rafael M." / "Management · Accounting" |
| Amara | none | none | e1 Amara Okoye, Owner, `['super']`, Salary, skill Exotic vehicles, (305) 555-0101 |
| Daniel | none | none | e6 Daniel Price, Bookkeeper, `['acct']`, Part-time, 34, works Mon/Wed/Fri, (305) 555-0188 |
| Kevin | none | none | e7 Kevin Tran, Detailer, status 'invited', 19, Mon–Fri, (786) 555-0151 |

Other staff fields in set:
- Email is `first.toLowerCase()+'@oasisautospa.com'`.
- Employment types: 'Full-time', 'Part-time', 'Contractor'.
- Pay types: 'Hourly', 'Commission', 'Salary'. Rate placeholders are '$ / hour', '% per job' and '$ / year'.
- Status values: `active`, `invited`, `inactive`, shown as "Active", "Invite sent", "Inactive".
- Skills list: Interior detailing, Paint correction, Ceramic coating, Exotic vehicles, Front desk, Mobile service.

### 1.4 Bays

- **cc:** two bays, `bays=[bayVM(1),bayVM(2)]`, labelled "Bay 1" and "Bay 2". Appointments carry `bay: 1|2|null`, shown as "Bay N" or "No bay".
- **Bay types:** design silent. There are no types or other bays.
- **Bay occupancy:** a bay counts as occupied only when `status==='cleaning'`.
- **Other mentions:** set has "pull into Bay 2" (sample welcome text) and perm `sched.override` "Override bay capacity". cc says "Greyed slots would overbook a bay — manager override required".

### 1.5 Customers and vehicles

- cc today (day 0): Maria Delgado, David Okafor, Priya Nair, Jonathan Franco, Sofia Marchetti, Liam Chen, Marcus Webb, Grace Adeyemi, Aisha Rahman, Tom Bradley, Elena Volkov. Tomorrow (day 1): Nathan Brooks (a12).
- cc random pool (`POOL_NAMES`, 20 names): Olivia Hart, Ethan Morales, Chloe Bennett, Mateo Silva, Hannah Kim, Isaac Patel, Zoe Laurent, Andre Thompson, Camila Reyes, Noah Fischer, Leah Goldberg, Omar Haddad, Ruby Castillo, Victor Nguyen, Ava Sinclair, Diego Ramos, Nina Petrova, Caleb Owens, Mia Torres, Julian Brooks.
- pay's named invoices (today's eight plus INV-20579/20571/20566/20560/20552/20548 and two unnumbered) use the same people and vehicle strings. pay's random-history name pool is a subset of the cc pool plus Grace Adeyemi, Tom Bradley and Nathan Brooks.
- cc vehicle fields: `{year, make, model, color, plate}`. pay stores one string, e.g. "2023 Range Rover Sport".
- cc phones are `(305)/(786) xxx-xxxx`, US format. Plates are `XXX-nnnn`, except a9 "RR-5567".
- set VIP clients: `['Jonathan Franco','Liam Chen','Aisha Rahman','Elena Volkov']` (names as strings). The emergency preview uses "Liam".
- Customer IDs and vehicle IDs do not exist in any design. pay's `clientCredit(name)` joins by name string.

### 1.6 Roles, permission keys, limits

Role IDs and names (identical in pay `DEF_ROLES` and set default):

| id | name | set desc |
|---|---|---|
| super | Super Admin | "Owner level. Everything, including billing." (`locked:true`) |
| mgmt | Management | "Runs the shop day to day." |
| acct | Accounting | "Payments, refunds, credits and reports." |
| support | Customer Support | "Front desk, bookings and messaging." |
| crew | Crew | "Bay work: jobs, checklists, photos." |

Custom roles are created by the "Custom role" button as id `'custom'+Date.now()`, name "Shift Lead", desc "Custom role — starts from Crew.", `custom:true`. Perms are a copy of crew plus `sched.edit`, with limits 25/25/25. Only custom roles show REMOVE, and Super Admin shows LOCKED.

**Permission keys (27, from set `PERMS`).** Items marked `[lim]` carry a money limit.
- **Schedule & jobs:**
  - `sched.view` "View schedule & calendar"
  - `sched.edit` "Create & edit appointments"
  - `sched.cancel` "Cancel & mark no-shows"
  - `sched.override` "Override bay capacity"
  - `jobs.status` "Move jobs between stages"
  - `jobs.checklist` "Complete checklists & photos"
- **Clients:**
  - `cli.view` "View client files"
  - `cli.contact` "See phone & email"
  - `cli.edit` "Edit client & vehicle details"
  - `cli.export` "Export client data"
  - `cli.member` "Manage memberships & VIP"
- **Payments:**
  - `pay.collect` "Collect payments"
  - `pay.refund` "Issue refunds" `[lim]`
  - `pay.adjust` "Apply adjustments & discounts" `[lim]`
  - `pay.credit` "Issue account credits" `[lim]`
  - `pay.void` "Void transactions"
  - `pay.reports` "View payment reports"
- **Messaging:**
  - `msg.send` "Message customers"
  - `msg.auto` "Edit automations & templates"
  - `msg.broadcast` "Send offers & broadcasts"
- **Team:**
  - `team.view` "View team"
  - `team.edit` "Add & edit employees"
  - `team.roles` "Assign roles & permissions"
- **Settings:**
  - `set.hours` "Working hours & holidays"
  - `set.emergency` "Emergency closing"
  - `set.services` "Services, pricing & checklists"
  - `set.billing` "Billing & integrations"

**Default grants (set):**
- super: all 27.
- mgmt: all except `set.billing`.
- acct: `sched.view, cli.view, cli.contact, cli.export, cli.member, pay.collect, pay.refund, pay.adjust, pay.credit, pay.void, pay.reports, team.view, set.billing`.
- support: `sched.view, sched.edit, sched.cancel, cli.view, cli.contact, cli.edit, cli.member, pay.collect, pay.refund, pay.adjust, pay.credit, msg.send, team.view`.
- crew: `sched.view, jobs.status, jobs.checklist, cli.view`.
- pay's `DEF_ROLES` fallback lists only the five `pay.*` keys it uses (`pay.void` omitted). Its values for those five match set's defaults.

**Limits (identical in pay and set), as `{refund, adjust, credit}`:**
- super: `null, null, null` (no limit)
- mgmt: 1000 / 500 / 500
- acct: 500 / 250 / 250
- support: 50 / 25 / 50
- crew: 25 / 25 / 25

Limit steps in set: `LIMITS = [25,50,100,250,500,1000,null]`. A missing limit defaults to 25 in both set (`lv===undefined?25`) and pay. Multiple roles take the highest limit, and `null` wins. An employee exception of 'allow' with no role limit gets 25.

### 1.7 Tax, money, currency

- **Tax rate:** 7%, hard-coded as `TAX = 0.07` in pay and `*0.07` in cc. Label is "Tax (7%)" in both. There is no tax setting in Settings.
- **Tip:** not taxed in either design (`total = sub + tax + tip`).
- **Currency:** USD only. Formatting is `en-US`.
- **pay money:** `money()` shows two decimals, with the minus sign `'−$'` (U+2212). `money0()` shows whole dollars.
- **cc money:** `'$'+Math.round(n)`, whole dollars only.
- **set:** `'$'+price` and `'≤ $'+limit.toLocaleString`.

### 1.8 Business hours, "today", dates

- **Hours:** set `hours` and cc `DEF_HOURS` are identical, indexed by JS weekday (0 = Sunday):
  - Sunday 9:00 AM–3:00 PM
  - Mon–Fri 8:00 AM–6:00 PM
  - Saturday 8:00 AM–5:00 PM
  - Settings displays Monday-first (`ORDER=[1,2,3,4,5,6,0]`).
  - Time stepper is in 30-minute steps, clamped 5:00 AM (300) to 11:30 PM (1410).
- **Booking rules (set):** `{slot:30, buffer:10, cutoff:60}`. Options: Slot length 15/30/60 min, Buffer between jobs 0/10/15/20 min, "Last booking before close" 30/60/90 min.
- **Closures (set default = cc `DEF_CLOSURES`):**
  - 2026-05-25 Memorial Day (closed)
  - 2026-06-03 Weather closure (closed; set adds `emergency:true`)
  - 2026-07-04 Independence Day (closed)
  - 2026-09-07 Labor Day (reduced 10:00 AM–2:00 PM)
  - 2026-11-26 Thanksgiving (closed)
  - 2026-12-24 Christmas Eve (reduced 8:00 AM–1:00 PM)
  - 2026-12-25 Christmas Day (closed)
  - Defaults for new entries are `notify:true` and from/to 10:00 AM/2:00 PM.
- **"Today":**
  - Design date is Saturday, June 13, 2026, hard-coded three ways: cc `BASE = new Date(2026,5,13)` and `dateLabel:'Saturday, June 13'`, pay `dateOf(off)=new Date(2026,5,13+off)`, set `TODAY='2026-06-13'`.
  - cc's logic clock is frozen: `NOW = 10*60+36` (10:36 AM). Its display clock is real: `'Live · '+nowClock()`. pay's `nowT()` and event timestamps use the real clock.
  - Today in this session is 2026-10-06, so the design date is fixture-only.
- **Locale (inference):** the phone area codes (305/786), "US federal holidays" and the 7% rate point to Miami-Dade, Florida. America/New_York is a likely timezone, but no design states it.

### 1.9 Other shared vocabularies

- **Appointment status (cc):**
  - Flow: `booked → confirmed → arrived → cleaning → completed` (`ORDER`).
  - Also defined in `stMeta` but without UI actions: `canceled` ("Canceled" #9F1239) and `noshow` ("No-Show" #B91C1C).
  - Colors: booked #6B7280, confirmed #2563EB, arrived #7C3AED, cleaning #C2740B, completed #0E9E6E.
  - "Late" (#C2410C) is a derived badge from `a.late`.
  - Labels: `cleaning` is labelled "In Wash". `completed` is labelled "Completed" on cards and "Done" in the modal stepper.
  - Next-step labels: "Confirm Appointment", "Mark Arrived", "Start Cleaning", "Mark Complete", "Collect Payment".
  - Dead legacy statuses in code: `ready`, `paid`, `qc`, `checkedin`.
- **cc pay state:** `pay` is `paid|deposit|unpaid`, with `deposit` an amount. Pickup is `pickup` = `pending|collected` ("Needs pickup"/"Picked up").
- **pay invoice status (derived):**
  - Statuses: "Paid", "Unpaid", "Partially paid", "Refunded", "Canceled · refunded", "Partially refunded". Display-only label: "Refund pending".
  - Filters: All, Open balance, Refunds, Adjusted, Credits.
  - Ranges: Today, 7 days, 30 days, Month to date.
- **pay event types:** `pay`, `adjust`, `refund`, `credit_issue`, `credit_apply`.
  - Refund `status`: `pending|done|denied`.
  - Refund `dest`: `card|credit|cash`.
  - Fields: `deposit`, `reason`, `note`, `expiry`, `approvedBy`, `byRole`.
- **Payment methods:**
  - Stored methods: 'Visa ••4421', 'Mastercard ••1180', 'Amex ••3008', 'Apple Pay', 'Cash', 'Store credit'.
  - Collect sheet offers 'Card on file', 'Cash', 'Payment link'.
  - By-method chart families: Card, Apple Pay, Cash, Store credit.
- **Reason lists (pay):**
  - Refund: Service issue, Customer canceled, Duplicate charge, Pricing error, Goodwill, Add-on not performed.
  - Discount: Service recovery, Loyalty, Price match, Manager discretion.
  - Surcharge: Extra soil surcharge, Pet hair surcharge, Oversize vehicle.
  - Credit: Service recovery, Referral reward, Weather closure, Goodwill, Promotion.
  - Credit expiry options: No expiry, 90 days, 30 days.
- **Membership tiers (cc):** Essential, Premium, Executive, Exotic. a4 is "Premium Care", shown as "Premium" on cards.
  - Perks:
    - Essential: 2 express washes / month; Priority booking; 10% off add-ons; Free vacuum anytime.
    - Premium: 2 premium washes / month; Skip-the-line priority; 15% off all add-ons; Monthly interior refresh; Free rain repellent.
    - Executive: Unlimited express washes; 2 executive details / month; 20% off add-ons; Dedicated detailer; Loaner coordination.
    - Exotic: Unlimited hand washes; Concierge pickup & delivery; Paint protection reviews; 25% off all services; Private appointment windows.
  - Hard-coded renewal and stats: "Renews Jul 12, 2026"; `creditsLeft` "∞" for Executive/Exotic and "1" otherwise; `creditsUsed` 1 for Premium; `memberMonths` = 8+(visits%6).
- **VIP (set defaults):**
  - Holds: Sat 8:00 AM, 9:00 AM, 10:00 AM; Fri 4:00 PM; Sun 9:00 AM (`{d,t}` = weekday + time).
  - Release: 48h (options 24/48/72h before).
  - Windows: VIP 30 days (7–90, step 7), Standard 14 days (7–60, step 7).
  - Same-day guarantee: 2/mo (0–8).
  - Waitlist: on, offer window 15 min (10/15/30).
  - Standing appointments: on, auto-confirm on ("Confirmed 48h before without a reply").
  - Cadences: Weekly, Every 2 weeks, Monthly offered; "Every 3 weeks" also available.
- **Arrival (set defaults):**
  - On, radius 300 m (150/300/500).
  - Prep alert at 15 min away (10/15/20).
  - Auto-arrive, welcome message, alert crew and VIP-first all on.
- **Message channels (strings):** WhatsApp, Email + WhatsApp, Internal, Automation, System. Also "SMS fallback", push, email.

---

## 2. INCONSISTENCIES (designs vs. designs, and design vs. its own logic)

### 2.1 Money, tax, rounding

1. **Tax rounding.** cc `total()` uses `Math.round((sub-credit)*0.07)`, whole dollars. pay uses `r2(sub*TAX)`, cents.
   - Example, Jonathan Franco (cc a4 / INV-20604): sub 184, cc tax 13 and grand $197, pay tax $12.88 and total $196.88.
   - Example, Aisha Rahman (a9 / INV-20608): sub 540, cc tax 38 and total $578, pay tax $37.80 and total $577.80.
2. **Money display.** cc shows whole dollars everywhere (`money()` rounds). pay shows cents. The same amount reads differently.
3. **Adjustments missing in cc.** cc `total()` has no adjustments or discounts. INV-20602 David Okafor has a −25 "Loyalty" discount in pay. cc computes 421 for the same job. pay computes (375−25)×1.07+20 = 414.50.
4. **Dead membership credit in cc.** cc computes `credit = Math.min(a.price, a.member==='Exotic'?0:0)`, which is always 0. Membership discounts (10/15/20/25% perks) never reach any invoice. pay has no membership concept.
5. **Revenue KPIs do not reconcile for "today".**
   - cc "Revenue today" is $1,488: the sum of `grand` (tax and tip included) over `pay==='paid'` appointments. It excludes deposits and any adjustments.
   - pay "Today" shows Gross sales $1,903 (items only, pre-tax and pre-tip) and Net revenue $1,878 (gross + adjustments − refunds/1.07).
   - The two use different bases (see 2.4 on `Outstanding` vs `Pending payments`).
6. **Pending vs. Outstanding for today.**
   - cc "Pending payments" counts day-0 appointments with `pay!=='paid'`: 6 items, $1,299 (a3, a5 less $50 deposit, a7 less $20 deposit, a8, a10, a11).
   - pay "Outstanding" counts only existing invoices with a balance: 3 open balances, about $507 (INV-20603, 20605, 20607).
   - pay has no invoice yet for Grace Adeyemi, Tom Bradley or Elena Volkov. The rule for when an invoice is created is not defined (see 2.7).
7. **Tax on refunds and net revenue.** pay's `net = items + adj − refunded/(1+TAX)`. Refunds of tips are not modelled. A "Full" refund is `c.refundable`, which includes tax and tip. "By item" refunds are `price × 1.07` and do not refund tip.
8. **Float math.** pay `r2 = Math.round(n*100)/100` on floats. No cents-integer rule is defined.

### 2.2 Time and date assumptions

9. **Weekday and "today".** All three assume Saturday, June 13, 2026 (also cc `fmtDate` and pay range labels 'Jun 7 – Jun 13', 'May 15 – Jun 13', 'Jun 1 – Jun 13'). Real clock for this session: 2026-10-06.
10. **Frozen vs. live clock.** cc logic uses `NOW=10:36` but timestamps log entries with the real clock. pay stamps new events with the real clock ("Today h:mm AM") but fixtures with fixed strings.
11. **Stored timestamps are display strings.** pay events have `t:'Yesterday 4:40 PM'`, `'Jun 11 · 9:12 AM'`, `'10:20 AM'`, or `''`. cc log/message entries use `time:'Yesterday 4:02 PM'`. No ISO timestamps.
12. **Closed/off-hours data in pay.** The generated history covers `o=-1..-29`, skipping only `o===-10` (June 3, the weather closure).
    - It still generates 2–4 invoices on 2026-05-25 (off −19, Memorial Day, closed).
    - Generated times run 8:00 AM–4:30 PM on every day. That includes Sundays (hours 9:00 AM–3:00 PM).
13. **Tomorrow is Sunday, with limited staff.** cc `genDay` assigns staff round-robin Marco/Lena/Sofia for all days.
    - Per set schedules, Marco and Sofia are off Sunday (`sch([1..6])`) and Lena is off Monday.
    - cc tomorrow (Sun June 14) fixtures use Lena (a12) plus generated Marco/Sofia jobs.
    - The generated Sunday slots start at 11:00 AM (`o===1?11*60`), though Sunday opens at 9:00 AM.
14. **Last-booking cutoff.** set default "Last booking before close" is 60 min. cc's New Appointment slot list includes "4:30 PM" on Saturday (close 5:00 PM). Whether the cutoff applies to the start time or the finish time is silent.
15. **Hard-coded slot lists.** cc `slotTimes=['10:30 AM','11:00 AM','11:30 AM','12:30 PM','1:00 PM','2:30 PM','4:00 PM','4:30 PM']`.
    - `blocked=['11:00 AM','1:00 PM']` (overbook) and `vipHeld=['11:30 AM','12:30 PM']` are hard-coded.
    - There is no 12:00 PM slot, and no slots between 4:30 PM and close.
    - set VIP holds are Saturday 8/9/10 AM, Friday 4:00 PM and Sunday 9:00 AM. cc's VIP-held 11:30 AM and 12:30 PM do not appear in them.
16. **Hard-coded release window.** cc's toast says "Releases to everyone 48h before" while set's release is configurable 24/48/72h.
17. **Arrival alert threshold.** set `prepAt` defaults to 15 min ("Prep-bay alert when ETA is … min away"). cc's seeded arrival for Grace Adeyemi shows "Arriving in 22 min" (a8 `eta:22`), above the 15-min threshold.
    - cc also has a separate "Arriving soon" rule using a hard-coded 15 min (`absMin(a)-NOW <= 15`).

### 2.3 Staff, roles, names

18. **Rafael's title.** cc top bar shows "Rafael M." / "Manager". set shows "Rafael M." / "Management · Accounting". The employee record says "General Manager", roles mgmt + acct.
19. **Single role vs. multi-role.** pay's "Preview as" holds a single `role` id (default `mgmt`). Rafael has two roles, and set computes effective permissions as the union and the highest limit. pay never applies per-person exceptions (e.g. Sofia's `sched.override:'allow'`).
20. **"Customer Support" refunds but cannot see Payments.** support has `pay.refund/adjust/credit/collect` but not `pay.reports`.
    - pay locks the whole screen without `pay.reports` ("No payment access — The {roleName} role doesn't include "View payment reports". A Super Admin can grant it in Settings.").
    - Yet the fixtures show Support actions: INV-20579 refund requested by "Sofia D." with `byRole:'Customer Support'`, $80 pending.
    - cc's modal Payments tab only offers "Mark Paid" and "Send payment link", with no refund path.
    - Where Support exercises refund/adjust/credit is silent.
21. **Sofia's job.** Settings lists her as Front Desk (skill "Front desk"). cc assigns her wash jobs (a5, a8, a10) and shows her as a worker on bays. She also holds the crew role, so this is consistent only if front-desk staff also work bays.
22. **Staff name format.** cc and pay use "First L." strings. set has first/last. Collision risk if two people share first name and last initial.
23. **Hard-coded staff columns.** cc's Staff view is hard-coded to Marco R./Lena K./Sofia D./Unassigned. The other four set employees never appear, and employees added in Settings would not.
24. **Avatar colors differ.** cc staff: Marco #2563EB, Lena #0E9E6E, Sofia #7A3B8A. set colors by array index (`COLORS[i%7]`): Amara #0E7A63, Rafael #2563EB, Marco #7A3B8A, Lena #C2740B, Sofia #0D9488.
25. **Fixed "current user".** All three assume Rafael M.: the cc top bar, the set header, and pay `by:'Rafael M.'` on every new event regardless of the previewed role.
26. **Copy hard-codes role names.** set emergency footer: "Requires Management or Super Admin · you have access". The actual key is `set.emergency`, so this goes stale if the key is granted elsewhere.
27. **pay adjust/credit over limit.** Refund over limit becomes a `pending` approval. Adjust and credit over limit are blocked outright ("Over your $X limit as {role}. Ask Management or a Super Admin."). Approval only checks the refund limit even for the pending refund created from an adjustment.

### 2.4 Catalog, VIP, membership

28. **Aisha Rahman's VIP status.** set VIP clients include "Aisha Rahman". cc a9 has no `vip:true` (cc VIP is set only on Jonathan Franco, Liam Chen and Elena Volkov).
29. **Plan naming.** cc a4 uses member "Premium Care". Tiers elsewhere are Essential/Premium/Executive/Exotic. The cc "Member credit available" alert matches `a.member==='Premium'` exactly, so Jonathan would never trigger it.
    - The Essential card color (#7A8B73) differs from its modal tint (#5E7A52).
30. **cc modal "Payments" shows a hard-coded card.** `payMethod:'Visa ···· 4421'` (U+00B7) for every paid appointment, ignoring the invoice's real method (e.g. Apple Pay, Amex ••3008). pay writes 'Visa ••4421' (U+2022).
31. **Collect method hard-coded in pay.** Collect submit writes method `f.method==='Cash'?'Cash':'Visa ••4421'`.
32. **cc reversal vs. pay audit.** cc `togglePay` lets staff "Marked unpaid · balance reopened" with only a log line. Payments has a `pay.void` permission and an audited ledger with approvals. The cc toggle bypasses those.
33. **Package list in New Appointment.** Only 5 of the 9 packages are selectable (see 1.1). No add-on, staff or bay selection exists in the booking form.
34. **Tab name in cc.** "Payments" tab inside the appointment modal vs. the separate Payments screen. A cc "Mark Paid" with no method and no invoice vs. pay's invoice/ledger model.

### 2.5 IDs and identifiers

35. **Invoice ID collisions in the pay fixture.**
    - `seq=20610`, and `INV-`+`seq--` is used for unnumbered invoices.
    - The first two unnumbered ones (Priya, off −14, and Victor, off −20) get INV-20610 and INV-20609.
    - The generated history (roughly 87 invoices) then continues INV-20608, 20607, … downward. These collide with the hand-numbered INV-20608..20601, INV-20579 and others.
    - The two oldest manual invoices also carry the highest numbers, so IDs are not monotonic with time. Sorting is `b.t.off - a.t.off || (b.t.id > a.t.id ? 1 : -1)`.
    - `selId` lookup returns the first match.
36. **Appointment ID vs. invoice ID.** There is no link. cc appointments use 'a1', 'a2'… and 'g{off}_{i}'; pay invoices are 'INV-nnnnn'.
37. **Other ID formats.** Employees: 'e1'… or `'e'+Date.now()`. Roles: slugs, or `'custom'+Date.now()`. Closures: 'c'+index, regenerated each load and stripped before persisting.
38. **Credit joins by name.** pay's `clientCredit(name)` filters by `t.client===name`. Two customers with the same name would merge.

### 2.6 Persistence and propagation gaps (design promises vs. code)

39. **Not persisted.** Each of these is lost on reload:
    - set booking rules (`slot/buffer/cutoff`), the "Auto-add US federal holidays" toggle, employees (including new ones), and closure history.
    - set's service price/duration display (read-only).
    - cc's appointments and pay's invoices/events.
40. **cc ignores several set settings.** cc does not read `oasis-roles`, `oasis-vip` or `rules`. It hard-codes VIP holds, the release window, the arrival thresholds and welcome text. It reads only hours, closures, emergency and checklists.
41. **Emergency closure is a banner only in cc.** `dayInfo` uses `closures` and `hours`, not `emergency`. The calendar does not show an emergency-closed day. Also cc never shows today as closed (`closed: o!==0 && inf.closed`).
42. **Emergency vs. closures list.** set's default list marks Jun 3 as `emergency:true`, implying emergency closures become closure entries (tag "Emergency"). `doClose` writes only `oasis-emergency {active, summary}`, and `reopen` prepends a history row with hard-coded 'Jun 13, 2026' and "Reopened by Rafael M.". No code adds the closure entry. The Feb 18, 2026 partial-day outage ("11:20 AM – 3:00 PM · 4 notified") is not in the closure list either.
43. **Fake affected-booking counts.** set closures show `hash%4` / `hash%3` ("N existing bookings to move", "N bookings affected") derived from the date digits. `ncAffected` uses `(ncDay%5)+2`. `emRebooked:'2'` is hard-coded. `emNotified` = number of `REMAINING` rows (6). These must come from real bookings.
44. **Emergency static line.** "Open now · Saturday 8:00 AM – 5:00 PM · 6 appointments left today, 3 vehicles on site" is hard-coded text. The numbers do match cc's seed (6 not-yet-arrived today: Marcus Webb 10:15, Liam Chen 10:45, Grace Adeyemi 11:00, Aisha Rahman 12:00, Tom Bradley 1:30, Elena Volkov 3:00; 3 vehicles: Jonathan in bay, Sofia arrived, Priya ready for pickup), but they are not computed.
45. **Cadence option mismatch.** The default offered cadences are three of four available options. cc has no standing-appointment UI.
46. **Check-in welcome copy.** set sample: "“You’re checked in — pull into Bay 2”". cc `simArrive` text: "Welcome to Oasis! You’re checked in — pull into Bay N." (Different wording; the bay is dynamic.)
47. **KPI hard-codes in cc.** "Appointments 24h" sub '12 booked' (hard-coded), "Bay time free" '3.5h' (hard-coded), "Members today" derived, `lifetimeSpend = visits*148`, `avgFreq:'18 days'`, "4 visits in 60 days", `renewDate:'Jul 12, 2026'`.
48. **Late flag.** `late:true` is a hard-coded fixture field (a7). The rule that makes a job "Running late" is not defined. Alert text: "{time} {make} {model} — no arrival logged".
49. **Service-price editing.** Perm `set.services` is "Services, pricing & checklists", but the Settings screen shows price and duration read-only and lets users edit only checklist tasks.
50. **Billing & integrations.** Perm `set.billing` exists (acct and super have it; mgmt does not), but there is no Billing screen in Settings.

### 2.7 Invoice/appointment fixture mismatches (today)

- cc today has 11 appointments. pay today has 8 invoices. The missing ones are the three unpaid, unstarted bookings (Grace, Tom, Elena).
- Invoice times differ from appointment times:

| Customer | Appointment time (cc) | Invoice time (pay) |
|---|---|---|
| Aisha Rahman | 12:00 PM | 10:05 AM |
| Liam Chen | 10:45 AM | 9:50 AM |
| Jonathan Franco | 10:00 AM | 9:40 AM |
| Priya Nair | 9:45 AM | 10:31 AM |
| David Okafor | 9:15 AM | 9:58 AM |
| Maria Delgado | 8:30 AM | 8:52 AM |

- Both Marcus Webb (10:15) and Sofia Marchetti (10:30) match on time. It is not stated whether invoice time means created, paid or completed.
- Deposits agree: Sofia Marchetti $50 and Marcus Webb $20. Deposit amounts are otherwise generated ($25 in cc `genDay`).
- Staff assignments agree for the eight overlapping records.

---

## 3. Cross-page contracts

### 3.1 localStorage keys

| Key | Value shape | Written by | Read by |
|---|---|---|---|
| `oasis-theme` | raw string `'light'` or `'dark'` (default `'light'`) | cc, pay, set `toggleTheme` | all three (initial state; applied as `data-theme`) |
| `oasis-roles` | `{roles:[{id,name,desc,locked?,custom?}], perms:{roleId:{permKey:bool}}, limits:{roleId:{refund,adjust,credit}}}` (a limit of `null` = no limit) | set `setRC` (every change) | set, pay (`ls('oasis-roles')||DEF_ROLES`). Not cc. |
| `oasis-hours` | array of 7 `{open,from,to}`, index = JS weekday (0 = Sunday), times like `'8:00 AM'` | set `saveHours` (only on "Save changes") | cc, set |
| `oasis-closures` | array of `{date:'YYYY-MM-DD', name, type:'closed'|'reduced', from?, to?, emergency?, notify}` (`id` stripped) | set `persistClosures` (add, remove, notify toggle) | cc, set |
| `oasis-emergency` | `{active:boolean, summary:string}` | set `doClose` (`{active:true,summary}`) and `reopen` (`{active:false}`) | cc (banner), set |
| `oasis-checklists` | `{packages:{[pkg]:string[]}, addons:{[addon]:string[]}}` (tasks only; not price/duration) | set `persistChecklists` on every task edit/reorder/delete | cc, set |
| `oasis-vip` | `{vip:{holds:[{d,t}], release, windowVip, windowStd, sameDay, waitlist, offerMin, standing, autoConfirm, cadences[], clients[]}, arrival:{on, radius, prepAt, autoArrive, welcome, crew, vipFirst}}` | set `setVip` | set only |

All reads are one-time at component construction. There is no `storage` event listener, so a change in another tab appears only after reload or navigation.

### 3.2 Navigation and deep links

- All three screens have the same top-bar nav: Operations, Payments, Settings. File links: `Oasis%20Command%20Center.dc.html`, `Oasis%20Payments.dc.html`, `Oasis%20Settings.dc.html`.
- cc emergency banner ("Emergency closure active · {emergencyText}") has a "Manage" link to `Oasis%20Settings.dc.html#emergency`.
- Settings handles only `location.hash === '#emergency'` in `componentDidMount` (sets `section:'emergency'`). Default section is `'hours'`.
- cc closed-day panel link "Manage hours & holidays →" goes to `Oasis%20Settings.dc.html` with no hash, so it lands on Working hours, not Holidays & closures.
- Settings sections: `hours`, `closures`, `emergency`, `employees`, `roles`, `services`, `vip`, `arrival`. Only `emergency` has a deep link.
- pay references Settings only as text ("Settings → Roles & permissions", "A Super Admin can grant it in Settings").

### 3.3 Settings changes that must propagate (UI copy, quoted)

- **Hours:** "Hours drive online booking slots, the Operations calendar and the customer app." Toast: "Working hours saved · booking and calendar updated". cc day view shows "{open} – {close}" from these hours, and "Regular day off" when closed.
- **Closures:**
  - Section description: "Planned closed days and reduced hours. Booked customers are notified automatically."
  - Each row: "Online booking blocked · N existing bookings to move" or "Slots outside reduced hours hidden · N bookings affected".
  - Add form: "{n} customers are booked that day — they’ll get a reschedule link when you add this." Toast: "{name} added · calendar updated".
  - Each closure has a Notify toggle.
- **Emergency closing:**
  - Confirm text: "N customers will be messaged, online booking pauses and the closure shows on the Operations screen. Reason: …"
  - Toggles: "Notify affected customers — WhatsApp, with SMS fallback"; "Include one-tap reschedule link — Customers pick a new slot themselves"; "Protect member credits — Missed visits don’t use a credit"; "Pause online booking — Until you reopen"; "Alert on-shift crew — Push notification to the team".
  - Toasts: "Shop closed · N customers notified" and "Shop reopened · online booking resumed".
  - Message template: "Hi {first}, due to {reason} Oasis Auto Spa is closed {until}. We’re sorry for the inconvenience. Pick a new time here: {link}", with a preview link `oasis.spa/r/8KQ2`.
- **Roles and limits:**
  - pay: "Limits come from Settings → Roles & permissions."
  - pay approval note: "You can approve up to {limit}." or "Needs a role with a refund limit of at least ${amt}."
  - Settings: "People with several roles get every permission from each role, and the highest money limit. Per-person exceptions are set on the employee's profile. Tap a limit chip to change it."
- **Packages & checklists:**
  - "Every job booked with this package starts with these tasks. Selected add-ons append their own tasks underneath."
  - "When this add-on is on a job — booked, approved in the app, or added at the desk — these tasks are appended to the job checklist."
  - cc: "Built from the package + selected add-ons. Adding or removing an add-on updates this list." Toast: "Invoice + checklist updated".
- **VIP program:**
  - "Prime times only VIP clients can book. If no VIP takes one, it opens to everyone before the slot."
  - "Booking priority for VIP clients. Built around saving them time."
  - cc New Appointment: "Held for VIP clients — Releases to everyone 48h before · VIP clients can book it now".
  - VIP badge in cc cards and purple arrival alerts.
- **Arrival & check-in:**
  - "Applies to every client who has the app and allows location, not only VIPs."
  - Toggles: "Geofence auto check-in — Turn off to require check-in at the desk"; "Mark as Arrived automatically — Job moves to Arrived on the Operations screen"; "Send welcome message"; "Alert the crew — Push notification to whoever is on shift"; "VIP arrivals first — VIP arrivals sit at the top of alerts".
  - Steps: "{n} min out: Operations gets an “Arriving” alert with a Prep bay button. VIPs show in purple at the top." / "Within {r} m: Checked in automatically and the job moves to Arrived. Customer gets a welcome message." / "Ready to start: Crew sees “Auto checked in” with a Start cleaning button."
  - cc implements this with its "Prep Bay" and "Simulate arrival" buttons and the "Auto checked in · {name}" alert.
- **Employees:**
  - "They’ll get an SMS invite to set up their login." Toast: "Invite sent to {phone}".
  - "Availability used when assigning jobs and bays. Must sit inside business hours."
  - Roles drive pay limits.

---

## 4. Single-source-of-truth entities the backend must own

| Entity | Fields implied | Written by | Read by |
|---|---|---|---|
| Business hours (weekly) | weekday, open, from, to | Settings | Ops calendar and day view, booking slots, customer app |
| Booking rules | slot, buffer, cutoff | Settings | slot availability (online and desk) |
| Closures / holidays | date, name, type (closed/reduced), from, to, emergency, notify, federal | Settings (and emergency) | Ops calendar (week/month/day), booking, notifications |
| Emergency closure state and history | active, reason, duration, until/through, message, option toggles, affected list, notified/rebooked counts, opened/closed by | Settings | Ops banner, booking pause, messaging |
| Packages and add-ons | name, price, duration, checklist tasks (ordered), short name, active flag | Settings (tasks only in design) | Ops (booking, checklist, add-ons tab), Payments (invoice items), customer app |
| Employees | first/last, title, phone, email, roles[], status, type, payType, rate, skills[], weekly schedule, exceptions | Settings | Ops (staff columns, assignment), Payments (by/staff), roles |
| Roles, permissions, limits | id, name, desc, locked/custom, perms{key:bool}, limits{refund,adjust,credit} | Settings | Payments (gating, approvals), all screens (enforcement, silent) |
| VIP program and arrival settings | holds, release, windows, same-day, waitlist, standing, cadences, VIP client list, geofence flags | Settings | Ops, booking, customer app |
| Customers and vehicles | name, phone, WhatsApp opt-in, vehicles (year/make/model/color/plate), notes, special instructions, VIP flag, member tier | Ops (create/edit), customer app | Ops, Payments (client, vehicle) |
| Appointments / jobs | day, time, status, staff, bay, services, add-ons, checks, photos, tip, pay state, deposit, pickup, geoIn, eta, late | Ops | Ops, Payments (via invoice) |
| Job checklist state | per appointment, per task | Ops | Ops |
| Photos | arrival/before/after/issue, counts and files | Ops (crew) | Ops |
| Messages and activity log | direction, channel, text, time, automated flag | Ops, automations | Ops |
| Invoices and ledger | invoice id, line items (price snapshot), tip, events (pay, adjust, refund, credit_issue, credit_apply) with status, by, byRole, approvedBy, reason, note, expiry | Payments, Ops (collect) | Payments, Ops |
| Store credit | per client: issued (with expiry), applied, refund-to-credit | Payments | Payments |
| Membership | tier, renew date, credits left/used, months active, perks | not designed to edit | Ops modal |
| Tax and currency config | 7%, USD | (no UI anywhere) | cc, pay |

---

## 5. Implied scope outside these three screens (quoted)

- **Customer app:**
  - "…the customer app" (hours); "Applies to every client who has the app and allows location, not only VIPs."
  - "approved in the app" (add-on approval); cc template "Approve add-on?: We recommend an add-on — would you like to approve it?".
  - "Customers pick a new slot themselves" (reschedule link); "Cancellations are offered to VIPs first"; "VIPs can set a repeating slot".
- **Online booking:** "Hours drive online booking slots"; "Pause online booking — Until you reopen"; "Online booking blocked"; VIP booking windows (VIP 30 days, Standard 14).
- **Public site / short links (inference):** `oasis.spa/r/8KQ2` (reschedule link); employee emails `@oasisautospa.com`; "Here is your secure payment link."; "Payment link" collect option.
- **WhatsApp:**
  - cc "WhatsApp opted-in" flag (hard-coded `whatsapp:true`), "WhatsApp" new-appointment field, `Delivered via WhatsApp`.
  - Automations: "Confirmation + reminder sent" ("Your appointment at Oasis Auto Spa is confirmed for {time}. Reply C to confirm."), "Check-in message sent", "In-progress message sent", "Ready-for-pickup sent", "Receipt sent", "Job closed · review request scheduled" ("Thanks for visiting Oasis Auto Spa! How did we do? ⭐").
  - Reschedule: "Your appointment has been moved to {time}. Reply if that doesn’t work."
  - Customers reply to messages: "Reply C to confirm." (inbound handling).
  - Templates: Confirmed, We’re ready, Checked in, Being cleaned, Ready for pickup, Approve add-on?, Payment link.
  - SMS fallback: "WhatsApp, with SMS fallback". Staff invite: SMS.
- **Receipts:** "Receipt sent to {client} via WhatsApp + email"; "Receipt goes out by WhatsApp and email."; "Payment received — receipt sent. Thank you!"
- **Memberships / billing:** cc Membership tab (tier cards, "Renews Jul 12, 2026", Credits left, Used this cycle, Months active, "Plan perks", Retention "Loyal · low risk" / "Watch · 1 missed visit", "Recommend upgrade →", "Not a member yet … Offer Essential at check-out", "Present membership offer"). Alert: "Member credit available — {name} has 1 unused Premium credit this cycle" with "Apply credit". Perms `cli.member`, `set.billing`. Plan prices and billing cycle appear nowhere.
- **Location / geofence:** "Geofence ETA", "Auto check-in · geofence", "Check-in radius" 150/300/500 m, "Prep-bay alert when ETA is … min away". Shop coordinates are not defined.
- **Photo storage:** cc Photos tab ("Capture arrival condition, before/after, and any damage notes"; sections Arrival, Before, After, "Damage / Issues"; 3 slots each). Perm `jobs.checklist` "Complete checklists & photos". Package task "Photographic handover". Storage is not designed.
- **Reports / export:** pay "Export CSV" (toast "CSV export started · N invoices"), perm `pay.reports`, perm `cli.export` "Export client data". No other reports.
- **Notifications:** "Alert the crew — Push notification to whoever is on shift"; "Alert on-shift crew — Push notification to the team"; cc "Needs Attention" alert feed; `navigator.vibrate` in drag handling (touch device use).
- **Payment processing (inference):** "Card on file", "Apple Pay", "Payment link", card last-4 display. No processor is named, and no screen configures one.
- **Mobile service (inference):** skill "Mobile service" is the only reference.
- **Payroll (inference):** per-employee pay type and rate (commission % per job) with no payroll screen.

---

## 6. Cross-cutting concerns the designs imply

- **Auth and roles.**
  - "Preview as {role}" in pay (default `mgmt`) is a design-time device. The real app needs login, with permissions computed from the employee's roles plus per-person allow/deny exceptions.
  - Effective-permission rule from set: union of perms, highest limit (`null` wins), exception 'allow'/'deny' overrides.
  - Enforcement in the designs covers only `pay.*`. The sched/jobs/cli/msg/team/set keys are never enforced in the screens (cc, set have no gating), so the backend must enforce them. "manager override required" maps to `sched.override`.
- **Audit trail.** pay shows "Ledger & audit trail" with actor (`by`), role (`byRole`), approver, reason, note and time. cc keeps a per-appointment `log` (time, text, channel). set records emergency history ("Reopened by Rafael M."). Role, closure and employee changes have no visible audit but would need one.
- **Timezone.** Wall-clock strings like "10:36 AM" with no zone. Hours, closures and slots are location-local. Closure dates are `YYYY-MM-DD`. Store tz per location; America/New_York is the likely value (inference).
- **Money rounding.** Pick cents-based decimals with half-up rounding (cc's `Math.round(45.5)=46` is half-up). Unify tax at cents (pay) instead of whole dollars (cc), and decide on tip tax treatment. Persist item prices on the invoice (pay does: `items` hold price snapshots).
- **Realtime.** cc runs a 1-second tick for bay elapsed time and a "Live · {clock}" label. It shows geofence ETAs, auto check-ins, inbound WhatsApp replies and approval banners. pay's "refund awaiting approval" banner implies cross-user updates. These need push or polling.
- **CSV export.** pay only; columns undefined. The toast "CSV export started" suggests an async job.
- **Theme.** `oasis-theme` is a per-browser value in all three, applied as `data-theme="light|dark"` on each page. All three share the same tokens (`--bg:#ECEBE4`, `--accent:#0E7A63`, dark `--accent:#2FB694`, and so on). pay adds `--red`, `--redSoft`, `--amber`, `--amberSoft`. Fonts: "Manrope" (body) and "Bricolage Grotesque" (display). Nothing in the designs says whether theme is per-user server-side.
- **Touch-first.** cc previews at 1480×1000, with 44px targets, long-press and drag to reschedule, and swipe right to advance / left to message. Keyboard shortcuts: `/` search, `n` new, `Esc`, `m`/`p`/`s`/`r` in modal, `←/→/t` in calendar.
- **Concurrency.** Checklist keys are task labels, so renaming a task in Settings would orphan checks on live jobs. Snapshot checklists at job creation or use stable task IDs.
- **Credit expiry.** Credits carry expiry labels ("No expiry", "30 days", "90 days"), but pay's `clientCredit` never expires them and applies in simple sum order.

---

## 7. Questions the user must answer (ranked by plan impact)

1. **Auth and tenancy.** Single location or multi-location? Real login model: email/SMS invite per employee (as the Add-employee flow says), one session = one user with multiple roles (as Rafael has) and per-person exceptions? Should "Preview as" survive as a Super-Admin "view as"?
2. **Invoice model.**
   - When is an invoice created (booking, deposit, completion)? One invoice per appointment?
   - What do the invoice number format and sequence look like (`INV-20608`), and do invoices have a shared gap-free sequence?
   - Today cc has 11 appointments but pay has 8 invoices; Grace, Tom and Elena have none.
3. **Tax and money rules.** Is tax 7% fixed or configurable (no UI exists)? Round to cents (pay) or whole dollars (cc)? Is the tip taxed? Should the cc UI show cents? Does "Revenue today" (cc) mean the same as "Net revenue" (pay)?
4. **Payment processor and channels.** Which processor (cards, Apple Pay, payment links, card on file)? Which WhatsApp provider (templates may need pre-approval), SMS and email providers, and push? Is the backend in scope for integrating these, or only for exposing hooks?
5. **Customer app and online booking.** Are they in scope for this backend phase? If so: auth for customers, slot availability API, geofence ingestion, add-on approval, reschedule links. If not, which backend contracts should be kept ready?
6. **Slot and bay logic.** How many bays, and is the bay assigned at booking or when cleaning starts (cc shows overlapping bay assignments: a4 and a6 both Bay 1 within 10:45–11:15; a5 and a8 both Bay 2)? What is the capacity rule behind "Greyed slots would overbook a bay"? How do staff schedules, skills, buffer (10), slot (30) and cutoff (60) combine? Does the cutoff apply to start or end?
7. **Membership.** Plan catalog, prices, billing cycle, benefits, renewal; do the perks (10–25% off, monthly credits) change invoices? How do membership credits relate to Payments store credit? Is membership billing part of this system? (Plans appear nowhere in Settings; cc's discount math is dead code.)
8. **Support role and Payments access.** Support has refund/adjust/credit but no `pay.reports`, so pay locks them out. Where do they act? Should adjust/credit over limit also route to approval instead of blocking?
9. **Catalog management.** Should Settings allow adding or retiring packages and add-ons, and editing price and duration (perm says "pricing")? Is the stripped "Final inspection" step intentionally dropped?
10. **VIP and arrival.** Reconcile Aisha Rahman's VIP status. Should cc read the VIP holds and thresholds from Settings (the prototype hard-codes them)? Shop geofence coordinates and ETA source?
11. **Emergency closure semantics.** Should an emergency create a closure-list entry (as Jun 3's `emergency:true` suggests)? Do partial-day closures count (Feb 18 outage)? What does "Protect member credits" do concretely? How are "rebooked" counts tracked?
12. **Timezone, locale, today.** Confirm the timezone (America/New_York?). Treat the June 13, 2026 / Saturday date as fixtures only?
13. **Reports and export.** CSV columns and scope for Payments, and for clients (`cli.export`). Any other reports?
14. **Employee pay.** Is commission or payroll calculation in scope (fields exist; no screen)?
15. **Photos, retention, privacy.** Storage and retention for photos, messages, and audit trail; WhatsApp opt-in handling.
16. **Seed data.** Should the backend seed replicate these fixtures (names, invoices, history) for demos, and should the invoice-ID collisions be fixed rather than copied?
17. **Persistence of unsaved Settings items.** Booking rules, the federal-holiday auto-add, and employee records have no persistence in the prototype. Confirm they should all persist (and the federal holidays be added each January as the copy says).