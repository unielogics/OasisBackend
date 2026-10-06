<!-- Reference material generated during planning (2026-10-06) from the three Claude Design prototypes. Source of truth for the build; see docs/plan.md. -->

# Oasis Payments (`pay`): domain, data and business-logic spec

Sources are `PART=script` (all of it) and `PART=markup`. I also grepped the Settings and Command Center files for cross-page contracts.

**Verification caveat.** No JS runtime was available. I ported the fixtures and the seeded PRNG to Python (Math.imul and uint32 semantics, JS half-up `Math.round`) to compute the validation vectors in section 6. Treat those numbers as "derived by port, reasoned correct, not run in a browser". Re-verify them with a unit test against the design file.

Everything is a mock. All state is in-component React-like state, so every command below must be a real backend operation.

---

## 1. Entities and fields

### 1.1 Invoice (design calls it `tx`)

| Field | Type / values | Notes |
|---|---|---|
| `id` | string `INV-<5 digits>` | Seed counter starts at `20610` and counts down. See ambiguity A1 on duplicates. |
| `off` | int day-offset from "today" | `0` = today, `-1` = Yesterday. Replace with a real timestamp. Hard-coded anchor: `dateOf(off)=new Date(2026,5,13+off)`, so today = Sat Jun 13 2026. |
| `time` | string `'10:05 AM'` / `'12:00 PM'` | Local appointment/invoice time, 12h format, no zero padding. Used for the chart's hourly bucketing and display. |
| `client` | string (full name) | Client identity key is the name string (A5). |
| `vehicle` | string `'2023 Range Rover Sport'` | |
| `staff` | string | `'Marco R.'` (default), `'Lena K.'`, `'Sofia D.'`, `'Unassigned'`. Display only. |
| `items[]` | `{name, price}` | `items[0]` is the package (service). The rest are add-ons. No quantity field. Price is stored on the line (snapshot of `PRICE`/`ADD`). |
| `tip` | number, default 0 | Fixed $ amount. Tip is taxed? No, tip is added after tax. |
| `canceled` | bool | Set only in the seed (INV-20571). No UI in Payments toggles it. |
| `events[]` | ledger, see 1.2 | Append-only in the UI, except refund `status` mutation on approve/deny. |

### 1.2 Ledger event (`tx.events[]`)

Common fields:
- `type`: `'pay' | 'adjust' | 'refund' | 'credit_issue' | 'credit_apply'`
- `amt`: number. For `adjust`, signed (negative = discount, positive = surcharge). All other types are positive.
- `t`: display string. The design stores free text: `'10:05 AM'`, `'Today 3:07 PM'`, `'Yesterday 4:40 PM'`, `'Jun 11 · 9:12 AM'`, and `''` for generated refunds. The backend should store `timestamptz` and format it.
- `by`: actor display name. Seed pay events use `'System'`. New events from the UI use hard-coded `'Rafael M.'`. Seed refunds use `'Sofia D.'`.
- `byRole`: optional, role display name at action time, e.g. `'Customer Support'`.

Per type:

| type | extra fields |
|---|---|
| `pay` | `method` (string e.g. `'Visa ••4421'`, `'Amex ••3008'`, `'Mastercard ••1180'`, `'Apple Pay'`, `'Cash'`), `deposit?:true` (set by seed when a partial amount is paid up-front, `pay>0`). |
| `adjust` | `reason`, `note?` |
| `refund` | `dest:'card'\|'credit'\|'cash'`, `method` (card string / `'Store credit'` / `'Cash'`), `reason`, `note?`, `status:'pending'\|'done'\|'denied'`, `byRole?`, `approvedBy?` (string `'Rafael M. · Management'`). |
| `credit_issue` | `reason`, `note?`, `expiry:'No expiry'\|'90 days'\|'30 days'` (a label string, never converted to a date). |
| `credit_apply` | `method:'Store credit'` |

Status values:
- `pending`: refund requested, awaiting approval.
- `done`: executed, or approved.
- `denied`: only set by Deny.
- Non-refund events have no `status`.
- The seed passes `status:'done'` or `'pending'` explicitly.

### 1.3 Client store credit
This is not stored. It is derived by `clientCredit(name)` across all of the client's invoices, with no expiry handling. Formula in 2.9.

### 1.4 Roles, permissions and limits (`DEF_ROLES`, overridden by `localStorage['oasis-roles']`)

```
roles: [{id:'super',name:'Super Admin'},{id:'mgmt',name:'Management'},{id:'acct',name:'Accounting'},{id:'support',name:'Customer Support'},{id:'crew',name:'Crew'}]
perms (value 1 = granted; missing/falsy = denied):
  super:   pay.reports, pay.refund, pay.adjust, pay.credit, pay.collect
  mgmt:    pay.reports, pay.refund, pay.adjust, pay.credit, pay.collect
  acct:    pay.reports, pay.refund, pay.adjust, pay.credit, pay.collect
  support: pay.refund, pay.adjust, pay.credit, pay.collect         (NO pay.reports)
  crew:    {}
limits (USD, per kind; null = unlimited):
  super:   refund null, adjust null, credit null
  mgmt:    refund 1000, adjust 500, credit 500
  acct:    refund 500,  adjust 250, credit 250
  support: refund 50,   adjust 25,  credit 50
  crew:    refund 25,   adjust 25,  credit 25   (irrelevant: crew has no perms)
```

The component's `state.role` defaults to `'mgmt'`. The "Preview as" role switcher is a design-time device. The real system takes the role from the authenticated employee.

### 1.5 Price lists (must equal Settings catalog, which I verified)

```
PRICE: 'Express Hand Wash':45, 'Premium Hand Wash + Interior':129, 'Premium Hand Wash + Interior Refresh':139,
       'Executive Detail':260, 'Executive Detail + Ceramic':420, 'Full Detail':320,
       'Ceramic Maintenance + Wax':180, 'Exotic Detail Package':650, 'Family Wash + Pet Hair':95
ADD:   'Interior deep clean':60, 'Pet hair removal':35, 'Leather conditioning':45, 'Wax':40, 'Clay bar':50,
       'Odor removal':30, 'Engine bay cleaning':55, 'Ceramic maintenance':120, 'Rain repellent':25, 'Wheel deep clean':40
TAX = 0.07 (single global rate, hard-coded; label shown as 'Tax (7%)')
```

---

## 2. Formulas (exact)

`r2(n) = Math.round(n*100)/100`. JS `Math.round` rounds .5 up toward +∞. Prefer integer cents with half-up in the backend (see A9).

### 2.1 `calc(tx)`
```
items         = Σ items[].price
adj           = Σ events[type='adjust'].amt                       (signed)
sub           = items + adj
tax           = r2(sub * 0.07)
total         = r2(sub + tax + tip)                               (tip untaxed)
paidOrig      = Σ events[type='pay'].amt                          (includes deposits)
creditApplied = Σ events[type='credit_apply'].amt
paid          = r2(paidOrig + creditApplied)                      (store credit counts as payment)
refs          = events[type='refund' && status==='done']
refunded      = r2(Σ refs.amt)                                    (INCLUDES dest 'credit' and 'cash')
refOrig       = r2(Σ refs where dest !== 'credit'.amt)            (card + cash)
pending       = events[type='refund' && status==='pending']       (array)
balance       = tx.canceled ? 0 : max(0, r2(total − paid))        (NOT reduced by refunds)
refundable    = max(0, r2(paid − refunded − Σ pending.amt))
toOrigMax     = max(0, r2(paidOrig − refOrig))                    (max refundable to original card; excludes store credit used)
issued        = Σ events[type='credit_issue'].amt                 (NOT refund-to-credit)
net           = r2(items + adj − refunded/(1+TAX))                (tip and tax excluded; refunds assumed tax-inclusive)
```
`denied` refunds count nowhere, so the amount returns to refundable. `adjust` events are negative for discounts.

### 2.2 Status derivation (in this exact order; first match wins)
```
'Paid' (default)
if canceled && refunded >= paid               → 'Canceled · refunded'     (note: also true if paid==0 && refunded==0)
else if refunded > 0 && refunded >= paid−0.01 → 'Refunded'
else if paid === 0                            → 'Unpaid'
else if balance > 0                           → 'Partially paid'
else if refunded > 0                          → 'Partially refunded'
```
Display override: if `pending.length>0`, status text = `'Refund pending'` (list rows and detail header) and the pill uses the 'Partially paid' style (amber).

