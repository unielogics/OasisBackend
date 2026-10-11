// Leads and their one automatic follow-up (ADR 0160, design section 1 "Leads", plan J): STUB of the W3 contract. W3b replaces it.
// Until then: no job; noteInterest and markBooked do nothing and open throws (nothing calls it before W3b; no lead row is written).
import type { CreateLeadJobs, CreateLeads } from '../assistant/contract.js'

export const createLeads: CreateLeads = (_deps) => ({
  open: async () => {
    throw new Error('leads: not built (W3b)')
  },
  noteInterest: async () => undefined,
  markBooked: async () => undefined,
})

export const createLeadJobs: CreateLeadJobs = (_deps) => []
