// Throwaway extraction of the ORIGINAL Operations bundle's live renderVals() values (the oracle for the scheduling tests).
//
//   cd ~/oasis/dashboard
//   export PATH=$HOME/.local/bin:$PATH NODE_OPTIONS=--max-old-space-size=2048
//   npx tsx ~/oasis/wt/o1-scheduling/test/golden/ops/extract/extract-original.ts --out ~/oasis/wt/o1-scheduling/test/golden/ops/original.json
//
// It serves design/original/operations.bundle.html with the dashboard's parity tooling (OriginalDriver, serve-original),
// pinned to 2026-06-13T10:36:00-04:00 in America/New_York, light theme, and writes the values the backend must
// reproduce or deliberately differ from (see DEVIATIONS.md). It never writes inside the dashboard repository.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DASH = process.env.OASIS_DASHBOARD ?? path.join(os.homedir(), 'oasis', 'dashboard')
const outIdx = process.argv.indexOf('--out')
const OUT = outIdx > 0 ? process.argv[outIdx + 1]! : path.resolve('original.json')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
const load = (rel: string): Promise<Any> => import(path.join(DASH, rel))

const PICK = {
  card: `i=>({id:i.id,name:i.name,vip:i.vip,member:i.memberLabel,vehicleLine:i.vehicleLine,service:i.service,time:i.time,badgeLabel:i.badgeLabel,bayLabel:i.bayLabel,durLabel:i.durLabel,payLabel:i.payLabel,nextLabel:i.nextLabel,hasNotes:!!i.hasNotes,hasPhotos:!!i.hasPhotos,hasAddons:!!i.hasAddons,addonCount:i.addonCount})`,
}

// Everything below runs inside the page against the live logic instance.
const IN_PAGE = `(() => {
  const host = document.querySelector('#dc-root .sc-host');
  const key = Object.keys(host).find((k) => k.startsWith('__reactFiber$'));
  let fiber = host[key];
  let logic = null;
  while (fiber) { const inst = fiber.stateNode; if (inst && inst.logic && typeof inst.logic.renderVals === 'function') { logic = inst.logic; break; } fiber = fiber.return; }
  if (!logic) throw new Error('logic instance not found');
  const card = ${PICK.card};
  const board = () => {
    const v = logic.renderVals();
    return {
      apptCount: v.apptCount,
      inFacilityLabel: v.inFacilityLabel,
      kpis: v.kpis.map((k) => ({ label: k.label, value: k.value, sub: k.sub })),
      alerts: v.alerts.map((a) => ({ glyph: a.glyph, title: a.title, desc: a.desc, actionLabel: a.actionLabel, pri: a.pri })),
      groups: v.groups.map((g) => ({ dividerLabel: g.dividerLabel, time: g.time, ampm: g.ampm, items: g.items.map(card) })),
      queue: v.queue.map(card),
      completed: v.completedJobs.map((c) => ({ id: c.id, name: c.name, time: c.time, vehicleLine: c.vehicleLine, service: c.service, payChipLabel: c.payChipLabel, pickupChipLabel: c.pickupChipLabel })),
      completedCount: v.completedCount,
      bays: v.bays.map((b) => ({ name: b.name, occupied: b.occupied, free: b.free, vehicle: b.vehicle, customer: b.customer, plate: b.plate, service: b.service, worker: b.worker, workerInitials: b.workerInitials, elapsed: b.elapsed, eta: b.eta, progressLabel: b.progressLabel, durLabel: b.durLabel, nextLabel: b.nextLabel, nextUp: b.nextUp, badgeLabel: b.badgeLabel })),
      arrivals: v.arrivals.map((a) => ({ title: a.title, desc: a.desc, prepLabel: a.prepLabel })),
      staffCols: v.staffCols.map((s) => ({ name: s.name, role: s.role, initials: s.initials, count: s.count, jobs: s.jobs.map((j) => ({ id: j.id, name: j.name, time: j.time })) })),
    };
  };
  const calendar = () => {
    const v = logic.renderVals();
    return {
      calLabel: v.calLabel, calSub: v.calSub, calClosed: v.calClosed, calClosedReason: v.calClosedReason,
      calWeek: v.calWeek.map((d) => ({ dow: d.dow, num: d.num, count: d.count, countLabel: d.countLabel, closed: d.closed, reason: d.reason, isToday: d.isToday })),
      calMonth: v.calMonth.map((d) => ({ num: d.num, showCount: d.showCount, countLabel: d.countLabel, closed: d.closed, reason: d.reason })),
      calRows: v.calRows.map((r) => ({ time: r.time, ampm: r.ampm, empty: r.empty, items: r.items.map((i) => ({ name: i.name, badgeLabel: i.badgeLabel })) })),
    };
  };
  const slots = () => logic.renderVals().newSlots.map((s) => ({ label: s.label, opacity: s.style.opacity, cursor: s.style.cursor }));
  return { logic, board, calendar, slots };
})()`

