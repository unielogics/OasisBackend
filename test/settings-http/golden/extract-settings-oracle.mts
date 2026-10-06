// @ts-nocheck: a throwaway script run by the dashboard repo's tsx (browser globals, dashboard modules), not part of this project's build
// Throwaway oracle extraction: renders the ORIGINAL Settings bundle offline (the dashboard repo's parity harness) and
// records the values the backend must reproduce into test/fixtures/golden/settings-original.json.
//
//   cd ~/oasis/dashboard
//   export PATH=$HOME/.local/bin:$PATH NODE_OPTIONS=--max-old-space-size=2048
//   PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-arm64 pnpm exec tsx \
//     ~/oasis/wt/s1-settings-api/test/settings-http/golden/extract-settings-oracle.mts \
//     ~/oasis/wt/s1-settings-api/test/fixtures/golden/settings-original.json
//
// It only reads the dashboard repo; the output goes into the path given as the first argument. The original's own
// functions do the work (setState on its logic instance, then renderVals), so nothing here re-implements a formula.
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const out = process.argv[2]
if (!out) throw new Error('usage: extract-settings-oracle.mts <output.json>')
const load = async (rel: string) => import(path.join(root, 'tools/parity', rel))
const { launchBrowser } = await load('browser.ts')
const { startOriginalServer } = await load('serve-original.ts')
const { OriginalDriver } = await load('drivers.ts')

const browser = await launchBrowser()
const server = await startOriginalServer()
const driver = new OriginalDriver(browser, server)
await driver.open({ screen: 'settings', theme: 'light' })
const page = driver.page

/** Runs `body` with `logic` (the live DCLogic instance) in the page and returns its JSON-serialisable result. */
async function inLogic(body: string): Promise<any> {
  return page.evaluate(
    ({ code }) => {
      const host = document.querySelector('#dc-root .sc-host') as any
      const key = Object.keys(host).find((k) => k.startsWith('__reactFiber$'))!
      let fiber = host[key]
      while (fiber) {
        const inst = fiber.stateNode
        if (inst && inst.logic && typeof inst.logic.renderVals === 'function') {
          // eslint-disable-next-line no-new-func
          return new Function('logic', `return (${code})(logic)`)(inst.logic)
        }
        fiber = fiber.return
      }
      throw new Error('logic instance not found')
    },
    { code: body },
  )
}
const settle = () => driver.actions.settle()

const pick = `(logic) => {
  const v = logic.renderVals();
  const rows = (a) => a.map((r) => ({ ...r }));
  const plain = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k]]));
  return {
    weekHours: v.weekHours,
    hourRows: v.hourRows.map((r) => plain(r, ['day', 'open', 'closed', 'from', 'to', 'len'])),
    rules: v.ruleRows.map((r) => ({ label: r.label, opts: r.opts.map((o) => o.label) })),
    upcoming: v.upcoming.map((r) => plain(r, ['mon', 'day', 'dow', 'name', 'typeLabel', 'past'])),
    past: v.past.map((r) => plain(r, ['mon', 'day', 'dow', 'name', 'typeLabel', 'past'])),
    emActive: v.emActive,
    emSummary: v.emSummary,
    emPreview: v.emPreview,
    emReasons: v.emReasons.map((r) => r.label),
    emDurations: v.emDurations.map((r) => r.label),
    emOpts: v.emOpts.map((o) => ({ label: o.label, sub: o.sub })),
    emAffected: v.emAffected,
    emAffectedCount: v.emAffectedCount,
    emHistory: v.emHistory,
    confirmText: v.confirmText,
    vipHolds: v.vipHolds.map((h) => h.label),
    vipSteppers: v.vipSteppers.map((s) => ({ label: s.label, sub: s.sub, val: s.val })),
    releaseOpts: v.releaseOpts.map((o) => o.label),
    offerOpts: v.offerOpts.map((o) => o.label),
    cadenceOpts: v.cadenceOpts.map((o) => o.label),
    vipToggles: v.vipToggles.map((t) => ({ label: t.label, sub: t.sub })),
    vipClients: v.vipClients.map((c) => c.name),
    vipCount: v.vipCount,
    arrToggles: v.arrToggles.map((t) => ({ label: t.label, sub: t.sub })),
    radiusOpts: v.radiusOpts.map((o) => o.label),
    prepOpts: v.prepOpts.map((o) => o.label),
    arrSteps: v.arrSteps,
    toast: logic.state.toast,
  };
}`

const golden: Record<string, any> = {
  extractedFrom:
    'design/original/settings.bundle.html (renderVals of the live logic instance), frozen 2026-06-13 10:36 America/New_York',
}

