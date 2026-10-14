// A kiosk ready to act, for the attribution and report tests: a Super Admin signed in at the shop, that address added as the shop's
// network, a PIN set for the Super Admin, the "tablet" (a fresh browser) unlocked there with it, and Marco (crew) to tap. Each world is
// its own shop address, so the per-address limits of sign-in and unlock (a frozen clock never lets their minute pass) never mix the
// tests of a file. Kiosk mode is on by default (ADR 0180 amendment).
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
  const shop = `10.${90 + (Math.floor(n / 250) % 100)}.${n % 250}.1`
  const adminUser = await h.createUser({ email: `kiosk-admin-${n}@example.test`, roles: ['super'], first: 'Rafael', last: 'Mendes' })
  const admin = await h.login(adminUser, shop)
  await h.addShopNetwork(admin, shop)
  const pin = await h.setPin(admin, adminUser.employeeId)
  const kiosk = await h.unlock(null, pin, shop)
  const marco = await h.createUser({ email: `marco-${n}@example.test`, first: 'Marco', last: 'Rossi', roles: ['crew'] })
  return { admin, kiosk, device: kiosk.device, marco }
}
