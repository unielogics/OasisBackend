// The kiosk's built-in permission set (ADR 0180): exactly the plan's list, all real keys, and nothing that moves money back, raises
// limits, reads reports or needs a Super Admin.
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ROLES,
  KIOSK_PERMISSIONS,
  LIMITED_PERMISSION,
  PERMISSION_KEY_SET,
  SUPER_ONLY_PERMISSIONS,
} from '../../src/modules/rbac/catalog.js'
import { defaultSetting } from '../../src/platform/settings.js'

describe('KIOSK_PERMISSIONS', () => {
  it('is exactly the plan list', () => {
    expect([...KIOSK_PERMISSIONS].sort()).toEqual(
      ['cli.contact', 'cli.view', 'jobs.checklist', 'jobs.status', 'msg.send', 'pay.collect', 'sched.edit', 'sched.view'].sort(),
    )
    for (const p of KIOSK_PERMISSIONS) expect(PERMISSION_KEY_SET.has(p), p).toBe(true)
  })

  it('is disjoint from the Super Admin-only, the money-limited and the report permissions', () => {
    for (const p of KIOSK_PERMISSIONS) {
      expect(SUPER_ONLY_PERMISSIONS.has(p), p).toBe(false)
      expect(LIMITED_PERMISSION[p], p).toBeUndefined()
      expect(p).not.toBe('pay.reports')
    }
  })

  it('never includes cancel, overrides, memberships, exports, settings, team or automations', () => {
    for (const p of KIOSK_PERMISSIONS) expect(p).not.toMatch(/^(set|team)\./)
    for (const p of ['sched.cancel', 'sched.override', 'cli.edit', 'cli.export', 'cli.member', 'pay.void', 'msg.auto', 'msg.broadcast'])
      expect(KIOSK_PERMISSIONS.has(p), p).toBe(false)
  })

  it('is not a role, and kiosk mode is on by default (ADR 0180 amendment: the keypad is the sign-in page)', () => {
    expect(DEFAULT_ROLES.map((r) => r.name)).not.toContain('Kiosk')
    expect(defaultSetting('kiosk.enabled')).toBe(true)
  })
})
