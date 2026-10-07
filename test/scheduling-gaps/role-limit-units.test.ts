// Gap 5: the unit of a role money limit cannot drift. The request of PUT /roles/:id/limits/:kind is DOLLARS from the design's
// chip list (25, 50, 100, 250, 500, 1000, or null for No limit); everything the API returns (GET /roles limits and
// limitChoicesCents, GET /me, the PUT response limitCents) is CENTS. This file pins the behaviour, the generated OpenAPI
// descriptions and the hand-written API spec to that rule, so editing one without the others fails.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { LIMIT_CHOICES_CENTS, LIMIT_CHOICES_DOLLARS } from '../../src/modules/rbac/catalog.js'
import { useHarness } from '../auth/harness.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>
const root = path.resolve(import.meta.dirname, '../..')
const openapi = JSON.parse(readFileSync(path.join(root, 'docs/openapi.json'), 'utf8')) as Json
const apiSpec = readFileSync(path.join(root, 'docs/api-spec.md'), 'utf8')

describe('role limit units: behaviour', () => {
  const h = useHarness()

  it('the chip list is dollars, the stored and returned values are cents, and a cents value is refused', async () => {
    const user = await h.createUser({ email: 'amara@example.test', roles: ['super'] })
    const session = await h.login(user, '10.9.0.1')
    const role = (await h.call('POST', 'roles', { session, body: { name: 'Desk' } })).json() as Json
    const put = (value: unknown) =>
      h.call('PUT', `roles/${role.id}/limits/refund`, { session, body: { value } })

    for (const dollars of LIMIT_CHOICES_DOLLARS) {
      const r = await put(dollars)
      expect(r.statusCode).toBe(200)
      expect(r.json()).toEqual({
        roleId: role.id,
        kind: 'refund',
        limitCents: dollars === null ? null : dollars * 100,
      })
    }
    // the same number in cents is not a choice: 2500 would be $2,500, which is not on the list
    for (const wrong of [2500, 5000, 100_000, 0, 24.99]) {
      const r = await put(wrong)
      expect(r.statusCode, `value ${String(wrong)}`).toBe(422)
      expect(r.json().errors[0].message).toBe('Choose 25, 50, 100, 250, 500, 1000 or No limit')
    }
    expect((await put('25')).statusCode).toBe(422) // a string is not a number of dollars either

    const overview = h.json<Json>(await h.call('GET', 'roles', { session }))
    expect(overview.limitChoicesCents).toEqual([...LIMIT_CHOICES_CENTS])
    expect(overview.limitChoicesCents).toEqual(
      LIMIT_CHOICES_DOLLARS.map((d) => (d === null ? null : d * 100)),
    )
    expect(overview.limits[role.id].refund).toBeNull() // the last accepted value was No limit
  })
})

describe('role limit units: published contract', () => {
  const op = openapi.paths['/api/v1/roles/{id}/limits/{kind}'].put as Json
  const body = op.requestBody.content['application/json'].schema as Json
  const reply = op.responses['200'].content['application/json'].schema as Json

  it('OpenAPI names dollars on the request value and cents on every returned limit', () => {
    expect(op.summary).toMatch(/dollars/i)
    expect(op.summary).toMatch(/stored in cents/i)
    const value = body.properties.value as Json
    expect(`${value.description ?? ''}`).toMatch(/\bdollars\b/i)
    expect(`${value.description ?? ''}`).not.toMatch(/\bcents\b.*\bdollars\b|accepted in cents/i)
    expect(reply.properties.limitCents).toBeDefined()
    expect(`${reply.properties.limitCents.description ?? ''}`).toMatch(/\bcents\b/i)
    const roles = openapi.paths['/api/v1/roles'].get.responses['200'].content['application/json'].schema
    expect(roles.properties.limitChoicesCents).toBeDefined()
    expect(`${roles.properties.limitChoicesCents.description ?? ''}`).toMatch(/\bcents\b.*\bdollars\b/i)
    expect(`${roles.properties.limits.description ?? ''}`).toMatch(/\bcents\b/i)
  })

  it('the API spec says the same in its identity section', () => {
    const row = apiSpec.split('\n').find((l) => l.startsWith('| `PUT /roles/:id/limits/:kind`'))
    expect(row, 'the section 14 row for PUT /roles/:id/limits/:kind').toBeDefined()
    expect(row).toMatch(/dollars/i)
    expect(row).toMatch(/limitCents/)
    expect(row).toMatch(/cents/i)
    expect(row).toMatch(/not cents|never cents|dollars, not cents/i)
    // the unit rule is also stated once, in prose, for every limit-bearing response
    expect(apiSpec).toMatch(/Role money limits: the request is dollars/i)
  })
})