Pill colors (bg/fg):
- Paid: accentSoft / accentInk
- Unpaid: redSoft / red
- Partially paid: amberSoft / amber
- Refunded: panel3 / ink2
- Canceled · refunded: panel3 / ink2
- Partially refunded: amberSoft / amber

Pill CSS: 11px, weight 800, padding 4px 9px, radius 7px, nowrap.

### 2.3 Date ranges (`R=[from,to,label]`; filter is `off>=from && off<=to`)
- `today`: `[0,0,'Saturday, June 13']`
- `7d`: `[-6,0,'Jun 7 – Jun 13']`
- `30d`: `[-29,0,'May 15 – Jun 13']`
- `mtd`: `[-12,0,'Jun 1 – Jun 13']`

Ranges are inclusive calendar days ending today. `mtd` runs from the 1st of the month to today. The labels are hard-coded for Jun 13 2026. Range button labels: `Today`, `7 days`, `30 days`, `Month to date`. The default range is `7d`. Range filters on invoice date (`off`), not on payment or event date.

### 2.4 KPIs (over `inR` = invoices in range; independent of filter and search)
`gross=Σitems`, `adj=Σadj`, `refunds=Σrefunded`, `credits=Σissued`, `outstanding=Σbalance`, `net=gross+adj−refunds/(1+TAX)`. `money0` rounds to whole dollars with `−$` for negatives and thousands separators.

| Card label | value | sub text | color |
|---|---|---|---|
| `Gross sales` | `money0(gross)` | `N invoices` (all invoices in range, incl. unpaid and canceled) | `var(--ink)` |
| `Net revenue` | `money0(net)` | `after refunds & discounts` | `var(--accentInk)` |
| `Refunds` | `money0(refunds)` | `N refunded` (count of invoices with refunded>0) | red if refunds≠0 else ink |
| `Adjustments` | `money0(adj)` (signed) | `N invoices` (adj≠0) | ink |
| `Credits issued` | `money0(credits)` | `N clients` (actually a count of invoices with issued>0; see A6) | ink |
| `Outstanding` | `money0(outstanding)` | `N open balances` | amber if >0 else ink |

Notes:
- Pending refunds are excluded from Refunds.
- Refunds to store credit and cash are included in Refunds.
- Gross excludes tip and tax.
- Credits issued excludes refund-to-credit events and `credit_apply`.

### 2.5 Chart bucketing ("Net revenue", legend `Net` / `Refunds & discounts`)
- **`today`**: 10 hourly buckets h=8..17.
  - Label: `((h%12)||12)+(h>=12?'p':'a')`, so `8a 9a 10a 11a 12p 1p 2p 3p 4p 5p`.
  - Invoice test: parse `time` with `/(\d+):\d+\s*(AM|PM)/`, `hh=+m[1]%12`, add 12 if PM, then `hh===h`.
  - Invoices before 8:00 or after 5:59 PM fall in no bucket and are silently dropped from the chart (not from KPIs).
- **Other ranges**: one bucket per day, `o=from..to`.
  - Match: `invoice.off===o`.
  - Tooltip title: `date.toDateString()`.
  - Label when span `R[1]-R[0] > 14` (only `30d`): `d.getDate()%3===1 ? String(date) : ''`.
  - Label otherwise (`7d`, `mtd`): `['S','M','T','W','T','F','S'][getDay()]+' '+date`, e.g. `S 7`.
- **Values per bucket**: `net=Σ c.net`, `loss=Σ (c.refunded + max(0, −c.adj))`. Discounts and refunds count as loss. Surcharges do not.
- **Scale**: `mx=max(1, max_i(net_i+loss_i))`.
- **Bar tooltip**: `(title||label)+' · net '+money0(net)`.
- **Bar styles**:
  - Net: height `net/mx*100%`, `minHeight:'3px'` if net>0, background accent, radius `4px 4px 2px 2px`.
  - Loss: height `loss/mx*100%`, background red, radius 3px, opacity .85, stacked on top with 2px gap.
- **Minor inconsistency**: `net` deducts `refunded/1.07` but `loss` adds the full `refunded` (A7).

### 2.6 "Collected by method"
- Rows: `Card`, `Apple Pay`, `Cash`, `Store credit` (fixed order).
- For invoices in range: sum `pay` event amounts by family, plus `credit_apply` amounts into `Store credit`.
- Family regex: `/visa|master|amex/i`→Card; `==='Apple Pay'`→Apple Pay; `==='Cash'`→Cash; anything else→Store credit.
- Any unknown method string (e.g. `'Zelle'`, `'Check'`) would silently land in Store credit. See A8.
- Gross collected, not net of refunds. Bucketed by invoice date, not event date.
- Value `money0`. Bar width `v/max(1,maxValue)*100%`. Store credit bar uses amber, the others accent.

### 2.7 Filters (chips with count, counts computed over `inR` and ignoring the search box)
- `all`: `All`, always true.
- `unpaid`: label `Open balance`, `balance>0`.
- `refunds`: label `Refunds`, `refunded>0 || pending.length>0`.
- `adjusted`: label `Adjusted`, `adj!==0`.
- `credits`: label `Credits`, `issued>0 || creditApplied>0`.
- Default filter is `all`.

### 2.8 Search and sort
- Search is case-insensitive substring over `[id, client, vehicle, ...item names].join(' ')`.
- Sort is `off DESC`, then `id DESC` by string comparison. It does not sort by `time`.
- No pagination: the list is fully scrollable.
- Empty state text: `Nothing matches this filter.`
- Search placeholder: `Search client, invoice, vehicle…`

### 2.9 Client credit
```
balance(client) = r2( Σ over all invoices with t.client===name of:
   +amt for credit_issue
   +amt for refund where status==='done' && dest==='credit'
   −amt for credit_apply )
```
`creditLine` in the detail panel is `<FirstName> has $X in store credit`, shown only if balance>0.

Expiry is never enforced. Expired credit would still count (A4).

### 2.10 `lim(kind, role)`
```
has = !!perms[role]['pay.'+kind]                         (kind ∈ refund|adjust|credit; collect/reports use perms directly)
if !has → {has:false, max:0}
v = limits[role][kind]
max = (v===null || (v===undefined && role==='super')) ? Infinity
    : (v===undefined ? 25 : v)
```
Default limit when the role has the perm but no limit entry is **25**. Super with an undefined limit is unlimited. `null` is unlimited.

Display text: `limTxt = max===Infinity ? 'no limit' : '$'+round(max)+' limit'` (via `money0`).

Role-menu subtitle per role:
- If no `pay.reports` and no refund perm: `'no access'`.
- Else if refund perm: `'refunds no limit'` or `'refunds ≤ $<max>'`.
- Else: `'no refunds'`.

Footer text in the menu: `Limits come from Settings → Roles & permissions.`

### 2.11 Money formatting
- `money(n)`: `r2`, `'−$'` (U+2212 minus) when negative, 2 decimals, en-US grouping.
- `money0`: rounds the absolute value, then adds the sign.
- Everything is `tnum` (tabular-nums) in the UI.

---

## 3. Approval workflow

Only refunds can go to approval. Adjustments and credits are hard-blocked when over limit, with no approval path.

