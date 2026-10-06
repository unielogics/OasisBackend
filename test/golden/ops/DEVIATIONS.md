# Operations oracle: deviations from the original design

`original.json` holds what the ORIGINAL Operations bundle (`design/original/operations.bundle.html`) computes at the frozen
clock 2026-06-13 10:36 AM Eastern, light theme, extracted through the dashboard harness (`extract/extract-original.ts`,
see "Re-extracting" below). The oracle tests (`board.golden.test.ts`, `calendar.golden.test.ts`, `file.golden.test.ts`)
assert the backend against it value by value: **everything not listed here matches exactly**, and each test fails if a
listed deviation stops happening (the deviations are asserted as exact `[original, new]` pairs).

The seed is `parity-ops` (`db/seeds/scheduling.ts`): a1-a12 as in the design, plus the design's procedural calendar days
(its seeded PRNG, `genDay`) as real rows for 210 days either side of today, except today and tomorrow. Invoices come from the
in-memory gateway built from `PARITY_OPS_MONEY`; memberships from the in-memory port built from `PARITY_OPS_MEMBERS`.

What matched exactly (not deviations): all ten alerts (glyph, title, description, action label, priority, order); the
timeline groups, dividers, times and card contents; the completed column and its chips; the arrivals; the staff columns; the
bay board except the estimate below; the range tabs Today, Tomorrow and Next 24h; checklist progress and sections of all 12
appointments (7/7, 13/13, 9/9, 6/11, 0/10, 0/7, 0/9, 0/5, 0/11, 0/5, 0/9, 0/10); photo counts per category; per-date counts,
closure reasons, reduced-hours notes and grid hours for 421 offsets (-210..+210); every rendered week (6), month (9) and
day (6) view.

## Deviations

