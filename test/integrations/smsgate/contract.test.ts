import { describeSmsProviderContract } from './contract.js'
import { fixtureHarness, httpSimHarness, inProcessHarness } from './harnesses.js'

// The same suite against: the in-process simulator, the HTTP simulator driven through SmsGateProvider, and recorded
// fixtures replayed through SmsGateProvider. Swap the fixture harness for real captures once the tablet exists.
describeSmsProviderContract('in-process simulator', inProcessHarness)
describeSmsProviderContract('SMS Gate adapter against the HTTP simulator', httpSimHarness)
describeSmsProviderContract('SMS Gate adapter against recorded fixtures', fixtureHarness)
