import { describe, expect, it } from 'vitest'
import { AppError } from '../../src/platform/errors.js'
import {
  defaultSetting,
  isSettingKey,
  parseSetting,
  requireSettingKey,
  settingDefs,
  settingKeys,
} from '../../src/platform/settings.js'

describe('settings registry', () => {
  it('has the design defaults', () => {
    expect(defaultSetting('tax.rate_bp')).toBe(700)
    expect(defaultSetting('currency')).toBe('USD')
    expect(defaultSetting('ops.late_grace_min')).toBe(10)
    expect(defaultSetting('ops.eta_visible_max_min')).toBe(30)
    expect(defaultSetting('memberships.auto_apply')).toBe(false)
    expect(defaultSetting('approvals.allow_self')).toBe(false)
    expect(defaultSetting('reminders.offsets_min')).toEqual([1440, 120])
    expect(defaultSetting('reviews.enabled')).toBe(false)
    expect(defaultSetting('federal_holidays.auto')).toBe(true)
    expect(defaultSetting('credit.default_expiry')).toBe('90d')
    expect(defaultSetting('sms.quiet_hours')).toEqual({ enabled: false, start: '21:00', end: '08:00' })
    expect(typeof defaultSetting('tax.label')).toBe('string')
  })

  it('every default passes its own schema and defaults are not shared references', () => {
    for (const key of settingKeys) expect(() => parseSetting(key, settingDefs[key].default)).not.toThrow()
    const a = defaultSetting('reminders.offsets_min')
    a.push(5)
    expect(defaultSetting('reminders.offsets_min')).toEqual([1440, 120])
  })

  it('validates values and reports a field error', () => {
    expect(() => parseSetting('tax.rate_bp', 10_001)).toThrow(AppError)
    expect(() => parseSetting('tax.rate_bp', 7.5)).toThrow(AppError)
    expect(() => parseSetting('sms.quiet_hours', { enabled: true, start: '9pm', end: '08:00' })).toThrow(
      AppError,
    )
    try {
      parseSetting('ops.late_grace_min', -1)
    } catch (e) {
      expect((e as AppError).code).toBe('VALIDATION_FAILED')
      expect((e as AppError).errors?.[0]?.path).toBe('value')
    }
  })

  it('knows its keys', () => {
    expect(isSettingKey('tax.rate_bp')).toBe(true)
    expect(isSettingKey('constructor')).toBe(false)
    expect(() => requireSettingKey('nope')).toThrow(AppError)
  })
})
