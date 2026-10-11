// Leads and their one automatic follow-up (ADR 0160, design section 1 "Leads", plan J; wave W3b). A lead per number (source text,
// website or walk-in), the categories they asked about, status new | followed_up | booked | closed, the booking that closed it, and
// ONE automatic follow-up text (follow-up.ts, job leads.follow_up). Staff read them at GET /api/v1/leads (cli.view; http/routes.ts).
import type { CreateLeads, Leads } from '../assistant/contract.js'
import { markLeadBooked, noteLeadInterest, openLead } from './service.js'

export * from './service.js'
export * from './follow-up.js'
export { createLeadJobs, leadJobs, LEAD_FOLLOW_UP_JOB, PROVISIONAL_ARCHIVE_JOB } from './jobs.js'

export const createLeads: CreateLeads = (deps): Leads => ({
  open: (tx, o) => openLead(tx, deps.newId, o),
  async noteInterest(tx, o) {
    await noteLeadInterest(tx, o)
  },
  async markBooked(tx, o) {
    await markLeadBooked(tx, o)
  },
})
