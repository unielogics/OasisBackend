import { describe, expect, it } from 'vitest'
import { createSmsProvider } from '../../../src/integrations/sms/factory.js'
import { SimulatorProvider } from '../../../src/integrations/sms/simulator.js'
import { SmsGateProvider } from '../../../src/integrations/smsgate/provider.js'

describe('createSmsProvider', () => {
  it('defaults to the simulator with no other configuration', () => {
    expect(createSmsProvider({})).toBeInstanceOf(SimulatorProvider)
    expect(createSmsProvider({ SMS_PROVIDER: 'sim' })).toBeInstanceOf(SimulatorProvider)
  })

  it('builds the real adapter when configured and refuses to guess when it is not', () => {
    const env = { SMS_PROVIDER: 'smsgate', SMSGATE_DEVICE_URL: 'http://100.64.0.7:8080', SMSGATE_USERNAME: 'u', SMSGATE_PASSWORD: 'p', SMSGATE_WEBHOOK_SECRET: 's' }
    expect(createSmsProvider(env)).toBeInstanceOf(SmsGateProvider)
    expect(() => createSmsProvider({ SMS_PROVIDER: 'smsgate' })).toThrow()
    expect(() => createSmsProvider({ SMS_PROVIDER: 'twilio' })).toThrow(/Unknown SMS_PROVIDER/)
  })

  it('the simulator it returns sends and auto-delivers', async () => {
    const p = createSmsProvider({}) as SimulatorProvider
    await p.send({ id: 'a', to: '+17865550151', body: 'hi' })
    expect(await p.status('a')).toEqual({ state: 'Delivered' })
  })
})