async function main(): Promise<void> {
  await load('tools/parity/env.ts')
  const { launchBrowser } = await load('tools/parity/browser.ts')
  const { OriginalDriver } = await load('tools/parity/drivers.ts')
  const { startOriginalServer } = await load('tools/parity/serve-original.ts')
  const server = await startOriginalServer()
  const browser = await launchBrowser()
  const d = new OriginalDriver(browser, server)
  try {
    await d.open({ screen: 'operations', theme: 'light' })
    const a = d.actions
    const page = d.page
    const exact = (t: string) => new RegExp(`^\\s*${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`)
    const run = <T>(expr: string): Promise<T> =>
      page.evaluate(`(() => { const h = ${IN_PAGE}; return JSON.parse(JSON.stringify(${expr})); })()`) as Promise<T>

    const out: Record<string, unknown> = {
      clock: '2026-06-13T10:36:00-04:00',
      extractedFrom: 'design/original/operations.bundle.html',
    }

    out.initial = await run('h.board()')

    // range tabs
    const ranges: Record<string, unknown> = {}
    for (const [key, label] of [
      ['today', 'Today'],
      ['tomorrow', 'Tomorrow'],
      ['week', 'Week'],
      ['next24', 'Next 24h'],
    ] as const) {
      await a.click(a.btn(exact(label)))
      ranges[key] = await run('h.board()')
    }
    out.ranges = ranges

    // the New Appointment slot grid
    await a.click(a.btn('New Appointment'))
    out.slots = await run('h.slots()')
    await a.click(a.btn(exact('Cancel')))

    // pure helpers of the logic class: totals, checklist progress, per-offset counts
    out.appointments = await run(`h.logic.state.appts.map((x) => {
      const t = h.logic.total(x); const ck = h.logic.checkVM(x);
      return { id: x.id, day: x.day, time: x.time, status: x.status, svc: x.svc, staff: x.staff, bay: x.bay, vip: !!x.vip, member: x.member, photos: x.photos, visits: x.visits, notes: x.notes, special: x.special, pay: x.pay, deposit: x.deposit || 0, tip: x.tip || 0, addons: x.addons.map((y) => y.name),
        sub: t.sub, tax: t.tax, grand: t.grand, balance: h.logic.balance(x),
        checkDone: ck.checkDone, checkTotal: ck.checkTotal, checkPct: ck.checkPctLabel,
        sections: ck.checkSections.map((s) => ({ title: s.title, kind: s.kind, countLabel: s.countLabel })) };
    })`)
    out.dayCounts = await run(`(() => { const o = []; for (let i = -210; i <= 210; i++) { const d = h.logic.dateFor(i); const inf = h.logic.dayInfo(d); o.push({ offset: i, iso: h.logic.iso(d), count: h.logic.countFor(i), closed: inf.closed || null, note: inf.note || '', h0: inf.h0 ?? null, h1: inf.h1 ?? null }); } return o; })()`)

    // the calendar as rendered
    await a.click(a.btn('Calendar'))
    const cal: Record<string, unknown> = {}
    const step = async (key: string): Promise<void> => {
      cal[key] = await run('h.calendar()')
    }
    await a.click(a.btn(exact('Day')))
    await step('day:0')
    for (const [name, key] of [
      ['ArrowRight', 'day:+1'],
      ['ArrowRight', 'day:+2'],
      ['ArrowRight', 'day:+3'],
    ] as const) {
      await a.press(name)
      await step(key)
    }
    await a.press('t')
    for (const [name, key] of [
      ['ArrowLeft', 'day:-1'],
      ['ArrowLeft', 'day:-2'],
    ] as const) {
      await a.press(name)
      await step(key)
    }
    await a.press('t')
    await a.click(a.btn(exact('Week')))
    await step('week:0')
    for (const [name, key] of [
      ['ArrowRight', 'week:+1'],
      ['ArrowRight', 'week:+2'],
      ['ArrowRight', 'week:+3'],
    ] as const) {
      await a.press(name)
      await step(key)
    }
    await a.press('t')
    for (const [name, key] of [
      ['ArrowLeft', 'week:-1'],
      ['ArrowLeft', 'week:-2'],
    ] as const) {
      await a.press(name)
      await step(key)
    }
    await a.press('t')
    await a.click(a.btn(exact('Month')))
    await step('month:0')
    for (const [name, key] of [
      ['ArrowRight', 'month:+1'],
      ['ArrowRight', 'month:+2'],
      ['ArrowRight', 'month:+3'],
      ['ArrowRight', 'month:+4'],
      ['ArrowRight', 'month:+5'],
      ['ArrowRight', 'month:+6'],
    ] as const) {
      await a.press(name)
      await step(key)
    }
    await a.press('t')
    for (const [name, key] of [
      ['ArrowLeft', 'month:-1'],
      ['ArrowLeft', 'month:-2'],
    ] as const) {
      await a.press(name)
      await step(key)
    }
    out.calendar = cal

    fs.mkdirSync(path.dirname(OUT), { recursive: true })
    fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n')
    console.log(`wrote ${OUT}`)
  } finally {
    await d.close()
    await browser.close()
    await server.close()
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e)
    process.exit(1)
  },
)
