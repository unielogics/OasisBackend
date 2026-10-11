// The reply-number handler (ADR 0160, design sections 0 and 3; the W2d ActionCodeHandler port): STUB of the W3 contract. W3b
// replaces it (confirm, execute, answer). Until then it is the W2d "off" default: no action is ever pending here. Wiring note: the
// messaging runtime's own default still looks pending actions up (so a reply number is never filed readable); W3a passes this
// handler to useAssistant only once W3b's real one is in.
import { noActionCodes } from '../ports.js'
import type { CreateActionCodeHandler } from '../contract.js'

export const createActionCodeHandler: CreateActionCodeHandler = (_deps) => noActionCodes
