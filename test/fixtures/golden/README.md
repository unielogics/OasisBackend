# Golden values from the original Settings design

`settings-original.json` holds values read from the **original** Settings prototype (`design/original/settings.bundle.html` in
the dashboard repo), rendered offline at the frozen clock 2026-06-13 10:36 America/New_York. The prototype's own
functions did the computing (its logic instance is driven with `setState`, then `renderVals()` is read), so nothing was
re-implemented. `test/settings-http/oracle.test.ts` asserts the API against it.

Regenerate (read-only against the dashboard repo; the output path is the only thing written):

```bash
cd ~/oasis/dashboard
export PATH=$HOME/.local/bin:$PATH NODE_OPTIONS=--max-old-space-size=2048
PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-arm64 pnpm exec tsx \
  ~/oasis/wt/s1-settings-api/test/settings-http/golden/extract-settings-oracle.mts \
  ~/oasis/wt/s1-settings-api/test/fixtures/golden/settings-original.json
```

What it records: the hours table and week total (initial and after two edits), the booking-rule option sets, closure rows
(date parts, names, type labels, order), the idle strip text and access line, the emergency preview message, affected list,
summary, toast and history line for six option combinations, VIP holds/steppers/option sets/cadences/clients, the hold and VIP
toasts, the arrival explainer for three combinations, and the packages and add-ons with prices, durations and tasks.

Differences that are deliberate (asserted as such in the test): the original accepts a reopening time that has already
passed and any "through" date (the API rejects both), fakes the affected counts, rebooked counters and the closure sub-lines
(the API computes them from rows), and says "1 customers" (the dashboard builds toast text; the API sends the real count).
