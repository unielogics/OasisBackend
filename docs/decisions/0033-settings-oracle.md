# 0033 The original design as an automated oracle for Settings

Status: accepted (2026-10-06)

`test/fixtures/golden/settings-original.json` is read from the live `renderVals()` of the original Settings bundle (the
dashboard repo's parity harness renders it offline at the frozen clock; the extraction script is
`test/settings-http/golden/extract-settings-oracle.mjs`, commands in `test/fixtures/golden/README.md`). `oracle.test.ts` seeds
the `design` profile and the design's Saturday and asserts: hour rows and week totals before and after edits, rule and option
sets, closure rows (date parts, type labels, order), the idle strip line and access wording, the preview message, affected
list, summary and toast of six emergency configurations, VIP holds, steppers, cadences and toasts, and every package, add-on,
price, duration and task.

Where the API intentionally differs it is asserted as a difference, not skipped: a reopening time that has passed and a
"through" date more than 60 days out are 422 (the original accepts them); counts, rebooked numbers and closure sub-lines come
from rows (the original fakes them); the history line shows the real notified count. VIP clients added in one instant list by
name rather than insertion order (`vip_clients` has no sequence column; only seeds hit this).
