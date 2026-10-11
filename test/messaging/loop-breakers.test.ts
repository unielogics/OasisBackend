// The assistant gate's loop breakers (ADR 0160, design section 3): pure helpers.
import { describe, expect, it } from 'vitest'
import {
  burstBreaker,
  identicalBreaker,
  LOOP_BURST_MAX,
  LOOP_IDENTICAL_COUNT,
  LOOP_IDENTICAL_WINDOW_MS,
  loopBreaker,
  sameTextKey,
  senderBreaker,
  type RecentInbound,
} from '../../src/modules/messaging/assistant/loop-breakers.js'

const now = new Date('2026-06-13T10:36:00-04:00')
const ago = (ms: number): Date => new Date(now.getTime() - ms)
const texts = (body: string, ...agoMs: number[]): RecentInbound[] => agoMs.map((ms) => ({ body, at: ago(ms) }))

describe('senderBreaker', () => {
  it.each([
    ['AMAZON', null, 'loop_sender'],
    ['32665', null, 'loop_sender'],
    ['+72975', '+72975', 'loop_sender'],
    ['Verizon 611', null, 'loop_sender'],
    ['+18623885827', '+18623885827', 'own_number'],
    ['+17865550151', '+17865550151', null],
  ] as const)('%s -> %s', (from, phone, want) => {
    expect(senderBreaker(from, phone, ['+18623885827'])).toBe(want)
  })
})

describe('identicalBreaker', () => {
  it(`trips on the ${LOOP_IDENTICAL_COUNT}rd identical text inside the window, not before`, () => {
    expect(identicalBreaker('Out of office', texts('Out of office', 0, 60_000), now)).toBe(false)
    expect(identicalBreaker('Out of office', texts('Out of office', 0, 60_000, 120_000), now)).toBe(true)
  })

  it('case, spacing and edge punctuation do not make texts different', () => {
    expect(sameTextKey('  Out   of OFFICE!! ')).toBe(sameTextKey('out of office'))
    const recent = [...texts('OUT OF OFFICE.', 0), ...texts('out of office', 1000), ...texts(' Out of  office ', 2000)]
    expect(identicalBreaker('out of office', recent, now)).toBe(true)
  })

  it('old repeats and different texts do not count', () => {
    const recent = [...texts('ok', 0, 1000), ...texts('ok', LOOP_IDENTICAL_WINDOW_MS + 1), ...texts('okay', 2000)]
    expect(identicalBreaker('ok', recent, now)).toBe(false)
  })
})

describe('burstBreaker', () => {
  it(`more than ${LOOP_BURST_MAX} texts in a minute`, () => {
    const five = [0, 5_000, 10_000, 20_000, 30_000].map((ms) => ({ body: `t${ms}`, at: ago(ms) }))
    expect(burstBreaker(five, now)).toBe(false)
    expect(burstBreaker([...five, { body: 'x', at: ago(40_000) }], now)).toBe(true)
    expect(burstBreaker([...five, { body: 'x', at: ago(61_000) }], now)).toBe(false)
  })
})

describe('loopBreaker', () => {
  const base = { from: '+17865550151', phone: '+17865550151', ownNumbers: ['+18623885827'], now }
  it('a normal conversation passes', () => {
    expect(loopBreaker({ ...base, body: 'hi', recent: texts('hi', 0) })).toBeNull()
  })
  it('the sender check comes first, then the burst, then repeats', () => {
    expect(loopBreaker({ ...base, from: 'AMAZON', phone: null, body: 'x', recent: [] })).toBe('loop_sender')
    const burst = [0, 1, 2, 3, 4, 5].map((s) => ({ body: 'same', at: ago(s * 1000) }))
    expect(loopBreaker({ ...base, body: 'same', recent: burst })).toBe('loop_burst')
    expect(loopBreaker({ ...base, body: 'same', recent: texts('same', 0, 120_000, 240_000) })).toBe('loop_identical')
  })
})
