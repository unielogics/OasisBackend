// Adversarial review (rv/sec): GET /customers refuses to match a phone number for someone without cli.contact "so a number
// typed into the box never reveals who owns it". POST /customers (find or create by phone) is the same lookup by another door.
import { describe, expect, it } from 'vitest'
import { runSeed } from '../../db/seeds/index.js'
import { useHarness } from '../auth/harness.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>

describe('SEC-10 phone-to-name lookup without cli.contact', () => {
  const h = useHarness()

  // OPEN FINDING, not fixed on this branch: the booking panel needs the customer record back from a phone it typed, so closing
  // the door means a product decision (mask the name for callers without cli.contact, or give them no phone lookup at all).
  // `it.fails` keeps the suite green while the hole exists and turns red the day it is closed, which is the cue to make it `it`.
  it.fails('does not tell a person without cli.contact who owns a number', async () => {
    await runSeed({ db: h.t.db, clock: h.clock, profile: 'parity-ops' })
    const target = await h.t.db
      .selectFrom('customers')
      .select(['full_name', 'phone_display'])
      .where('phone_display', 'is not', null)
      .executeTakeFirstOrThrow()
    // the default "Shift Lead" custom role: Crew plus sched.edit, no cli.contact
    const { session } = await h.userWithPermissions(
      ['sched.view', 'sched.edit', 'cli.view'],
      'lead@example.test',
    )

    const search = await h.call('GET', `customers?q=${encodeURIComponent(target.phone_display!)}`, {
      session,
    })
    expect((search.json() as Json).items).toEqual([]) // the guard the search route documents

    const probe = await h.call('POST', 'customers', { session, body: { phone: target.phone_display } })
    const body = probe.json() as Json
    expect({ created: body.created, nameShown: body.customer?.fullName === target.full_name }).toEqual({
      created: false,
      nameShown: false,
    })
  })
})