1. **Request**
   - A refund of value `val` where `val > rf.max` (the actor's own refund limit; strictly greater) is created with `status:'pending'`, and the permission text says it will be sent for approval.
   - Otherwise it is created with `status:'done'`, so refund approval is "by limit".
   - `byRole` = actor role name. `by` = actor.
   - Submit button label: `Request approval · $X` instead of `Refund $X`.
   - Toast: `Sent for approval · $X`.
2. **Effect of pending**
   - Does not touch `refunded` or `paid`, so Collected is unchanged.
   - Reduces `refundable` (reserves the amount). Invoice status text becomes `Refund pending` (amber).
3. **Banner (Payments page, above the chart; global across all invoices, not range-filtered)**
   - Shown if any pending refund exists.
   - Text uses only the first pending: `<N> refund awaiting approval — $80.00 · Chloe Bennett · requested by Sofia D.`
   - Singular "refund" is always used regardless of N (A10).
   - The `!` icon is on an amber square, with a `Review` button.
   - `Review` selects that invoice and range: if `p.off>=-6`, keep the current range, except `today` becomes `7d` when `p.off<0`; else switch to `30d`.
4. **Ledger row for a pending refund**
   - Dot color is amber.
   - Title: `Refund requested · <method|to store credit|cash>`.
   - Two buttons: `Approve` and `Deny`.
   - A note line under the buttons:
     - If the viewer can approve: `You can approve up to <any amount|$X>.`
     - Else: `Needs a role with a refund limit of at least $<amt> .`
5. **canApprove**
   - `canApprove = lim('refund').has && lim('refund').max >= e.amt`, using the viewing role, which is the current actor.
   - There is no requester≠approver check (A3).
   - Approve button style: accent when allowed, panel3/ink3 when not.
   - The Approve button is still clickable when not allowed and shows the toast `Your role can’t approve $X`.
6. **Approve** sets `status:'done'` and `approvedBy:'Rafael M. · <RoleName>'`.
   - The event timestamp `t` is not updated.
   - Toast: `Refund approved · $X to store credit` or `to <method>`.
   - There is no re-validation of refundable or toOrigMax at approval time.
7. **Deny** sets `status:'denied'` and the toast is `Refund request denied`.
   - There is no permission check on Deny. Any viewer of the screen can deny (A3).
   - The ledger shows `Refund denied · <method>` with the amount greyed (`ink3`).
8. **Pending count** is `allPending.length` over all invoices' pending refund events. It is shown only in the banner. There is no badge elsewhere.

What triggers what, by action:
- **Refund**: over own limit → pending, within limit → immediate.
- **Adjust**: over limit → blocked. Text: `Over your <limit> as <Role>. Ask Management or a Super Admin.` The settlement refund is created as an automatic `done` refund with no approval and no limit check.
- **Credit issue**: over limit → blocked. Text: `Over your <limit> as <Role>.`
- **Collect payment, Apply credit**: need only `pay.collect`, no limit.

---

## 4. Action sheets

Detail-panel buttons (2-col grid, 48px high, radius 12). Disabled state is panel2 background, ink3 text, opacity .7, with a `title` tooltip.

| Button | Condition to show | Enabled when | Disabled tooltip |
|---|---|---|---|
| `Collect $<balance>` (primary) | `balance>0` | `pay.collect` | `Role can’t collect payments` |
| `Apply $<min(credit,balance)> credit` | `balance>0 && credit>0` | `pay.collect` | `Role can’t collect payments` |
| `Refund` | always | `rf.has && refundable>0` | `Nothing left to refund` (has perm) or `Role can’t issue refunds` |
| `Adjust` | always | `ad.has && !canceled` | `Role can’t adjust invoices` |
| `Issue credit` | always | `cr.has` | `Role can’t issue credits` |
| `Send receipt` | always | always | none |

`Send receipt` has no ledger event. Toast: `Receipt sent to <client> via WhatsApp + email`.

Detail header: `<id> · <Today|Yesterday|Mon D> <time>` plus the status pill. Client name (Bricolage Grotesque 22px), `<vehicle> · <staff>`.

Three stat cards:
- `Total` (ink).
- `Collected` = `paid − refunded` (accentInk).
- Either `Balance due` (red, if `balance>0`) or `Refundable` (ink).

Breakdown panel lines, in order:
1. Each item `name`/`price`.
2. Each adjust: `Discount · <reason>` or `Surcharge · <reason>` (negative in red).
3. `Tax (7%)`.
4. `Tip` (only if `tip>0`).
5. `Total` (heavier, top rule).
6. `Store credit applied` shown as `−$` in accentInk (only if `creditApplied>0`).
7. `Paid`, which is `paidOrig`, so it excludes store credit.
8. `Refunded` as `−$` in red (only if `refunded>0`).

Sheet shell: centered modal, `max-width:560px`, scrim `rgba(8,12,10,.55)`. Click on the scrim or X closes it. Footer has `Cancel` and a submit button (52px, red for refund, accent for the others, panel3/ink3 when blocked and disabled).

Sheet form state defaults (`openSheet`): `mode:'full', items:[], dest:'card', reason:null, note:'', amount:'', kind:'discount', unit:'$', settle:'credit', expiry:'90 days', method:'Card on file'`.

Shared behaviors:
- **Reason** list is chip-selected. If none is chosen or the chosen one isn't in the list, it defaults to the first in the list. So reason is always populated.
- **Note** is a text input with placeholder `Internal note (optional)`.
- **Amount parsing**: `parseFloat(String(raw).replace(/[^0-9.]/g,''))||0`. This strips signs and commas, and `"1.2.3"` parses as 1.2.
- **Permission/result box** (`permText`) is accent-colored when `permOk` and amber otherwise.

### 4.1 Refund
- **Title** `Refund`, **sub** `<id> · <client>`.
- **Modes** (segmented): `Full`, `By item`, `Custom`.
  - **Full**: `val = refundable`.
  - **By item**: multi-select item rows, each shown as `item.price*1.07` (`money`), with the helper text `Tax on selected items is refunded proportionally.` The value is `min(refundable, r2(Σ selected item prices × 1.07))`.
    - Tax is refunded at the flat 7% of each item's list price. Existing discounts, surcharges and tip are not allocated (A11).
  - **Custom**: an `Amount` input with placeholder `0.00`.
- **Refund to** (segmented): `Original payment` (card), `Store credit` (credit), `Cash` (cash). Default is card.
- **Reasons**: `Service issue`, `Customer canceled`, `Duplicate charge`, `Pricing error`, `Goodwill`, `Add-on not performed`.
- **Summary rows**:
  - `Refundable`.
  - `This refund` (red).
  - `Collected after` = `paid − refunded − val` (accentInk).
  - If dest is credit: `<First>’s credit after` = `credit + val` (amber).
- **Validation**:
  - `origOk = dest!=='card' || val <= toOrigMax+0.001`.
  - `over = val > rf.max`.
  - `blocked = val<=0 || val > refundable+0.001 || !origOk`.
- **permText** (priority order):
  1. `!origOk`: `Only $<toOrigMax> was paid by card — refund the rest to store credit.`
  2. `val > refundable`: `More than the refundable amount.`
  3. `over`: `Over your <limit> as <Role>. This will be sent for approval.`
  4. Else: `Within your <limit> as <Role>.`
  - `permOk = !blocked && !over`.
- **Submit label**: `Request approval · $X` if `over && !blocked`, else `Refund $X`.
- **Event created**: `{type:'refund', amt:r2(val), dest, method, reason, note, byRole, status: over?'pending':'done'}`.
  - `method` is `'Store credit'` (credit), `'Cash'` (cash), or the first `pay` event's `method` (else `'Card'`).
  - Toast, when done: `Refunded $X to store credit` or `to <method>`.
- A full refund to card on an invoice where store credit was applied is blocked. Example: INV-20560, refundable 48.15, toOrigMax 23.15.
- `cash` dest counts toward `refOrig`, consuming card capacity.

### 4.2 Adjust
- **Title** `Adjust invoice`, **sub** `<id> · applied before tax`.
- **Controls**:
  - Kind: `Discount` / `Surcharge`. Switching kind resets reason to null.
  - Unit toggle: `$` / `%` (48px wide each).
  - Input labelled `Percent of services` when `%`, else `Amount ($)`, placeholder `0`.
- **Reasons**:
  - Discount: `Service recovery`, `Loyalty`, `Price match`, `Manager discretion`.
  - Surcharge: `Extra soil surcharge`, `Pet hair surcharge`, `Oversize vehicle`.
- **Calculations**:
  - `pre = unit==='%' ? r2(c.items*amt/100) : amt`. Percent applies to the services subtotal (`items`, which includes add-ons), not to existing adjustments or tip.
  - `signed = discount ? −pre : +pre`.
  - `newSub = c.sub + signed`.
  - `newTotal = r2(newSub*(1+TAX)+tip)`. This differs slightly from `calc` (`r2(tax)` first); see A9.
  - `diff = r2(paid − refunded − newTotal)`.
  - `over = pre > ad.max`.
  - `blocked = pre<=0 || newSub<0 || over`.
- **Summary**:
  - `Current total`.
  - `Discount (pre-tax)` or `Surcharge (pre-tax)` = signed (red for discount).
  - `New total` (accentInk).
  - If `diff>0.005 && paid>0`: `Overpaid — returned as store credit` or `card refund` (amber).
  - If `diff<-0.005`: `New balance due` = `−diff` (red).
- **Settle**:
  - The `Invoice is already paid — return the difference as` control (`Store credit` / `Refund to card`, default credit) appears only when discount, `paid>0`, and `diff>0.005`.
  - **permText**: over → `Over your <limit> as <Role>. Ask Management or a Super Admin.`; `newSub<0` → `Discount is larger than the invoice.`; else `Within your <limit> as <Role>.`
- **Submit**: label `Apply discount` / `Apply surcharge`.
  - Adds `{type:'adjust', amt:r2(signed), reason, note}`.
  - If `diff>0.005 && paid>0`, also adds an automatic refund `{amt:diff, dest: settle==='credit'?'credit':'card', method:'Store credit' | first pay method|'Card', reason:'Adjustment settlement', status:'done'}`.
  - The settlement refund bypasses limits, `toOrigMax` and the approval flow.
  - Toast: `Discount applied · new total $X` / `Surcharge applied · new total $X`.
- The surcharge also respects the adjust limit (compared on `pre`).
- A canceled invoice cannot be adjusted (button disabled).

### 4.3 Issue credit
- **Title** `Issue account credit`, **sub** `<client> · linked to <id>`.
- **Input** `Credit amount ($)`, placeholder `25.00`.
- **Expires** segmented: `No expiry`, `90 days`, `30 days` (default `90 days`).
- **Reasons**: `Service recovery`, `Referral reward`, `Weather closure`, `Goodwill`, `Promotion`.
- **Validation**: `over = amt > cr.max`, `blocked = amt<=0 || over`.
- **Summary**: `Current credit`, `Issuing` shown as `+$X` (amber), `New balance` (accentInk).
- **permText**: over → `Over your <limit> as <Role>.`; else `Within your <limit> as <Role>. Credit can be applied to any future invoice.`
- **Submit**: label `Issue $X credit`, event `{type:'credit_issue', amt, reason, note, expiry}`, toast `$X credit issued to <client>`.
- Credit is linked to the invoice it was issued from, but is spendable on any of the client's invoices.

### 4.4 Collect payment
- **Title** `Collect payment`, **sub** `<id> · <client>`.
- **Methods**: `Card on file` (default), `Cash`, `Payment link`.
- **Summary**: `Balance due` (red).
- **Text**: `Receipt goes out by WhatsApp and email.` (always OK/green).
- **Submit label**: `Collect $<balance>`. It always collects the full balance, with no partial-amount entry.
- **Submit**:
  - `Payment link` creates no ledger event. Toast: `Payment link sent to <client>`.
  - Otherwise adds `pay` `{amt:balance, method: Cash?'Cash':'Visa ••4421'}` (hard-coded card string; no `deposit` flag).
  - Toast: `Collected $X`.

### 4.5 Apply store credit
- **Title** `Apply store credit`, **sub** `<client>`. There are no reasons or note fields.
- **Calculation**: `use = min(credit, balance)`.
- **Summary**: `Available credit` (amber), `Applying`, `Balance after`.
- **Text**: `Store credit is used as a payment on this invoice.`
- **Submit**: label `Apply $X`. Adds `{type:'credit_apply', amt:use, method:'Store credit'}`. Toast: `$X credit applied`.

### 4.6 Ledger rendering (newest first = `events.reverse()`)
- **Glyphs**: pay `$`, adjust `±`, refund `↩`, credit_issue `+`, credit_apply `◆`.
- **Titles**:
  - pay: `Deposit · <method>` (if `deposit`) or `Payment · <method>`.
  - adjust: `Discount · <reason>` or `Surcharge · <reason>`.
  - refund: `Refund requested` (pending) / `Refund denied` / `Refund`, then ` · to store credit` (credit) | ` · cash` (cash) | ` · <method>`.
  - credit_issue: `Credit issued · <reason>`.
  - credit_apply: `Store credit applied`.
- **Meta line** (joined with ` · `): `t`, `by (byRole)`, refund `reason`, `note`, `Expires: <expiry>`, `Approved by <approvedBy>`.
- **Amount**: refund prefixed `−`, credit_issue `+`, others none.
  - Discount adjust prints unsigned (A12).
  - Colors: refund red; adjust red if negative, else ink; credit events amber; pay accentInk.
  - Denied is `ink3`.
- Section title: `Ledger & audit trail`.

---

## 5. Commands and queries (proposed REST)

All commands: authenticated actor, role and limits resolved server-side (never trust the client for status or limits). Use integer cents. Every command appends an immutable ledger event with `actor_id`, `actor_name`, `role_id` snapshot, and `created_at`. Writes accept an `Idempotency-Key` header, and duplicate keys return the original response. Use one DB transaction per command, with a row lock on the invoice to serialize refundable/balance checks. Return the updated invoice plus its computed fields so the UI can refresh.

### 5.1 Reads
| Verb path | Query | Response |
|---|---|---|
| `GET /api/me/permissions` | | `{role:{id,name}, perms:{reports,collect,refund,adjust,credit}, limits:{refund,adjust,credit}}` (`null` = unlimited, resolved with Settings' multi-role rule, section 7). If no `pay.reports`, the page shows the locked state (see below). |
| `GET /api/payments/summary` | `range=today\|7d\|30d\|mtd&tz=` | `{range:{from,to,label}, kpis:{grossSales,netRevenue,refunds,adjustments,creditsIssued,outstanding, counts:{invoices,refunded,adjusted,creditInvoices,openBalances}}, chart:{buckets:[{key,label,title,net,loss}]}, byMethod:{card,applePay,cash,storeCredit}, filterCounts:{all,unpaid,refunds,adjusted,credits}, pendingApprovals:{count, first:{invoiceId,client,amount,requestedBy}}}` |
| `GET /api/payments/invoices` | `range&filter&q&cursor&limit` | rows `{id,date,time,client,vehicle,items:{first,more},total,status,adjusted}` with the sort from 2.8 |
| `GET /api/invoices/:id` | | full invoice: items, adjust lines, `calc` output (`tax,total,paid,paidOrig,creditApplied,refunded,pendingRefunds,balance,refundable,toOrigMax,issued,status,net`), `ledger[]`, `clientCredit`, per-event `canApprove` for the caller |
| `GET /api/clients/:id/credit` | | `{balance, entries:[{type,amount,expiry,sourceInvoice,...}]}` |
| `GET /api/payments/approvals` | `status=pending` | list of pending refunds with `{invoice, client, amount, dest, reason, requestedBy, byRole, requestedAt}`. The design only surfaces the first one. |
| `GET /api/payments/export.csv` | `range&filter&q` | CSV stream (below) |

Locked state (viewer lacks `pay.reports`): the whole page body is replaced by an icon card.
- Title: `No payment access`.
- Body: `The <RoleName> role doesn't include "View payment reports". A Super Admin can grant it in Settings.`

### 5.2 Commands
| Verb path | Body | Server rules / response |
|---|---|---|
| `POST /api/invoices/:id/refunds` | `{mode:'full'\|'items'\|'custom', itemIds?:[…], amount?, dest:'card'\|'credit'\|'cash', reason, note?}` | Computes `val` server-side as in 4.1. Rejects 422 if `val<=0`, `val>refundable`, or `dest==='card' && val>toOrigMax`. Status = `pending` when `val>actor.limit.refund`, else `done`. 403 if no `pay.refund`. Returns `{event, invoice}`. |
| `POST /api/invoices/:id/refunds/:eventId/approve` | `{}` | Requires `pay.refund` perm and `limit>=amount` (and ideally approver≠requester, see A3). Sets `done`, records approver and role. 409 if not pending. |
| `POST /api/invoices/:id/refunds/:eventId/deny` | `{note?}` | The design has no permission check. Recommended: require `pay.refund`. Sets `denied`. |
| `POST /api/invoices/:id/adjustments` | `{kind:'discount'\|'surcharge', unit:'$'\|'%', value, reason, note?, settle?:'credit'\|'card'}` | 403 if no `pay.adjust`. 422 if `pre<=0`, `pre>limit.adjust` or `newSub<0`; canceled invoice rejected. Creates the `adjust` event and, if `diff>0 && paid>0`, an auto-`done` settlement refund (default credit). |
| `POST /api/invoices/:id/credits` | `{amount, reason, note?, expiry:'No expiry'\|'90 days'\|'30 days'}` | 403 if no `pay.credit`. 422 if `amount<=0` or over limit. Should store `expires_at` computed from the label. |
| `POST /api/invoices/:id/credit-applications` | `{}` | 403 if no `pay.collect`. Applies `min(clientCredit, balance)`. 422 if either is 0. |
| `POST /api/invoices/:id/payments` | `{method:'card_on_file'\|'cash'\|'payment_link'}` | 403 if no `pay.collect`. `payment_link` sends a link only (no ledger event until the PSP confirms). Card/cash records a `pay` for the full balance. The card path needs the PSP and the stored card's real last-4. |
| `POST /api/invoices/:id/receipt` | `{}` | Sends WhatsApp and email. Logs an audit entry. |

Client-only: theme (`localStorage['oasis-theme']`), role switcher (preview only), toast timing (3000 ms).

### 5.3 CSV export
The design only shows the toast `CSV export started · <N> invoices` (N = invoices in range, ignoring filter and search). **The columns and format are not specified** (A13). Proposed:
- UTF-8 with BOM, RFC 4180 quoting.
- Money as plain decimals with no `$`.
- One row per invoice in the range.
- Columns: `Invoice, Date, Time, Client, Vehicle, Staff, Items (; joined), Tip, Adjustments, Subtotal, Tax, Total, Paid, Credit applied, Refunded, Refund pending, Balance, Credits issued, Net revenue, Status`.
- Optionally a second ledger export, one row per event.

---

## 6. Seed fixtures

Generation rule per invoice (`mk`):
- `items = [service, ...addons]`.
- Adjust events are pushed first, then the payment, then `post` events.
- `pay` is `'full'` (amount `r2(total − creditUsed)`, `by:'System'`) or a number greater than 0 (deposit, `deposit:true`). `0` or none means no payment event.
- Defaults: method `Visa ••4421`, staff `Marco R.`, `tip 0`.
- Post events default to `by:'Rafael M.'` and `t=<invoice time>`, overridden by the event's own fields.
- Adjust tuple `[amt, reason, by?]`, with `by` default `Rafael M.`.
- Pending refunds in the seed carry `t:'Yesterday 4:40 PM'`.

### 6.1 Explicit fixtures (16)

Computed columns: `tax = r2((items+adj)*0.07)`.

| id | off | time | client / vehicle | staff | services + add-ons | tip | adj | payments | post events | total | status / balance |
|---|---|---|---|---|---|---|---|---|---|---|---|
| INV-20608 | 0 | 10:05 AM | Aisha Rahman / 2023 Range Rover Sport | Marco R. | Executive Detail + Ceramic (420); Ceramic maintenance (120) | 0 | – | full 577.80 Amex ••3008 | – | 577.80 | Paid |
| INV-20607 | 0 | 10:15 AM | Marcus Webb / 2017 Jeep Wrangler | Unassigned | Family Wash + Pet Hair (95); Odor removal (30) | 0 | – | deposit 20 Visa ••6610 | – | 133.75 | Partially paid, bal 113.75 |
| INV-20606 | 0 | 9:50 AM | Liam Chen / 2020 BMW M340i | Marco R. | Ceramic Maintenance + Wax (180) | 0 | – | full 192.60 Visa ••7731 | – | 192.60 | Paid |
| INV-20605 | 0 | 10:30 AM | Sofia Marchetti / 2024 Porsche Macan | Sofia D. | Executive Detail (260) | 0 | – | deposit 50 Visa ••0092 | – | 278.20 | Partially paid, bal 228.20 |
| INV-20604 | 0 | 9:40 AM | Jonathan Franco / 2023 Mercedes-Benz GLE | Marco R. | Premium Hand Wash + Interior Refresh (139); Leather conditioning (45) | 0 | – | full 196.88 Apple Pay | – | 196.88 | Paid |
| INV-20603 | 0 | 10:31 AM | Priya Nair / 2022 Tesla Model Y | Lena K. | Premium Hand Wash + Interior (129); Rain repellent (25) | 0 | – | none | – | 164.78 | Unpaid, bal 164.78. **Default selected invoice.** Priya has $20.00 credit, so `Apply $20.00 credit` shows. |
| INV-20602 | 0 | 9:58 AM | David Okafor / 2019 Ford F-150 | Marco R. | Full Detail (320); Engine bay cleaning (55) | 20 | −25 `Loyalty` | full 394.50 Mastercard ••1180 | – | 394.50 | Paid |
| INV-20601 | 0 | 8:52 AM | Maria Delgado / 2021 Audi Q5 | Lena K. | Express Hand Wash (45); Wax (40) | 8 | – | full 98.95 Visa ••4421 | – | 98.95 | Paid |
| INV-20579 | −1 | 2:10 PM | Chloe Bennett / 2022 BMW X5 | Lena K. | Executive Detail (260) | 0 | – | full 278.20 Visa ••5521 | refund 80, dest card, method Visa ••5521, reason `Service issue`, note `Interior stain not fully removed`, by `Sofia D.`, byRole `Customer Support`, **status pending**, t `Yesterday 4:40 PM` | 278.20 | shows `Refund pending`; refundable 198.20 |
| INV-20571 | −2 | 11:00 AM | Omar Haddad / 2023 Porsche 911 Carrera | Marco R. | Full Detail (320) | 0 | – | deposit 50 Visa ••2290 | refund 50 card Visa ••2290 reason `Customer canceled` by `Sofia D.` status done t `Jun 11 · 9:12 AM`; `canceled:true` | 342.40 | `Canceled · refunded`, bal 0 (net 273.27) |
| INV-20566 | −3 | 1:30 PM | Hannah Kim / 2024 Rivian R1S | Marco R. | Premium Hand Wash + Interior (129); Pet hair removal (35) | 10 | – | full 185.48 Visa ••4421 | refund 37.45 card Visa ••4421 reason `Add-on not performed` by `Rafael M.` done t `Jun 10 · 3:05 PM` | 185.48 | Partially refunded |
| INV-20560 | −4 | 10:20 AM | Victor Nguyen / 2020 Honda Accord | Marco R. | Express Hand Wash (45) | 0 | – | `credit_apply` 25 (pre-event, by `Sofia D.`, t `10:20 AM`) + pay 23.15 Visa ••8812 | – | 48.15 | Paid; toOrigMax 23.15 |
| INV-20552 | −5 | 3:15 PM | Mateo Silva / 2022 Ford Bronco | Marco R. | Premium Hand Wash + Interior (129) | 0 | – | full 138.03 Apple Pay | credit_issue 25 reason `Service recovery`, note `Waited 40 min past slot`, expiry `90 days`, t `Jun 8 · 4:02 PM` | 138.03 | Paid |
| INV-20548 | −6 | 9:00 AM | Zoe Laurent / 2023 Audi e-tron GT | Marco R. | Exotic Detail Package (650) | 0 | +40 `Extra soil surcharge` | full 738.30 Amex ••1005 | – | 738.30 | Paid |
| INV-20610 (auto id) | −14 | 11:30 AM | Priya Nair / 2022 Tesla Model Y | Lena K. | Express Hand Wash (45) | 0 | – | full 48.15 Visa ••4421 | credit_issue 20 `Referral reward`, expiry `No expiry`, t `May 30 · 11:45 AM` | 48.15 | Paid |
| INV-20609 (auto id) | −20 | 12:00 PM | Victor Nguyen / 2020 Honda Accord | Marco R. | Express Hand Wash (45) | 0 | – | full 48.15 Visa ••4421 | credit_issue 25 `Weather closure`, expiry `90 days`, t `May 24 · 12:10 PM` | 48.15 | Paid |

Derived client credits at load:
- Mateo Silva $25.
- Priya Nair $20.
- Victor Nguyen $0 (25 issued − 25 applied).
- Ruby Castillo $20.
- Grace Adeyemi $20.

### 6.2 Generated history (89 invoices) algorithm

PRNG (mulberry32 variant, seed `t=987654`):
```
t=987654; rnd(){ t+=0x6D2B79F5; let r=Math.imul(t^(t>>>15),1|t); r^=r+Math.imul(r^(r>>>7),61|r); return ((r^(r>>>14))>>>0)/4294967296; }
```
Lists:
- `names` (17): Olivia Hart, Ethan Morales, Isaac Patel, Andre Thompson, Camila Reyes, Noah Fischer, Leah Goldberg, Ruby Castillo, Ava Sinclair, Diego Ramos, Nina Petrova, Caleb Owens, Mia Torres, Julian Brooks, Grace Adeyemi, Tom Bradley, Nathan Brooks.
- `vehs` (10): 2022 BMW X5; 2021 Toyota 4Runner; 2020 Honda Accord; 2024 Rivian R1S; 2019 Mercedes-Benz C300; 2021 Kia Telluride; 2022 Tesla Model 3; 2024 Lexus GX 550; 2023 Genesis GV80; 2018 Lexus RX 350.
- `svcs` = `Object.keys(PRICE)` in declaration order. `adds` = `Object.keys(ADD)` in declaration order.
- `methods` = `['Visa ••4421','Mastercard ••1180','Apple Pay','Apple Pay','Cash','Amex ••3008']`.

Loop and RNG call order matters. Calls are made in exactly this sequence:
```
for o=-1 down to -29: if o===-10 continue (no invoices that day)
  n = 2 + floor(rnd()*3)
  for i in 0..n-1:
    h = 8 + floor(rnd()*9);  r = rnd();
    time   = ((h%12)||12) + ':' + (rnd()<0.5?'00':'30') + ' ' + (h>=12?'PM':'AM')
    client = names[floor(rnd()*17)];  veh = vehs[floor(rnd()*10)];
    staff  = ['Marco R.','Lena K.','Sofia D.'][i%3]
    svc    = svcs[floor(rnd()*9)]
    add    = rnd()<0.4 ? [adds[floor(rnd()*10)]] : []    (the inner rnd runs only when the first is true)
    tip    = 5*floor(rnd()*4)                             (0/5/10/15)
    adj    = r<0.08 ? [[-15,'Loyalty']] : []
    pay    = 'full', method = methods[floor(rnd()*6)]
    post   = r>0.95 ? [{type:'refund',amt:20,dest:'credit',method:'Store credit',reason:'Goodwill',by:'Sofia D.',status:'done',t:''}] : []
```
- The `mk` argument object is evaluated in the order `time → client → veh → svc → add → tip → method`.
- Ids come from the shared countdown (`seq--` per invoice without an explicit id), starting at INV-20608 after the two explicit auto-ids above.
- Generated ids span INV-20608 down to INV-20520.
- Gaps: no invoices for day −10.
- Per-day counts range 2 to 4.

### 6.3 Compact table of the 89 generated invoices
Columns: `id|off|time|client|vehicle|staff(M=Marco R.,L=Lena K.,S=Sofia D.)|service(+add-on)|tip|adj|method|refund`.
Abbreviations:
- Services: EHW=Express Hand Wash, PHWI=Premium Hand Wash + Interior, PHWIR=Premium Hand Wash + Interior Refresh, ED=Executive Detail, EDC=Executive Detail + Ceramic, FD=Full Detail, CMW=Ceramic Maintenance + Wax, EDP=Exotic Detail Package, FWPH=Family Wash + Pet Hair.
- Methods: V4421=Visa ••4421, MC1180=Mastercard ••1180, AP=Apple Pay, AX3008=Amex ••3008.
- `REF20cr` = the Goodwill $20 refund to store credit.

```
20608|-1|11:00 AM|Leah Goldberg|2024 Rivian R1S|M|ED+Engine bay cleaning|10||V4421|
20607|-1|1:00 PM|Noah Fischer|2023 Genesis GV80|L|PHWIR+Pet hair removal|5||V4421|
20606|-2|1:30 PM|Ava Sinclair|2021 Toyota 4Runner|M|FWPH+Pet hair removal|15|-15|MC1180|
20605|-2|8:00 AM|Isaac Patel|2019 Mercedes-Benz C300|L|EHW|15||Cash|
20604|-2|3:30 PM|Mia Torres|2024 Lexus GX 550|S|EHW|10||AP|
20603|-3|3:30 PM|Ethan Morales|2021 Kia Telluride|M|EDC|5||AX3008|
20602|-3|8:00 AM|Tom Bradley|2022 BMW X5|L|ED|10||AP|
20601|-3|4:30 PM|Ava Sinclair|2023 Genesis GV80|S|ED+Ceramic maintenance|0||AP|
20600|-4|12:30 PM|Andre Thompson|2024 Rivian R1S|M|EDC+Engine bay cleaning|0||Cash|
20599|-4|1:30 PM|Leah Goldberg|2022 Tesla Model 3|L|FWPH|0||MC1180|
20598|-4|3:30 PM|Mia Torres|2022 BMW X5|S|PHWI+Engine bay cleaning|10||MC1180|
20597|-4|9:00 AM|Noah Fischer|2022 Tesla Model 3|M|PHWI|5||MC1180|
20596|-5|12:00 PM|Ruby Castillo|2021 Toyota 4Runner|M|PHWI|5||MC1180|
20595|-5|4:30 PM|Andre Thompson|2024 Rivian R1S|L|PHWIR|5|-15|AP|
20594|-5|11:00 AM|Tom Bradley|2022 Tesla Model 3|S|FWPH|15||V4421|
20593|-5|1:30 PM|Diego Ramos|2022 BMW X5|M|EDC|0||AP|
20592|-6|10:00 AM|Caleb Owens|2022 Tesla Model 3|M|CMW|10||MC1180|
20591|-6|12:30 PM|Tom Bradley|2019 Mercedes-Benz C300|L|EHW+Pet hair removal|0||MC1180|
20590|-7|11:30 AM|Mia Torres|2021 Toyota 4Runner|M|FD|5||Cash|
20589|-7|3:00 PM|Nathan Brooks|2021 Kia Telluride|L|EDC+Ceramic maintenance|15||MC1180|
20588|-7|1:30 PM|Mia Torres|2021 Kia Telluride|S|EDC+Pet hair removal|10||AP|
20587|-7|11:00 AM|Ethan Morales|2024 Lexus GX 550|M|ED|15||AP|
20586|-8|1:00 PM|Tom Bradley|2022 BMW X5|M|PHWI+Odor removal|5||Cash|
20585|-8|1:00 PM|Diego Ramos|2024 Lexus GX 550|L|FWPH|15||AX3008|
20584|-8|1:30 PM|Isaac Patel|2018 Lexus RX 350|S|PHWIR+Ceramic maintenance|0||Cash|
20583|-9|1:30 PM|Grace Adeyemi|2022 Tesla Model 3|M|CMW+Wheel deep clean|15||AP|
20582|-9|10:30 AM|Andre Thompson|2020 Honda Accord|L|PHWI+Pet hair removal|15||AX3008|
20581|-9|12:00 PM|Grace Adeyemi|2018 Lexus RX 350|S|PHWIR|5||AP|
20580|-11|10:00 AM|Tom Bradley|2020 Honda Accord|M|FD|15||AP|
20579|-11|12:30 PM|Leah Goldberg|2023 Genesis GV80|L|PHWI|10||MC1180|
20578|-11|12:00 PM|Andre Thompson|2019 Mercedes-Benz C300|S|PHWI|15||MC1180|
20577|-11|2:30 PM|Caleb Owens|2022 Tesla Model 3|M|EDC+Interior deep clean|0||AP|
20576|-12|10:00 AM|Ava Sinclair|2024 Lexus GX 550|M|EDP|5||AP|
20575|-12|12:00 PM|Mia Torres|2023 Genesis GV80|L|EDC|15||MC1180|
20574|-12|8:00 AM|Ruby Castillo|2024 Rivian R1S|S|PHWI|0||V4421|
20573|-13|8:30 AM|Isaac Patel|2023 Genesis GV80|M|PHWIR|5||V4421|
20572|-13|2:00 PM|Olivia Hart|2021 Toyota 4Runner|L|EDC+Clay bar|0||AP|
20571|-13|10:30 AM|Noah Fischer|2022 BMW X5|S|EDP|0||AP|
20570|-13|2:00 PM|Leah Goldberg|2024 Lexus GX 550|M|EDC|10||Cash|
20569|-14|8:00 AM|Isaac Patel|2023 Genesis GV80|M|FWPH+Odor removal|15||AP|
20568|-14|11:30 AM|Tom Bradley|2018 Lexus RX 350|L|ED|5||Cash|
20567|-14|4:00 PM|Mia Torres|2018 Lexus RX 350|S|EDC+Leather conditioning|5||V4421|
20566|-14|2:00 PM|Ruby Castillo|2022 BMW X5|M|EHW|15||AP|
20565|-15|10:00 AM|Isaac Patel|2022 Tesla Model 3|M|EDP|5||AX3008|
20564|-15|9:30 AM|Tom Bradley|2022 Tesla Model 3|L|EDC+Engine bay cleaning|5||AP|
20563|-16|9:00 AM|Ruby Castillo|2021 Kia Telluride|M|EHW|10||MC1180|
20562|-16|3:00 PM|Julian Brooks|2024 Lexus GX 550|L|EDC|10||MC1180|
20561|-16|3:30 PM|Leah Goldberg|2024 Rivian R1S|S|ED|15||AP|
20560|-16|10:30 AM|Julian Brooks|2019 Mercedes-Benz C300|M|ED|10||AX3008|
20559|-17|12:30 PM|Grace Adeyemi|2020 Honda Accord|M|PHWIR|15||AX3008|
20558|-17|1:30 PM|Julian Brooks|2021 Toyota 4Runner|L|EHW|10||Cash|
20557|-18|2:30 PM|Diego Ramos|2022 BMW X5|M|CMW|5||Cash|
20556|-18|9:00 AM|Camila Reyes|2024 Rivian R1S|L|ED+Odor removal|10||Cash|
20555|-19|8:30 AM|Noah Fischer|2021 Kia Telluride|M|EHW+Interior deep clean|10||AP|
20554|-19|12:30 PM|Noah Fischer|2018 Lexus RX 350|L|CMW+Engine bay cleaning|0||AP|
20553|-19|11:30 AM|Isaac Patel|2021 Kia Telluride|S|FWPH|5||V4421|
20552|-20|10:00 AM|Andre Thompson|2020 Honda Accord|M|EDP|15||AP|
20551|-20|11:00 AM|Grace Adeyemi|2019 Mercedes-Benz C300|L|PHWI|0||V4421|
20550|-20|4:00 PM|Isaac Patel|2019 Mercedes-Benz C300|S|FWPH+Leather conditioning|15|-15|AX3008|
20549|-21|3:30 PM|Ruby Castillo|2018 Lexus RX 350|M|EDC|15||V4421|
20548|-21|8:00 AM|Andre Thompson|2019 Mercedes-Benz C300|L|FWPH+Ceramic maintenance|15||MC1180|
20547|-21|3:00 PM|Julian Brooks|2024 Rivian R1S|S|EDC|15|-15|V4421|
20546|-22|1:30 PM|Ethan Morales|2024 Rivian R1S|M|ED|0||AP|
20545|-22|11:00 AM|Ruby Castillo|2021 Toyota 4Runner|L|FWPH+Wax|15||V4421|REF20cr
20544|-22|11:30 AM|Caleb Owens|2021 Toyota 4Runner|S|FWPH|5||V4421|
20543|-22|12:00 PM|Ava Sinclair|2023 Genesis GV80|M|FD+Leather conditioning|10||Cash|
20542|-23|2:00 PM|Nathan Brooks|2020 Honda Accord|M|PHWIR+Clay bar|15||Cash|
20541|-23|3:30 PM|Grace Adeyemi|2020 Honda Accord|L|EDP+Odor removal|15||AP|
20540|-23|8:00 AM|Caleb Owens|2022 BMW X5|S|CMW|15||AP|
20539|-24|11:00 AM|Camila Reyes|2022 BMW X5|M|EHW+Pet hair removal|0||AX3008|
20538|-24|3:30 PM|Leah Goldberg|2023 Genesis GV80|L|ED|0||AX3008|
20537|-24|3:00 PM|Grace Adeyemi|2021 Kia Telluride|S|FD+Odor removal|15||AP|
20536|-24|3:00 PM|Grace Adeyemi|2024 Lexus GX 550|M|ED|15||MC1180|REF20cr
20535|-25|3:00 PM|Camila Reyes|2020 Honda Accord|M|FWPH+Ceramic maintenance|5||V4421|
20534|-25|8:00 AM|Julian Brooks|2022 Tesla Model 3|L|FD|10||AP|
20533|-25|4:30 PM|Isaac Patel|2024 Lexus GX 550|S|FWPH|5||Cash|
20532|-26|11:30 AM|Diego Ramos|2021 Toyota 4Runner|M|CMW+Leather conditioning|5||AP|
20531|-26|3:30 PM|Caleb Owens|2024 Rivian R1S|L|ED|5||MC1180|
20530|-26|2:00 PM|Leah Goldberg|2023 Genesis GV80|S|CMW|0||V4421|
20529|-26|12:00 PM|Julian Brooks|2018 Lexus RX 350|M|EDC|10||AP|
20528|-27|10:00 AM|Isaac Patel|2024 Lexus GX 550|M|CMW+Wheel deep clean|5||V4421|
20527|-27|4:30 PM|Nina Petrova|2021 Kia Telluride|L|EDC+Wheel deep clean|10||V4421|
20526|-27|3:00 PM|Andre Thompson|2022 BMW X5|S|EDC+Wheel deep clean|10||AP|
20525|-27|10:00 AM|Caleb Owens|2024 Rivian R1S|M|EDC|10||MC1180|
20524|-28|11:00 AM|Olivia Hart|2021 Kia Telluride|M|ED+Rain repellent|15|-15|Cash|
20523|-28|11:30 AM|Ruby Castillo|2022 Tesla Model 3|L|PHWIR|5||V4421|
20522|-28|1:00 PM|Camila Reyes|2021 Toyota 4Runner|S|ED|0||MC1180|
20521|-29|12:00 PM|Caleb Owens|2021 Toyota 4Runner|M|EHW|0||V4421|
20520|-29|3:00 PM|Isaac Patel|2021 Toyota 4Runner|L|EDC|15||AX3008|
```
Ids here collide with explicit ones (A1).

### 6.4 Validation vectors (all 105 invoices, mgmt role, derived by port; compare against the browser design)
| range | invoices | gross | net | refunds (n) | adj (n) | credits (n) | outstanding (n) | Card / Apple Pay / Cash / Store credit |
|---|---|---|---|---|---|---|---|---|
| today | 8 | $1,903 | $1,878 | $0 (0) | −$25 (1) | $0 (0) | $507 (3) | 1333.85 / 196.88 / 0 / 0 |
| 7d | 32 | $7,166 | $7,069 (7,069.27) | $87 (87.45, 2) | −$15 (4) | $25 (1) | $507 (506.73, 3) | 4739.10 / 1674.94 / 571.40 / 25.00 |
| 30d | 105 | $27,149 | $26,970 (26,969.89) | $127 (127.45, 4) | −$60 (7) | $70 (3) | $507 (3) | 14296.74 / 10919.32 / 3718.04 / 25.00 |
| mtd | 49 | $12,034 | $11,937 (11,937.27) | $87 (2) | −$15 (4) | $25 (1) | $507 (3) | 6542.52 / 4440.62 / 1371.06 / 25.00 |

Filter chip counts under `7d`: All 32, Open balance 3, Refunds 3, Adjusted 4, Credits 2. Under `30d`: 105, 3, 5, 7, 4. Initial pending banner: `1 refund awaiting approval — $80.00 · Chloe Bennett · requested by Sofia D.`

---

## 7. Cross-page dependencies

- **Shared top nav** on all three screens: tabs `Operations`, `Payments`, `Settings` (links to `Oasis Command Center.dc.html`, `Oasis Payments.dc.html`, `Oasis Settings.dc.html`). Payments' tab is active (accent bg, white text).
- **localStorage keys read by Payments**:
  - `oasis-roles`: JSON `{roles:[{id,name,…}], perms:{roleId:{permId:bool|1}}, limits:{roleId:{refund,adjust,credit}}}`. Falls back to `DEF_ROLES`.
  - `oasis-theme`: `'light'|'dark'`. Written by the toggle. Settings and Operations use the same key. Default is `light`.
  - Other `oasis-*` keys exist only in Settings and Operations: `oasis-hours`, `oasis-closures`, `oasis-emergency`, `oasis-checklists`, `oasis-vip`.
  - These become server APIs and tables. Roles, permissions and limits become a real RBAC schema.
- **Settings is the source of truth for permissions.**
  - Payment perm IDs and labels (Settings `PERMS` group `Payments`):
    - `pay.collect` = `Collect payments`.
    - `pay.refund` = `Issue refunds` (with limit).
    - `pay.adjust` = `Apply adjustments & discounts` (with limit).
    - `pay.credit` = `Issue account credits` (with limit).
    - `pay.void` = `Void transactions`. Exists in Settings (granted by default to acct and mgmt/super) but **Payments has no void flow and ignores it**.
    - `pay.reports` = `View payment reports` (gates the whole Payments page).
  - Limit steps in Settings: `LIMITS=[25,50,100,250,500,1000,null]`, cycled per role. The limit key is the perm suffix (`refund`, `adjust`, `credit`). `null` shows as `No limit`, others as `≤ $N`.
  - **Multi-role resolution (Settings Employee view)**:
    - An employee can hold several roles, e.g. Rafael Mendes = `mgmt + acct`.
    - The effective limit is `null` if any role is null, else the max across roles.
    - If none define it, the default is 25.
    - Per-employee exceptions (`allow`/`deny` overrides) exist: `deny` blocks, `allow` grants (with the limit tail).
    - The backend must implement union-of-roles plus overrides.
    - Payments' client-side `lim()` is single-role. Settings' resolution is the one to implement, and its default of 25 matches.
  - The Settings defaults differ slightly from Payments' `DEF_ROLES`. Settings has `pay.void` and many other perms, and uses true/false rather than 1. Settings' acct default also includes `set.billing`. The `pay.*` perm values for the five default roles otherwise match.
  - Role names are editable and custom roles can be added (default new limits `{refund:25,adjust:25,credit:25}`), so never hard-code `'super'` and similar IDs beyond Super's unlimited default (A2).
- **Catalog**: `PRICE` and `ADD` equal Settings' `SV`/`AD` price values exactly (all 9 packages and 10 add-ons verified). Settings' catalog is the source of truth, with each line snapshotting the price at sale time. The Settings catalog also has per-package duration and checklist tasks, which are not Payments' concern.
- **People**: seed staff names map to Settings employees: Marco R.=Marco Ruiz (crew, Lead Detailer), Lena K.=Lena Kim, Sofia D.=Sofia Duarte (support + crew), Rafael M.=Rafael Mendes (mgmt + acct), the actor hard-coded as `'Rafael M.'`. Payments needs real user identity for `by`.
- **Operations**: appointments, jobs and the "Unassigned" staff concept originate in Operations. An invoice is presumably created from a job, and `canceled` and deposits come from Operations flows (not shown in Payments). Client names and vehicles must match Operations' client file. Store credit is keyed by client.
- **Settings "Emergency closing"**: toggles `Protect member credits` (`Missed visits don’t use a credit`). This is member-visit credits, a different concept from the store credit in Payments. Closing for weather is also a reason in `Weather closure`, so a closure flow may issue credits to affected clients (open question A14).

---

## 8. Ambiguities and open questions

- **A1 – Duplicate invoice ids in seed.** The countdown from INV-20608 collides with the 14 explicit ids (20548, 20552, 20560, 20566, 20571, 20579, 20601–20608). `find` returns the first, `addEvent` and approve/deny update all copies, and the selected-row highlight marks several rows. Backend ids must be unique, so decide renumbering for seed data. The explicit fixtures should keep their ids. Sorting by `id DESC` as a string tie-break is also unstable.
- **A2 – Role identity.** Does the backend model roles by id or by name? The role id `'super'` is special-cased (unlimited default).
- **A3 – Approval governance.** There is no requester≠approver check, so a user can approve their own over-limit request after switching role. Deny has no permission check, and Approve has no re-validation of `refundable`, `toOrigMax` or limit at approval time. Approval does not update the event timestamp. The design is silent on notifications to the requester, and on whether denied requests can be re-submitted.
- **A4 – Credit expiry.** `expiry` is a label (`No expiry/90 days/30 days`), never evaluated. The design does not say when expiry starts, whether expired credit leaves the balance, or which credit is consumed first on apply (FIFO by expiry?). There is also no way to partially apply: always `min(credit, balance)`.
- **A5 – Client identity.** Store credit and "clients" are keyed by name string. Two clients with the same name would share a balance. Should use client IDs.
- **A6 – KPI sublabel.** `Credits issued` shows `N clients` but counts invoices with `issued>0`, not distinct clients.
- **A7 – Chart/KPI inconsistency.** `net` removes `refunded/1.07`, but the red "loss" bar adds the full `refunded` (tax-inclusive). Refunds of tip or refund-to-credit are treated the same as service refunds. Surcharges (positive adj) are not shown as a bar. Per-bucket net can also go below zero (no clamp except `minHeight` when >0).
- **A8 – Payment-method taxonomy.** Methods are free-text strings (`'Visa ••4421'`). The "Collected by method" card only knows Card, Apple Pay, Cash and Store credit, and anything else falls into Store credit. Need an enum (card brand/last4, wallet, cash, store_credit, link, …). Note that the design offers `Payment link` as a collect option, but its pay event isn't defined.
- **A9 – Rounding.** `calc` uses `r2(sub*0.07)` then `r2(sub+tax+tip)`, but the Adjust preview uses `r2(newSub*1.07+tip)` and the by-item refund uses `r2(Σprice*1.07)`. These can differ by a cent. Float rounding of `Math.round(n*100)` can mis-round values like x.xx5. Recommend integer cents with half-up on the tax and a single shared function. Percent discounts (`r2(items*pct/100)`) are the only arbitrary-precision input in the design.
- **A10 – Pending banner.** It shows only the first pending refund, the singular "refund" is hard-coded regardless of N, and `Review` only jumps to the first. How multiple pending items should be listed (queue, per-row badge) is unspecified. The same goes for the count as a badge in the nav. No pending indicator appears on list rows except the status pill.
- **A11 – Refund by item.** Refunded amount per item is `price*1.07`, ignoring any invoice-level discount or surcharge (and tip). A discounted invoice can therefore refund more per item than was effectively paid, until clipped by `refundable`. Proportional allocation of discounts and tips is unspecified. Mixed item-level refund tracking (which items were refunded, to prevent double-refunding an item) is absent. Item refunds don't record `itemIds` on the event.
- **A12 – Discount amount display.** In the ledger, a negative discount renders as an unsigned positive `$25.00` in red because the sign-handling code is a no-op. The detail lines panel does render `−$25.00`. Is the unsigned ledger value intended?
- **A13 – CSV.** Columns, filename, delimiter, timezone, whether filtered/searched rows are included, and whether it's per invoice or per ledger event are all unspecified. Only the toast text `CSV export started · N invoices` exists (N ignores filter and search).
- **A14 – Refund-to-credit and `Store credit` in revenue.** Refund to credit reduces Net revenue immediately (it counts as a refund), and the credit is later spent with `credit_apply`, which counts as "collected" under Store credit. Is double counting of the revenue intended? Closure-driven credits (Settings emergency flow) aren't specified in Payments.
- **A15 – Cash handling.** A refund `dest:'cash'` is allowed in addition to store credit and card, and is counted in `refOrig`, so it consumes the card capacity (`toOrigMax`), but a cash refund isn't tied to how the invoice was paid. Cash register/drawer reconciliation is not modeled.
- **A16 – Card on file.** `Collect payment` with `Card on file` hard-codes `Visa ••4421`. The real card, PSP, failure handling, declines, 3DS and partial collection (the sheet always collects the full balance) are undefined. Deposits and tips have no collect UI.
- **A17 – Canceled invoices.** `canceled` is a seed-only flag with no UI to cancel. `balance` is forced to 0, a canceled invoice is excluded from Adjust, and still counts in Gross sales (INV-20571 contributes its full $320 to gross while net drops only by its refund/1.07). The treatment of canceled invoices in KPIs is unspecified.
- **A18 – Void.** The Settings permission `pay.void` exists but Payments has no void action or UI.
- **A19 – Over-payment.** If total decreases below paid via a non-settled path (e.g. surcharge never; or discount with settle), status falls to `Paid` with no overpayment state. After an adjust, `balance=max(0,…)` hides negative balances, but the settle refund is auto-created only through the Adjust sheet.
- **A20 – Dates.** "Today" is fixed to Jun 13 2026 (`dateOf`), and range labels are hard-coded. Timezone, business-day cutoff and week start (7d is rolling, not calendar week) are unspecified. The chart for `today` drops invoices outside 8:00 to 5:59 PM. Event timestamps are free text.
- **A21 – Search.** Substring match over id/client/vehicle/item names only (not phone, amount, status). No pagination or server paging in the design (105 rows max at 30d), so large datasets need a paging decision.
- **A22 – Idempotent `Send receipt`.** The receipt channel (WhatsApp plus email) is shown only in toast copy. No resend-limit, template or audit event is defined.
- **A23 – Role "Preview as".** Dev-only toggle. In production, the actor's role comes from authentication, and a user holding multiple roles needs the Settings union rule, not a single-role pick.
- **A24 – Tip.** Tip is a static invoice attribute (0/5/10/15/20, 8 in seed), added after tax, not taxed, and not part of `net`/gross. No UI to add or change a tip, and tip is included in `refundable` (a full refund returns it). Tip refund via "By item" is impossible.