// HTTP-level harness for the payments tests: the real app with the session authorizer, role-bearing users (the design's
// Rafael, Sofia, Amara, Daniel, Kevin) and an invoice factory.
import type { LightMyRequestResponse } from 'fastify'
import { beforeEach } from 'vitest'
import { devOutbox } from '../../src/modules/payments/ports.js'
import { useHarness, type Harness, type Session, type TestUser } from '../auth/harness.js'
import { setupEnv, type Env } from '../payments/helpers.js'

export interface Person {
  user: TestUser
  session: Session
}

export interface PayHarness {
  h: Harness
  env: () => Env
  people: () => {
    rafael: Person
    sofia: Person
    amara: Person
    daniel: Person
    kevin: Person
  }
  /** POST/PUT with a fresh Idempotency-Key unless one is given. */
  send(
    p: Person,
    method: 'POST' | 'PUT',
    url: string,
    body?: unknown,
    key?: string,
  ): Promise<LightMyRequestResponse>
  get(p: Person, url: string): Promise<LightMyRequestResponse>
  json<T = Record<string, unknown>>(r: LightMyRequestResponse): T
}

let keyN = 0
export const freshKey = (): string =>
  `test-key-${Date.now().toString(36)}-${++keyN}-${Math.random().toString(36).slice(2, 8)}`

export function usePayHarness(appEnv: Record<string, string> = {}): PayHarness {
  const h = useHarness({ env: appEnv })
  let env: Env
  let ppl: ReturnType<PayHarness['people']>
  let ipN = 0
  const nextIp = (): string => `10.77.${Math.floor(ipN / 250)}.${(ipN++ % 250) + 1}`

  beforeEach(async () => {
    devOutbox.clear()
    env = await setupEnv({ db: h.t.db, clock: h.t.clock })
    const mk = async (email: string, first: string, last: string, roles: string[]): Promise<Person> => {
      const user = await h.createUser({ email, first, last, roles })
      return { user, session: await h.login(user, nextIp()) }
    }
    ppl = {
      rafael: await mk('rafael@example.test', 'Rafael', 'Mendes', ['mgmt', 'acct']),
      sofia: await mk('sofia@example.test', 'Sofia', 'Duarte', ['support', 'crew']),
      amara: await mk('amara@example.test', 'Amara', 'Okoye', ['super']),
      daniel: await mk('daniel@example.test', 'Daniel', 'Price', ['acct']),
      kevin: await mk('kevin@example.test', 'Kevin', 'Tran', ['crew']),
    }
  })

  return {
    h,
    env: () => env,
    people: () => ppl,
    send: (p, method, url, body, key) =>
      h.call(method, url, {
        session: p.session,
        body: body ?? {},
        headers: { 'idempotency-key': key ?? freshKey() },
        ip: nextIp(),
      }),
    get: (p, url) => h.call('GET', url, { session: p.session, ip: nextIp() }),
    json: <T>(r: LightMyRequestResponse) => r.json() as T,
  }
}