| # | Where | Original | New | Reason |
|---|---|---|---|---|
| 1 | KPI "Appointments 24h" sub-label | `12 booked` | `7 booked` | The design hard-codes the text. Defined (review B29) as upcoming booked + confirmed jobs in the window (a6 a7 a8 a9 a10 a11 a12). The value `12` is unchanged. |
| 2 | KPI "Pending payments" sub-label | `$1,299` | `$1,298.53` | Cents: whole-dollar tax per invoice is replaced by half-up cent tax (golden vectors INV-20603/20605/20607 and the three unpaid fixtures). The count `6` is unchanged. |
| 3 | KPI "Bay time free" value | `3.5h` | `2.8h` | The design hard-codes `3.5h`. Computed: free bay-minutes left in today's open window = 2 active bays x (17:00 - 10:36) = 768 min, less the 601 min the day still commits (booked, confirmed, arrived and cleaning jobs, buffer included, clipped to [now, close]) = 167 min, shown as tenths of an hour. |
| 4 | KPI "Revenue today" value | `$1,488` | `$1,487.48` | Cents (a1 98.95, a2 421.25, a4 196.88, a6 192.60, a9 577.80, tips included). Defined cash-basis through the payments module; the fallback used here sums fully paid invoices of today's jobs, the design's own rule. |
| 5 | Card pay labels with cents | a5 `Deposit · $228 due`, a7 `Deposit · $114 due`, a8 and a10 `$48 due`, a11 `$696 due` | `Deposit · $228.20 due`, `Deposit · $113.75 due`, `$48.15 due`, `$695.50 due` | Operations shows cents when the amount is not whole (plan D2). Whole amounts (`$165 due`) are unchanged. |
| 6 | a9 (Aisha Rahman) `vip` | `false` | `true` | VIP is a customer attribute (`vip_clients`), and the Settings design lists Aisha Rahman as a VIP client; the Operations fixture lacks the flag on a9. |
| 7 | Up Next queue order | a6, a11, a7, a5, a8, a9 | a6, a9, a11, a7, a5, a8 | Consequence of 6: VIP first, then start time. The set of the top six changes accordingly (the design's sixth, a9, moves up; a8 is sixth). |
| 8 | Bay 1 estimated completion | `11:15 AM` (scheduled start 10:00 + 75) | `11:24 AM` | Fixed per backend design 4.1: cleaning start (10:09, started 27 minutes ago) + duration, never earlier than now. Elapsed `27:00`, `36% complete`, `75 min` are unchanged. |
| 9 | Range tab "Week" | the same 8 jobs as Next 24h | today through today + 6: the 8 fixtures plus the procedural days of Jun 15-19 | The design applies no filter to Week (review B27/B30). The test asserts `8 + the design's own counts for offsets 2-6`. |
| 10 | New Appointment slot grid | `10:30 AM` available; `11:30 AM · VIP` and `12:30 PM · VIP` held; `4:30 PM` available | `10:30 AM` past; `11:30 AM` and `12:30 PM` blocked; `4:30 PM` beyond the cutoff | The grid is computed, not hard-coded. 10:30 is before now; the seeded VIP holds are the Settings design's (Sat 8, 9 and 10 AM, Fri 4 PM, Sun 9 AM), so 11:30 and 12:30 are not held, and the day's overlapping fixtures (five jobs share bays at 11:00-11:15) leave no free bay; the last start is close - cutoff = 4:00 PM. `11:00 AM` and `1:00 PM` blocked and `2:30 PM` and `4:00 PM` available match. |
| 11 | Calendar count for tomorrow | `5` (4 procedural + a12) | `1` | The design's calendar counts 4 jobs on tomorrow that its own board and Tomorrow tab never list. The seed keeps tomorrow to the fixture so the board matches; the week of Jun 14-20, the June month grid and tomorrow's day view differ by exactly those 4 (asserted). |
| 12 | Totals, tax and balances (all 12 appointments) | whole dollars (`a1 $99`, `a4 $197`, `a9 $578`) | cents (`98.95`, `196.88`, `577.80`) | Money is integer cents with 7% half-up per invoice; golden vectors INV-20603 16478, INV-20604 19688, INV-20605 27820, INV-20607 13375, INV-20608 57780 are asserted. The full list is in `file.golden.test.ts` (a1 99 to 98.95, a2 421 to 421.25, a3 165 to 164.78, a4 197 to 196.88, a5 278 to 278.20, a6 193 to 192.60, a7 134 to 133.75, a8 48 to 48.15, a9 578 to 577.80, a10 48 to 48.15, a11 696 to 695.50, a12 139 to 139.10). The subtotals match exactly, and the cent tax rounded to a dollar equals the design's tax for all 12. |

## Rule changes that this seed cannot show (covered by unit tests)

These replace design behaviour but produce the same text for the fixtures, so the oracle cannot see them:

- Late is computed (`now > start + ops.late_grace_min`, booked or confirmed) instead of the fixture's `late` flag; a7 is late
  because 10:36 is past 10:25. It clears on arrive and reschedule.
- "Needs bay assignment" fires only for jobs of today with no planned bay (the design flagged every non-completed job).
- "Unconfirmed" -> "Send reminder" re-sends the reminder; it does not confirm.
- The "Special instructions" ellipsis is appended only when the text is truncated (the fixture's is 80 characters).
- "Arriving soon" uses the arrival setting `prep_at_min` (15), and the ETA alert shows only up to `ops.eta_visible_max_min` (30).
- "Member credit available" needs a real unused credit from the membership port (the design matched the exact string
  `Premium`); the fixture's a3 has one.
- Today is not special-cased: a holiday, a day off or an emergency closes it in the calendar and the engine.
- Staff columns are derived (active Crew-role employees), not hard-coded; avatar colours and titles come from the employee.
- Status `no_show` and the canceled terminal state exist; the design only had labels for them.

## Re-extracting

```bash
cd ~/oasis/dashboard
export PATH=$HOME/.local/bin:$PATH NODE_OPTIONS=--max-old-space-size=2048
npx tsx ~/oasis/wt/o1-scheduling/test/golden/ops/extract/extract-original.ts \
  --out ~/oasis/wt/o1-scheduling/test/golden/ops/original.json
```

The script serves the original bundle with the dashboard's `startOriginalServer` and `OriginalDriver` (clock paused at
`2026-06-13T10:36:00-04:00`, `America/New_York`, light theme), reads `renderVals()` and the logic instance's own helpers
(`countFor`, `dayInfo`, `total`, `balance`, `checkVM`) through the React fiber, drives the range tabs, the New Appointment
panel and the calendar (day, week and month with the arrow keys) and writes JSON only to `--out`. It never writes inside the
dashboard repository. The dashboard parity harness (`pnpm parity:all`) is not affected.
