// The welcome flow's first step (ADR 0160, owner 2026-10-11; the W2d NewTexters port): STUB of the W3 contract. W3b replaces it
// (provisional client + lead in the webhook's transaction). Until then it is the W2d "off" default: no client is created.
import { noNewTexters } from '../ports.js'
import type { CreateNewTexters } from '../contract.js'

export const createNewTexters: CreateNewTexters = (_deps) => noNewTexters