golden.initial = await inLogic(pick)
// The idle status strip and the access note are static text in the template (the numbers are hard-coded there).
await inLogic(`(logic) => logic.setState({ section: 'emergency' })`)
await settle()
golden.emergencyText = await page.evaluate(() => {
  const leaves = [...document.querySelectorAll('#dc-root *')].filter(
    (e) => e.children.length === 0 || e.querySelectorAll('span.sc-interp').length === e.children.length,
  )
  const text = (needle: string) =>
    leaves.map((e) => (e.textContent ?? '').trim()).find((t) => t.includes(needle)) ?? null
  return {
    idleStrip: text('Open now'),
    access: text('Requires Management'),
    closeButton: text('Close the shop now'),
  }
})
await inLogic(`(logic) => logic.setState({ section: 'hours' })`)
await settle()
golden.state = await inLogic(`(logic) => ({
  hours: logic.state.hours, federal: logic.state.federal, vip: logic.state.vip, arrival: logic.state.arrival, em: logic.state.em, rules: logic.state.rules,
  packages: logic.state.packages, addons: logic.state.addons, closures: logic.state.closures,
  remaining: logic.REMAINING, holdDay: logic.state.holdDay, holdTime: logic.state.holdTime,
})`)

// Hours edits: Saturday closes at 4:30 PM, Sunday closed.
await inLogic(
  `(logic) => logic.setState((st) => { const hours = JSON.parse(JSON.stringify(st.hours)); hours[6].to = '4:30 PM'; hours[0].open = false; return { hours } })`,
)
await settle()
golden.hoursEdited = await inLogic(pick)
await inLogic(
  `(logic) => logic.setState((st) => { const hours = JSON.parse(JSON.stringify(st.hours)); hours[1].to = '5:30 PM'; return { hours } })`,
)
await settle()
golden.hoursEdited2 = await inLogic(pick)

// Emergency configurations: set the options, preview, close, read the summary and toast, reopen.
const configs = [
  { reason: 'Severe weather', dur: 'today', notify: true, pause: true },
  { reason: 'Power outage', dur: 'until', until: '3:30 PM', notify: true, pause: false },
  { reason: 'Equipment failure', dur: 'days', through: '2026-06-15', notify: false, pause: true },
  { reason: 'Staff shortage', dur: 'until', until: '11:00 AM', notify: true, pause: true },
  { reason: 'Other', dur: 'days', through: '2026-12-25', notify: true, pause: false },
  { reason: 'Severe weather', dur: 'until', until: '10:30 AM', notify: true, pause: true },
]
golden.emergency = []
for (const cfg of configs) {
  await inLogic(
    `(logic) => logic.setState((st) => ({ em: { ...st.em, ...${JSON.stringify(cfg)}, active: false } }))`,
  )
  await settle()
  const preview = await inLogic(pick)
  await inLogic(`(logic) => logic.renderVals().doClose()`)
  await settle()
  const closed = await inLogic(pick)
  await inLogic(`(logic) => logic.renderVals().reopen()`)
  await settle()
  const reopened = await inLogic(pick)
  golden.emergency.push({
    config: cfg,
    preview: {
      emPreview: preview.emPreview,
      emAffected: preview.emAffected,
      emAffectedCount: preview.emAffectedCount,
      confirmText: preview.confirmText,
    },
    closed: { emSummary: closed.emSummary, toast: closed.toast },
    reopened: { toast: reopened.toast, history: reopened.emHistory[0] },
  })
}

// VIP and arrival: the toasts and the explainer for each combination.
await inLogic(`(logic) => logic.renderVals().addHold()`)
await settle()
golden.holdAdded = await inLogic(pick)
await inLogic(`(logic) => logic.renderVals().addHold()`)
await settle()
golden.holdDuplicate = { toast: (await inLogic(pick)).toast }
await inLogic(`(logic) => logic.setState({ vipNew: '  Test Person ' })`)
await settle()
await inLogic(`(logic) => logic.renderVals().addVip()`)
await settle()
golden.vipAdded = await inLogic(pick)
golden.arrival = []
for (const a of [
  { prepAt: 20, radius: 500, autoArrive: false, welcome: false },
  { prepAt: 10, radius: 150, autoArrive: true, welcome: false },
  { prepAt: 15, radius: 300, autoArrive: false, welcome: true },
]) {
  await inLogic(
    `(logic) => logic.setState((st) => ({ arrival: { ...st.arrival, ...${JSON.stringify(a)} } }))`,
  )
  await settle()
  const v = await inLogic(pick)
  golden.arrival.push({ config: a, arrSteps: v.arrSteps })
}

await driver.close()
await browser.close()
await server.close()
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, JSON.stringify(golden, null, 2) + '\n')
console.log(`wrote ${out}`)
