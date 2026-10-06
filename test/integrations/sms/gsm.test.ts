import { describe, expect, it } from 'vitest'
import { describeSms, isGsm7, normalizeForSms, prepareSmsBody, segmentStorage } from '../../../src/integrations/sms/gsm.js'
import { TEMPLATES } from '../../../src/modules/messaging/templates/registry.js'

const cp = (...points: number[]): string => String.fromCodePoint(...points)

describe('normalizeForSms', () => {
  it('replaces curly quotes, dashes and ellipsis with ASCII', () => {
    expect(normalizeForSms('You’re checked in — pull into Bay 2… “now”')).toBe('You\'re checked in - pull into Bay 2... "now"')
  })

  it('strips emoji by default and tidies the whitespace they leave', () => {
    expect(normalizeForSms('How did we do? ⭐')).toBe('How did we do?')
    expect(normalizeForSms('Great ⭐⭐ job 🚗 today')).toBe('Great job today')
    expect(normalizeForSms('Thumbs ' + cp(0x1f44d, 0x1f3fd) + ' up')).toBe('Thumbs up')
  })

  it('keeps emoji when asked, which forces UCS-2', () => {
    const kept = normalizeForSms('Great ⭐', { emoji: 'keep' })
    expect(kept).toContain('⭐')
    expect(describeSms(kept).encoding).toBe('UCS-2')
  })

  it('transliterates accented Latin letters GSM-7 lacks, keeps the ones it has', () => {
    expect(normalizeForSms('Álvaro')).toBe('Alvaro')
    expect(normalizeForSms('José')).toBe('José')
    expect(normalizeForSms('Zoë Façade')).toBe('Zoe Facade')
    expect(isGsm7(normalizeForSms('Zoë Façade'))).toBe(true)
  })

  it('removes zero-width characters and non-breaking spaces', () => {
    expect(normalizeForSms(`a${cp(0x200b)}b${cp(0xa0)}c`)).toBe('ab c')
  })

  it('leaves scripts it cannot transliterate alone (UCS-2)', () => {
    const t = normalizeForSms('Нина')
    expect(t).toBe('Нина')
    expect(describeSms(t).encoding).toBe('UCS-2')
  })
})

describe('describeSms', () => {
  it('counts GSM-7 single and concatenated segments at 160 and 153', () => {
    expect(describeSms('a'.repeat(160))).toMatchObject({ encoding: 'GSM-7', segments: 1, units: 160, remaining: 0 })
    expect(describeSms('a'.repeat(161))).toMatchObject({ segments: 2, perSegment: 153 })
    expect(describeSms('a'.repeat(306))).toMatchObject({ segments: 2, remaining: 0 })
    expect(describeSms('a'.repeat(307))).toMatchObject({ segments: 3 })
  })

  it('counts GSM extension characters as two septets', () => {
    expect(describeSms('€'.repeat(80))).toMatchObject({ encoding: 'GSM-7', units: 160, segments: 1 })
    expect(describeSms('€'.repeat(81))).toMatchObject({ units: 162, segments: 2 })
  })

  it('never splits an extension character across segments', () => {
    // 152 septets then one euro (2 septets) does not fit the remaining 1, so it starts segment 2.
    const text = 'a'.repeat(152) + '€' + 'a'.repeat(10)
    const info = describeSms(text)
    expect(info.units).toBe(164)
    expect(info.segments).toBe(2)
  })

  it('counts UCS-2 at 70 and 67 per segment, surrogate pairs as two units', () => {
    expect(describeSms('Н'.repeat(70))).toMatchObject({ encoding: 'UCS-2', segments: 1 })
    expect(describeSms('Н'.repeat(71))).toMatchObject({ encoding: 'UCS-2', segments: 2, perSegment: 67 })
    expect(describeSms('Н'.repeat(134))).toMatchObject({ segments: 2 })
    expect(describeSms('Н'.repeat(135))).toMatchObject({ segments: 3 })
    expect(describeSms(cp(0x1f697).repeat(35))).toMatchObject({ encoding: 'UCS-2', units: 70, segments: 1 })
    expect(describeSms(cp(0x1f697).repeat(36))).toMatchObject({ units: 72, segments: 2 })
  })

  it('reports zero segments for an empty body', () => {
    expect(describeSms('').segments).toBe(0)
  })
})

describe('prepareSmsBody', () => {
  it('flags whether normalisation changed the text', () => {
    expect(prepareSmsBody('Plain text.').changed).toBe(false)
    const p = prepareSmsBody('Your vehicle’s ready — come in ⭐')
    expect(p.changed).toBe(true)
    expect(p.body).toBe("Your vehicle's ready - come in")
    expect(p.encoding).toBe('GSM-7')
  })

  it('every design template body is GSM-7 after normalisation, so none is accidentally multipart UCS-2', () => {
    for (const tpl of Object.values(TEMPLATES)) {
      const info = prepareSmsBody(tpl.body.replace(/\{#?\/?[a-z_]+\}/g, 'x'))
      expect(info.encoding, tpl.key).toBe('GSM-7')
    }
  })

  it('segmentStorage gives the two columns kept per message', () => {
    expect(segmentStorage('a'.repeat(200))).toEqual({ encoding: 'GSM-7', segments: 2 })
  })
})
