// The W3 contract (ADR 0160, "W3 contract"): the stubs keep everything off, and the contract's types accept a tool written the way
// W3b will write them (a strict zod v4 object, the input type of ToolInputs, the registry's element type).
import { describe, expect, expectTypeOf, it } from 'vitest'
import { z } from 'zod/v4'
import { ASSISTANT_OFF, noActionCodes, noNewTexters } from '../../src/modules/assistant/ports.js'
import {
  TOOL_MIN_TRUST,
  type AnyAssistantTool,
  type AssistantDeps,
  type AssistantTool,
  type AssistantToolName,
  type ToolInputs,
  type ToolOutcome,
} from '../../src/modules/assistant/contract.js'
import { createToolRegistry } from '../../src/modules/assistant/tools/index.js'
import { createActionCodeHandler } from '../../src/modules/assistant/actions/handler.js'
import { createNewTexters } from '../../src/modules/assistant/welcome/new-texters.js'
import { buildShopFacts, renderShopFacts } from '../../src/modules/assistant/facts.js'
import { createLeadJobs, createLeads } from '../../src/modules/leads/index.js'

const deps = {} as AssistantDeps

describe('W3 contract: the W3b parts are built, the W3a stubs stay', () => {
  it('offers every tool of the contract with its minimum trust; the W3b factories are no longer the W2d "off" defaults', () => {
    const registry = createToolRegistry(deps)
    expect(registry.tools.map((t) => t.name).sort()).toEqual(Object.keys(TOOL_MIN_TRUST).sort())
    for (const t of registry.tools) expect(t.minTrust, t.name).toBe(TOOL_MIN_TRUST[t.name])
    expect(registry.get('list_services')?.name).toBe('list_services')
    expect(registry.get('nope')).toBeUndefined()
    expect(createActionCodeHandler(deps)).not.toBe(noActionCodes)
    expect(createNewTexters(deps)).not.toBe(noNewTexters)
    expect(ASSISTANT_OFF.actionCodes).toBe(noActionCodes)
    expect(createLeadJobs(deps).map((j) => j.name)).toEqual(['leads.follow_up', 'leads.provisional_archive'])
  })

  it('leaves the shop facts to W3a', () => {
    expect(() => buildShopFacts({} as Parameters<typeof buildShopFacts>[0])).toThrow('not built')
    expect(() => renderShopFacts({} as Parameters<typeof renderShopFacts>[0])).toThrow('not built')
    expect(typeof createLeads(deps).noteInterest).toBe('function')
  })

  it('names a minimum trust for every tool', () => {
    expect(Object.keys(TOOL_MIN_TRUST).sort()).toEqual(
      [
        'check_availability',
        'get_balance',
        'get_business_info',
        'get_membership_info',
        'handoff_to_staff',
        'list_my_appointments',
        'list_services',
        'note_interest',
        'opt_out',
        'propose_booking',
        'propose_cancel',
        'propose_reschedule',
        'send_link',
        'set_my_name',
        'set_my_vehicle',
      ].sort(),
    )
    expect(TOOL_MIN_TRUST.propose_booking).toBe('trusted')
    expect(TOOL_MIN_TRUST.list_my_appointments).toBe('caller')
    expect(TOOL_MIN_TRUST.get_business_info).toBe('unknown')
  })

  it('types a tool the way W3b writes it', async () => {
    const listServices: AssistantTool<ToolInputs['list_services']> = {
      name: 'list_services',
      description: 'The services with their starting prices.',
      input: z.strictObject({ category: z.string().nullable() }),
      minTrust: TOOL_MIN_TRUST.list_services,
      run: async (ctx, input): Promise<ToolOutcome> => ({ ok: true, data: { category: input.category, items: ctx.facts.catalog.items.length } }),
    }
    const membership: AssistantTool<ToolInputs['get_membership_info']> = {
      name: 'get_membership_info',
      description: 'The membership plans.',
      input: z.strictObject({}),
      minTrust: 'unknown',
      run: async () => ({ ok: false, error: 'unavailable', message: 'Not now.' }),
    }
    const all: AnyAssistantTool[] = [listServices, membership]
    expect(all.map((t) => t.name)).toEqual(['list_services', 'get_membership_info'])
    expect(listServices.input.parse({ category: null })).toEqual({ category: null })
    expect(() => listServices.input.parse({ category: null, phone: '+12015550142' })).toThrow()
    expectTypeOf<keyof ToolInputs>().toEqualTypeOf<AssistantToolName>()
  })
})
