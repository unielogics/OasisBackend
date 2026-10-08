// More ways to say "stop texting me": REVOKE, OPT OUT / OPTOUT and STOP ALL, whatever the case, spacing or punctuation (the FCC's
// 2024 order names "revoke" and "opt out" among the words that revoke consent). CANCEL keeps its meaning here: it asks staff to
// cancel the appointment (ADR 0124 lays out that question for the owner).
import { describe, expect, it } from 'vitest'
import { parseKeyword } from '../../src/modules/messaging/inbound/keywords.js'

describe('opt-out keywords', () => {
  it.each([
    'REVOKE',
    'revoke',
    ' Revoke. ',
    'REVOKE!',
    'OPT OUT',
    'opt out',
    'Opt-Out',
    'opt_out',
    'OPT  OUT',
    'Opt out.',
    'opt-out!',
    'OPTOUT',
    'optout',
    'Opt.Out',
    'STOP ALL',
    'stop all',
    'Stop-All',
    'STOP  ALL!',
    'stopall',
    'Stop all.',
  ])('%j is an opt-out', (body) => {
    expect(parseKeyword(body).kind).toBe('opt_out')
  })

  it('reports the keyword in one canonical spelling', () => {
    expect(parseKeyword('Opt-Out')).toEqual({ kind: 'opt_out', keyword: 'OPTOUT' })
    expect(parseKeyword('stop all')).toEqual({ kind: 'opt_out', keyword: 'STOPALL' })
    expect(parseKeyword('revoke')).toEqual({ kind: 'opt_out', keyword: 'REVOKE' })
  })

  it.each([
    ['please opt me out', 'none'],
    ['opt out of the wax please', 'none'],
    ['stop all the texts about promos', 'none'],
    ['revoke my booking', 'none'],
    ['stop stop', 'none'],
    ['opt in', 'none'],
    ['CANCEL', 'cancel'],
    ['cancel.', 'cancel'],
    ['Cancel!', 'cancel'],
  ])('%j stays %s', (body, kind) => {
    expect(parseKeyword(body).kind).toBe(kind)
  })
})
