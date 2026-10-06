// Extracts the golden values of the Payments design from the ORIGINAL bundle (the oracle). Not part of any test run:
//   cd ~/oasis/dashboard && PATH=$HOME/.local/bin:$PATH npx tsx ~/oasis/wt/p1-payments/test/golden/pay/extract-oracle.mjs [outDir]
// It serves design/original/payments.bundle.html, renders it in the harness's pinned Chromium (clock 2026-06-13T10:36 -04:00,
// role mgmt, light theme), reads the live logic instance behind .sc-host, and writes JSON next to this file:
//   fixtures.json   the 105 invoices exactly as the original builds them (state.txs, in original order, ids collide)
//   calcs.json      logic.calc(tx) for each of them (floats, dollars)
//   views.json      per range x filter: renderVals kpis/bars/methods/filters/rows + raw float aggregates and chart buckets
//   details.json    renderVals().d for selected invoices (lines, big, actions, ledger, creditLine) + the pending banner
//   scenarios.json  sheet previews and results of commands driven through the original UI (see SCENARIOS below)
import fs from 'node:fs'
import path from 'node:path'

const D = '/home/ec2-user/oasis/dashboard'
const out = process.argv[2] ?? path.dirname(new URL(import.meta.url).pathname)
const { launchBrowser } = await import(`${D}/tools/parity/browser.ts`)
const { startOriginalServer } = await import(`${D}/tools/parity/serve-original.ts`)
const { OriginalDriver } = await import(`${D}/tools/parity/drivers.ts`)
const { serializeVals } = await import(`${D}/tools/parity/vals-serialize.ts`)

const RANGES = [
  ['today', 'Today'],
  ['7d', '7 days'],
  ['30d', '30 days'],
  ['mtd', 'Month to date'],
]
const FILTERS = [
  ['all', 'All'],
  ['unpaid', 'Open balance'],
  ['refunds', 'Refunds'],
  ['adjusted', 'Adjusted'],
  ['credits', 'Credits'],
]
const DETAIL_IDS = [
  'INV-20603',
  'INV-20608',
  'INV-20607',
  'INV-20606',
  'INV-20605',
  'INV-20604',
  'INV-20602',
  'INV-20601',
  'INV-20579',
  'INV-20571',
  'INV-20566',
  'INV-20560',
  'INV-20552',
  'INV-20548',
  'INV-20610',
  'INV-20609',
]

// Runs in the page: finds the logic instance through React (same walk as OriginalDriver.readVals).
const FIND = `(() => {
  const host = document.querySelector('#dc-root .sc-host');
  const key = Object.keys(host).find((k) => k.startsWith('__reactFiber$'));
  let fiber = key ? host[key] : null;
  while (fiber) { const inst = fiber.stateNode; if (inst && inst.logic && typeof inst.logic.renderVals === 'function') return inst.logic; fiber = fiber.return; }
  throw new Error('logic instance not found');
})()`

