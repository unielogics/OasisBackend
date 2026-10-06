import { describe, expect, it } from 'vitest'
import { runSeed } from '../../db/seeds/index.js'
import { useTestDb } from '../helpers/db.js'

const t = useTestDb()

describe('parity-ops seed', () => {
  it('seeds twice without change', async () => {
    const t0 = Date.now()
    await runSeed({ db: t.db, clock: t.clock, profile: 'parity-ops' })
    const n1 = await t.db.selectFrom('appointments').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()
    console.log('first run ms', Date.now() - t0, n1)
    await runSeed({ db: t.db, clock: t.clock, profile: 'parity-ops' })
    const n2 = await t.db.selectFrom('appointments').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()
    expect(n2.n).toEqual(n1.n)
  })
})
