// A kiosk ready to act, for the attribution and report tests: a Super Admin signed in, the shop code set, this "tablet" registered,
// kiosk mode on, the kiosk unlocked, and Marco (crew) to tap. Each world signs in and unlocks from its own address, so the per-address
// limits of sign-in and unlock (a frozen clock never lets their minute pass) never mix the tests of a file.
import type { Harness, KioskDevice, KioskSession, Session, TestUser } from '../auth/harness.js'

export interface KioskWorld {
  admin: Session
  kiosk: KioskSession
  device: KioskDevice
  marco: TestUser
}

let n = 0

export async function kioskWorld(h: Harness): Promise<KioskWorld> {
  n++
  const net = `10.${90 + (Math.floor(n / 250) % 100)}.${n % 250}`
  const adminUser = await h.createUser({ email: `kiosk-admin-${n}@example.test`, roles: ['super'], first: 'Rafael', last: 'Mendes' })
  const admin = await h.login(adminUser, `${net}.1`)
  await h.setCode(admin)
  const device = await h.registerDevice(admin)
  await h.setKioskMode(admin, true)
  const kiosk = await h.unlock(device, undefined, `${net}.2`)
  const marco = await h.createUser({ email: `marco-${n}@example.test`, first: 'Marco', last: 'Rossi', roles: ['crew'] })
  return { admin, kiosk, device, marco }
}