const server = await startOriginalServer({ strictPort: false })
const browser = await launchBrowser()
const driver = new OriginalDriver(browser, server)
try {
  await driver.open({ screen: 'payments', theme: 'light' })
  const { page, actions } = driver
  const ser = serializeVals.toString()

  const click0 = async (re) => {
    await actions.btn(re, 0).click({ timeout: 10_000 })
    await actions.settle()
  }
  const read = (body) =>
    page
      .evaluate(`(() => { const logic = ${FIND}; const ser = ${ser}; ${body} })()`)
      .then((s) => JSON.parse(s))

  const fixtures = await read(
    `return JSON.stringify(logic.state.txs.map((t) => ({ ...t, events: t.events.map((e) => ({ ...e })) })))`,
  )
  const calcs = await read(
    `return JSON.stringify(logic.state.txs.map((t) => { const c = logic.calc(t); return { ...c, pending: c.pending.map((e) => e.amt) }; }))`,
  )
  const meta = await read(
    `const s = logic.state; return JSON.stringify({ role: s.role, range: s.range, filter: s.filter, selId: s.selId, theme: s.theme, now: String(Date.now()) })`,
  )

  // raw float aggregates and chart buckets, computed with the original's own calc over the original's own state
  const RAW = `
    const s = logic.state;
    const R = { today:[0,0], '7d':[-6,0], '30d':[-29,0], mtd:[-12,0] }[s.range];
    const inR = s.txs.filter((t) => t.off >= R[0] && t.off <= R[1]).map((t) => ({ t, c: logic.calc(t) }));
    const sum = (f) => inR.reduce((a, x) => a + f(x), 0);
    const agg = { gross: sum((x) => x.c.items), adj: sum((x) => x.c.adj), refunds: sum((x) => x.c.refunded), credits: sum((x) => x.c.issued), outstanding: sum((x) => x.c.balance) };
    agg.net = agg.gross + agg.adj - agg.refunds / (1 + logic.TAX);
    const cnt = (f) => inR.filter(f).length;
    const counts = { invoices: inR.length, refunded: cnt((x) => x.c.refunded > 0), adjusted: cnt((x) => x.c.adj !== 0), creditInvoices: cnt((x) => x.c.issued > 0), openBalances: cnt((x) => x.c.balance > 0) };
    let buckets = [];
    if (s.range === 'today') { for (let h = 8; h <= 17; h++) buckets.push({ key: h, test: (x) => { const m = x.t.time.match(/(\\d+):\\d+\\s*(AM|PM)/); let hh = +m[1] % 12; if (m[2] === 'PM') hh += 12; return hh === h; } }); }
    else { for (let o = R[0]; o <= R[1]; o++) buckets.push({ key: o, test: (x) => x.t.off === o }); }
    const chart = buckets.map((b) => { const L = inR.filter(b.test); return { key: b.key, net: L.reduce((a, x) => a + x.c.net, 0), loss: L.reduce((a, x) => a + x.c.refunded + Math.max(0, -x.c.adj), 0), n: L.length }; });
    const fam = (m) => (/visa|master|amex/i.test(m) ? 'Card' : m === 'Apple Pay' ? 'Apple Pay' : m === 'Cash' ? 'Cash' : 'Store credit');
    const mt = { Card: 0, 'Apple Pay': 0, Cash: 0, 'Store credit': 0 };
    inR.forEach((x) => x.t.events.forEach((e) => { if (e.type === 'pay') mt[fam(e.method)] += e.amt; if (e.type === 'credit_apply') mt['Store credit'] += e.amt; }));
    const dropped = inR.filter((x) => !chart.some((b, i) => buckets[i].test(x))).length;
  `
  const views = {}
  for (const [rk, rl] of RANGES) {
    await click0(new RegExp(`^\\s*${rl}`))
    views[rk] = {}
    for (const [fk, fl] of FILTERS) {
      await click0(new RegExp(`^\\s*${fl}\\s*\\d+`))
      views[rk][fk] = await read(`${RAW}
        const v = ser(logic.renderVals());
        const pick = (r) => ({ id: r.id, date: r.date, client: r.client, vehicle: r.vehicle, items: r.items, total: r.total, status: r.status, adjusted: r.adjusted });
        return JSON.stringify({
          state: { range: s.range, filter: s.filter },
          rangeLabel: v.rangeLabel, kpis: v.kpis, bars: v.bars.map((b) => ({ label: b.label, title: b.title, netHeight: b.netStyle.height, netMin: b.netStyle.minHeight, lossHeight: b.lossStyle.height })),
          methods: v.methods.map((m) => ({ label: m.label, value: m.value, width: m.barStyle.width })), filters: v.filters.map((f) => ({ label: f.label, count: f.count })),
          rows: v.rows.map(pick), noRows: v.noRows, hasPending: v.hasPending, pendingText: v.pendingText,
          raw: { agg, counts, chart, methods: mt, droppedFromChart: dropped },
        })`)
    }
  }

  // details: selected invoices (range 30d so every explicit one is visible), light theme
  await click0(/^\s*30 days/)
  await click0(/^\s*All\s*\d+/)
  const details = {
    pending: await read(
      `const v = ser(logic.renderVals()); return JSON.stringify({ hasPending: v.hasPending, pendingText: v.pendingText })`,
    ),
  }
  const pickD = `const v = ser(logic.renderVals()); const d = v.d;
    return JSON.stringify({ id: d.id, when: d.when, client: d.client, vehicle: d.vehicle, staff: d.staff, status: d.status,
      big: d.big.map((b) => ({ label: b.label, value: b.value })), lines: d.lines.map((l) => ({ label: l.label, value: l.value })),
      actions: d.actions.map((a) => ({ label: a.label, disabled: a.disabled, why: a.why })),
      ledger: d.ledger.map((e) => ({ glyph: e.glyph, title: e.title, meta: e.meta, amt: e.amt, pending: e.pending, approveNote: e.approveNote })), creditLine: d.creditLine })`
  const pickAfter = `const d = ser(logic.renderVals()).d; const c = logic.calc(logic.state.txs.find((t) => t.id === d.id));
    return JSON.stringify({ status: d.status, big: d.big.map((b) => ({ label: b.label, value: b.value })), lines: d.lines.map((l) => ({ label: l.label, value: l.value })),
      ledger: d.ledger.map((e) => ({ title: e.title, amt: e.amt, meta: e.meta, pending: e.pending })), creditLine: d.creditLine,
      calc: { total: c.total, paid: c.paid, refunded: c.refunded, balance: c.balance, refundable: c.refundable, toOrigMax: c.toOrigMax, pending: c.pending.map((e) => e.amt) } })`
  details.invoices = {}
  for (const id of DETAIL_IDS) {
    const loc = actions.btn(new RegExp(`${id}(?!\\d)`), 0)
    await loc.click({ timeout: 10_000 })
    await actions.settle()
    details.invoices[id] = await read(pickD)
  }

  // --- command scenarios: the original's own sheet logic driven in a fresh page per scenario ---------------------------------
  const SCENARIOS = [
    [
      'refund_full_card',
      'INV-20606',
      'mgmt',
      [['open', 'refund', { dest: 'card', mode: 'full' }], ['sheet'], ['submit']],
    ],
    [
      'refund_items_card',
      'INV-20601',
      'mgmt',
      [['open', 'refund', { mode: 'items', items: [1], dest: 'card' }], ['sheet'], ['submit']],
    ],
    [
      'refund_items_credit',
      'INV-20608',
      'mgmt',
      [['open', 'refund', { mode: 'items', items: [0, 1], dest: 'credit' }], ['sheet'], ['submit']],
    ],
    [
      'refund_full_card_blocked',
      'INV-20560',
      'mgmt',
      [['open', 'refund', { dest: 'card', mode: 'full' }], ['sheet']],
    ],
    [
      'refund_custom_over_refundable',
      'INV-20606',
      'mgmt',
      [['open', 'refund', { dest: 'card', mode: 'custom', amount: '500' }], ['sheet']],
    ],
    [
      'refund_support_over_limit',
      'INV-20608',
      'support',
      [
        ['open', 'refund', { dest: 'card', mode: 'custom', amount: '80', reason: 'Goodwill', note: 'x' }],
        ['sheet'],
        ['submit'],
      ],
    ],
    [
      'refund_support_at_limit',
      'INV-20608',
      'support',
      [['open', 'refund', { dest: 'card', mode: 'custom', amount: '50' }], ['sheet'], ['submit']],
    ],
    [
      'refund_cash_custom',
      'INV-20602',
      'mgmt',
      [['open', 'refund', { dest: 'cash', mode: 'custom', amount: '100' }], ['sheet'], ['submit']],
    ],
    [
      'adjust_pct_settle_credit',
      'INV-20608',
      'mgmt',
      [
        ['open', 'adjust', { kind: 'discount', unit: '%', amount: '10', settle: 'credit' }],
        ['sheet'],
        ['submit'],
      ],
    ],
    [
      'adjust_pct_settle_card',
      'INV-20608',
      'mgmt',
      [
        ['open', 'adjust', { kind: 'discount', unit: '%', amount: '10', settle: 'card' }],
        ['sheet'],
        ['submit'],
      ],
    ],
    [
      'adjust_surcharge_unpaid',
      'INV-20603',
      'mgmt',
      [
        ['open', 'adjust', { kind: 'surcharge', unit: '$', amount: '10', reason: 'Oversize vehicle' }],
        ['sheet'],
        ['submit'],
      ],
    ],
    [
      'adjust_discount_unpaid',
      'INV-20603',
      'mgmt',
      [['open', 'adjust', { kind: 'discount', unit: '$', amount: '20' }], ['sheet'], ['submit']],
    ],
    [
      'adjust_support_over_limit',
      'INV-20603',
      'support',
      [['open', 'adjust', { kind: 'discount', unit: '$', amount: '30' }], ['sheet']],
    ],
    [
      'adjust_larger_than_invoice',
      'INV-20603',
      'super',
      [['open', 'adjust', { kind: 'discount', unit: '$', amount: '500' }], ['sheet']],
    ],
    [
      'credit_issue_30d',
      'INV-20603',
      'mgmt',
      [['open', 'credit', { amount: '25', expiry: '30 days', reason: 'Goodwill' }], ['sheet'], ['submit']],
    ],
    ['credit_issue_support_over', 'INV-20603', 'support', [['open', 'credit', { amount: '60' }], ['sheet']]],
    ['credit_apply', 'INV-20603', 'mgmt', [['open', 'apply', {}], ['sheet'], ['submit']]],
    ['collect_cash', 'INV-20603', 'mgmt', [['open', 'collect', { method: 'Cash' }], ['sheet'], ['submit']]],
    ['approve_mgmt', 'INV-20579', 'mgmt', [['approve']]],
    ['approve_support', 'INV-20579', 'support', [['approve']]],
    ['deny_mgmt', 'INV-20579', 'mgmt', [['deny']]],
  ]
  const scenarios = {}
  for (const [name, selId, role, steps] of SCENARIOS) {
    const d2 = new OriginalDriver(browser, server)
    await d2.open({ screen: 'payments', theme: 'light' })
    const rd = (body) =>
      d2.page
        .evaluate(`(() => { const logic = ${FIND}; const ser = ${ser}; ${body} })()`)
        .then((s) => JSON.parse(s))
    await rd(
      `logic.setState({ selId: ${JSON.stringify(selId)}, role: ${JSON.stringify(role)}, range: '30d' }); return 'null'`,
    )
    const log = []
    for (const [op, kind, preset] of steps) {
      if (op === 'open')
        await rd(`logic.openSheet(${JSON.stringify(kind)}, ${JSON.stringify(preset)}); return 'null'`)
      if (op === 'sheet') {
        log.push({
          op,
          ...(await rd(
            `const sh = ser(logic.renderVals()).sh; return JSON.stringify({ summary: sh.summary.map((x) => ({ label: x.label, value: x.value })), blocked: sh.blocked, permText: sh.permText, submitLabel: sh.submitLabel, hasReasons: sh.hasReasons, reasons: (sh.reasons || []).map((r) => r.label) })`,
          )),
        })
      }
      if (op === 'submit' || op === 'approve' || op === 'deny') {
        const call =
          op === 'submit'
            ? `logic.renderVals().sh.submit()`
            : `logic.renderVals().d.ledger.find((e) => e.pending)[${JSON.stringify(op)}]()`
        const approveNote =
          op === 'submit' ? 'null' : `logic.renderVals().d.ledger.find((e) => e.pending).approveNote`
        const note = await rd(`return JSON.stringify(${approveNote})`)
        await rd(`${call}; return 'null'`)
        log.push({
          op,
          approveNote: note,
          toast: await rd(`return JSON.stringify(logic.state.toast)`),
          after: await rd(pickAfter),
        })
      }
    }
    scenarios[name] = { selId, role, log }
    await d2.close()
  }
  fs.writeFileSync(path.join(out, 'scenarios.json'), JSON.stringify(scenarios, null, 1) + '\n')

  fs.writeFileSync(path.join(out, 'fixtures.json'), JSON.stringify(fixtures, null, 1) + '\n')
  fs.writeFileSync(path.join(out, 'calcs.json'), JSON.stringify(calcs, null, 1) + '\n')
  fs.writeFileSync(path.join(out, 'views.json'), JSON.stringify({ meta, views }, null, 1) + '\n')
  fs.writeFileSync(path.join(out, 'details.json'), JSON.stringify(details, null, 1) + '\n')
  console.log(`wrote ${fixtures.length} fixtures, ${Object.keys(views).length} ranges to ${out}`)
} finally {
  await driver.close().catch(() => undefined)
  await browser.close().catch(() => undefined)
  await server.close().catch(() => undefined)
}
