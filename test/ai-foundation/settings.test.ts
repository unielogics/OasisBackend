// The settings keys of the AI assistant, reminders, status texts, leads, catalog and links (ADR 0160, design section 1 "Settings
// keys"): their defaults and their validation. reminders.offsets_min keeps its shape and default.
import { describe, expect, it } from 'vitest'
import { AppError } from '../../src/platform/errors.js'
import { defaultSetting, isSettingKey, parseSetting, settingKeys, type SettingKey } from '../../src/platform/settings.js'

const bad = (key: SettingKey, value: unknown): void => {
  expect(() => parseSetting(key, value), `${key} ${JSON.stringify(value)}`).toThrow(AppError)
}

describe('AI foundation settings', () => {
  it('has every key with the design defaults', () => {
    const expected: Record<string, unknown> = {
      'assistant.enabled': false,
      'assistant.stage': 'allowlist',
      'assistant.allowlist': [],
      'assistant.staff_pause_hours': 12,
      'assistant.faq': [],
      'assistant.actions_enabled': false,
      // the welcome flow's hourly ceiling of new provisional clients (W4c fixes P6)
      'assistant.new_texters_per_hour': 30,
      'reminders.offsets_min': [1440, 120],
      'reminders.confirm_request': true,
      'reminders.category_prep': {},
      // the new status texts stay off until the owner turns them on (wave W3d); ready-for-pickup was sent before and stays on
      'status_texts.checked_in': false,
      'status_texts.checked_in_delay_min': 3,
      'status_texts.running_late': false,
      'status_texts.late_grace_min': 10,
      'status_texts.late_max': 2,
      'status_texts.ready': true,
      'status_texts.picked_up': false,
      'status_texts.book_again_link': false,
      'leads.follow_up_enabled': true,
      'leads.follow_up_delay_min': 180,
      'leads.business_hours_only': true,
      'leads.within_hours': 24,
      'catalog.guest_markup_pct': 20,
      'catalog.tint_matrix': { vehicleTypes: [], films: [], prices: [] },
      'links.epoch': 1,
    }
    for (const [key, value] of Object.entries(expected)) {
      expect(isSettingKey(key), key).toBe(true)
      expect(defaultSetting(key as SettingKey), key).toEqual(value)
    }
    expect(settingKeys).toEqual(expect.arrayContaining(Object.keys(expected)))
  })

  it('validates the assistant keys', () => {
    expect(parseSetting('assistant.allowlist', ['+12015550142'])).toEqual(['+12015550142'])
    bad('assistant.allowlist', ['2015550142'])
    bad('assistant.stage', 'staff')
    bad('assistant.new_texters_per_hour', 0)
    bad('assistant.new_texters_per_hour', 1001)
    bad('assistant.staff_pause_hours', 0)
    bad('assistant.staff_pause_hours', 73)
    expect(parseSetting('assistant.faq', [{ q: 'Do you take cards?', a: 'Yes, every major card.' }])).toHaveLength(1)
    bad('assistant.faq', [{ q: '', a: 'x' }])
    bad('assistant.faq', [{ q: 'x', a: 'y'.repeat(501) }])
    bad('assistant.faq', Array.from({ length: 41 }, () => ({ q: 'q', a: 'a' })))
    bad('assistant.faq', [{ q: 'x', a: 'y', extra: true }])
  })

  it('keeps reminders.offsets_min as it was and validates the new reminder keys', () => {
    expect(parseSetting('reminders.offsets_min', [2880, 60])).toEqual([2880, 60])
    bad('reminders.offsets_min', [0])
    expect(parseSetting('reminders.category_prep', { tint: 'Plan for 2–3 hours.' })).toEqual({ tint: 'Plan for 2–3 hours.' })
    bad('reminders.category_prep', { Tint: 'x' })
    bad('reminders.category_prep', { tint: 'x'.repeat(161) })
  })

  it('bounds the status-text and lead thresholds', () => {
    bad('status_texts.checked_in_delay_min', -1)
    bad('status_texts.checked_in_delay_min', 31)
    bad('status_texts.late_max', 3)
    bad('status_texts.late_grace_min', 121)
    bad('leads.follow_up_delay_min', 10)
    bad('leads.within_hours', 0)
    // the lead follow-up's reply window (lead_follow_up class) is 24 hours: a longer setting could never be honoured
    bad('leads.within_hours', 25)
    bad('catalog.guest_markup_pct', -1)
    bad('catalog.guest_markup_pct', 201)
    bad('links.epoch', 0)
  })

  it('validates the tint matrix: known vehicle types and films, ranges in order, one price per pair', () => {
    const ok = {
      vehicleTypes: [
        { key: 'sedan', label: 'Sedan' },
        { key: 'suv', label: 'SUV' },
      ],
      films: [{ key: 'ceramic', label: 'Ceramic', vlt: [5, 20, 35] }],
      prices: [
        { vehicle: 'sedan', film: 'ceramic', memberMinCents: 29900, memberMaxCents: 39900, guestMinCents: 35900, guestMaxCents: 47900 },
        { vehicle: 'suv', film: 'ceramic', memberMinCents: 34900, memberMaxCents: 44900, guestMinCents: 41900, guestMaxCents: 53900 },
      ],
    }
    expect(parseSetting('catalog.tint_matrix', ok)).toEqual(ok)
    bad('catalog.tint_matrix', { ...ok, prices: [{ ...ok.prices[0], vehicle: 'truck' }] })
    bad('catalog.tint_matrix', { ...ok, prices: [{ ...ok.prices[0], memberMinCents: 50000 }] })
    bad('catalog.tint_matrix', { ...ok, prices: [ok.prices[0], ok.prices[0]] })
    bad('catalog.tint_matrix', { ...ok, films: [{ key: 'ceramic', label: 'Ceramic', vlt: [120] }] })
    bad('catalog.tint_matrix', { ...ok, vehicleTypes: [...ok.vehicleTypes, { key: 'sedan', label: 'Again' }] })
  })
})
