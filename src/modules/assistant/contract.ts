// The W3 contract (ADR 0160, "W3 contract"): the seam between the assistant's turn (W3a: src/modules/assistant/** core: the gate
// again, caps, claim, context, the Converse loop, the output guard, the reply, the jobs, the shop facts) and what the model can DO
// (W3b: the tools, the reply-number handler, the welcome flow, the leads). Both packages build against these types in parallel;
// nothing here has logic.
//
//   W3a implements   buildShopFacts / renderShopFacts (facts.ts), the ToolContext it hands every tool, the turn, the kick, the
//                    `ai.respond` / `ai.sweep` jobs, and the wiring (MessagingRuntime.useAssistant + the job registry)
//   W3b implements   createToolRegistry (tools/index.ts), createActionCodeHandler (actions/handler.ts), createNewTexters
//                    (welcome/new-texters.ts), createLeadJobs and createLeads (src/modules/leads/index.ts)
//
// Rules both sides rely on (design sections 0, 3, 3b, 4; owner decisions binding):
//   - The model never sees a phone number, an id (uuid), a token, a URL, a reply number or a PIN/code. Tools bind the client from
//     ctx.identity (server side); their inputs never name a client, a phone or an id. Appointments are refs A1..A3 (ctx.refs), links
//     are placeholders "{link1}" (ctx.addLink).
//   - Pricing is not the AI's task, and the model never writes an amount (output guard v4, design section 3c): a tool hands it no
//     dollar figure, only the placeholder of each priced thing ({price:<key>}, {price:<key>:<size>}, {plan:<key>},
//     {plan:<key>:<size>}, {perks:<key>}, {fee}, {balance}, and {price:tint:<size>:<film>} for one more release; facts-v4, the keys
//     facts.ts placeholderValues renders), and the server renders STARTING prices, plan prices, the fee and the
//     balance from the current facts after the guard, never a total, a combination or a discount. {balance} renders get_balance's
//     data.openBalanceCents when present, else its first amountsCents (the total), only in a turn where get_balance succeeded.
//   - Everything stays off by default: with AI_ENABLED=false, assistant.enabled=false, AI_ACTIONS_ENABLED=false or
//     assistant.actions_enabled=false, no tool runs an action, no reply number executes, no client is adopted and no lead job
//     sends anything.
import type { z } from 'zod/v4'
import type { Env } from '../../config/env.js'
import type { AiJsonObject } from '../../integrations/ports/ai.js'
import type { Clock } from '../../platform/clock.js'
import type { Db, Tx } from '../../platform/db.js'
import type { NewId } from '../../platform/ids.js'
import type { JobDefinition } from '../../platform/jobs.js'
import type { Logger } from '../../platform/logging.js'
import type { IdentityQueue } from '../identity/deps.js'
import type { ClientLinkKind, PendingActionKind } from '../identity/schema.js'
import type { JsonValue } from '../../platform/schema.js'
import type { PublicTier } from '../public/tiers.js'
import type { Actor, SchedulingCtx } from '../scheduling/context.js'
import type { ShopKnowledge } from './knowledge/render.js'
import type { ConvoLang } from './lang.js'
import type { ActionCodeHandler, NewTexters } from './ports.js'

// ---------------------------------------------------------------------------------------------------------------------------
// Who is texting (built by W3a at the turn's claim; read by every tool)
// ---------------------------------------------------------------------------------------------------------------------------

/**
 * What the turn knows about the texter, lowest first:
 *   unknown   no client behind the number, or the stale-record rule (identity/stale.ts: 180+ days without activity, or the last
 *             text to it bounced as an invalid number) says the record may belong to someone else: nothing of the record is shown
 *   caller    the number is the live client's number on file (the welcome flow's provisional client included): the client's own
 *             appointments, balance, name and vehicles may be read and their own name/vehicle written
 *   trusted   a live 30-day phone trust for that client (identity/trust.ts evaluateTrust): in-chat booking, reschedule and cancel,
 *             each still confirmed by a server reply number
 * Stored in assistant_turns.trust as 'unknown' | 'known' | 'trusted' ('caller' is the column's 'known').
 */
export type TurnTrust = 'unknown' | 'caller' | 'trusted'

export interface TurnIdentity {
  locationId: string
  /** The texter's number (E.164). Server side only: never in a prompt, a tool output, a transcript or a log line. */
  phone: string
  /** The client the number belongs to (the provisional one included), or null for a stranger the welcome flow did not adopt. */
  customerId: string | null
  /** The client is the welcome flow's provisional record (needs_details, name placeholder "New texter ••NNNN"). */
  provisional: boolean
  trust: TurnTrust
  /** When the phone trust ends (trust 'trusted' only), else null. */
  trustUntil: Date | null
}

// ---------------------------------------------------------------------------------------------------------------------------
// Shop facts (design §3b): every setting, assembled server side into one read-only document; W3a builds it (facts.ts)
// ---------------------------------------------------------------------------------------------------------------------------

/** A plain sentence for the model ("Members pay no booking fee."), written by facts.ts from the structured fields next to it. */
export type FactLine = string

export interface ShopFactsBusiness {
  /** "Oasis Auto Spa" (locations.name). */
  name: string
  /** The street address as one line (locations.address), or null when not set. */
  address: string | null
  /** BUSINESS_TZ (America/New_York): every date and time in the facts is in it. */
  timeZone: string
  /** The public website's origin (PUBLIC_SITE_URL, else https://oasisautospanj.com). Shown as text, never as a link placeholder. */
  website: string
}

export interface ShopFactsContact {
  /** The texting line (the front-desk tablet), display format "(862) 388-5827"; null when not configured. */
  textingNumber: string | null
  /** The number to CALL, when it differs from the texting line or the texting line takes no calls; null when there is none. */
  callingNumber: string | null
  /** The public email, or null. */
  email: string | null
  /** e.g. "This number is for texting; to talk to someone call (201) 555-0100." */
  lines: FactLine[]
}

/** One weekday of the regular week (settings/public-hours.ts PublicWeekDay without the minute fields). */
export interface ShopFactsWeekday {
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number
  /** "Monday". */
  day: string
  open: boolean
  /** "8:00 AM" / "6:00 PM"; null when closed. */
  from: string | null
  to: string | null
}

/** A planned or emergency closure in the next 30 days (settings/public-hours.ts PublicClosure). */
export interface ShopFactsClosure {
  /** YYYY-MM-DD (business time zone). */
  date: string
  /** "Monday, Sep 7". */
  dateLabel: string
  name: string
  type: 'closed' | 'reduced'
  /** The reduced window ("10:00 AM" / "2:00 PM"). */
  from?: string
  to?: string
  emergency: boolean
}

/**
 * The business day the facts were built for. Whether the shop is open NOW is not a fact (it changes by the minute): the turn
 * context carries the current time and the model compares.
 */
export interface ShopFactsToday {
  /** YYYY-MM-DD (business time zone): the facts are rebuilt when it changes. */
  date: string
  /** "Saturday". */
  day: string
  closed: boolean
  opensAt: string | null
  closesAt: string | null
  /** "Regular day off", the closure's name or the emergency closure's name; null on an ordinary open day. */
  reason: string | null
  reduced: boolean
  /** An emergency closure is active today. */
  emergency: boolean
}

/** Booking rules (settings/hours.ts BookingRules + settings/vip.ts VipSettings), in numbers and in words. */
export interface ShopFactsBookingRules {
  slotMinutes: number
  /** The earliest online start is now + this (minutes). */
  onlineLeadMinutes: number
  /** No start later than this many minutes before closing. */
  cutoffMinutes: number
  /** How far ahead a client may book: everyone else / VIP members (days). */
  windowStdDays: number
  windowVipDays: number
  /** VIP holds are released to everyone this many hours before the slot. */
  vipReleaseHours: number
  /** Same-day bookings a VIP member may make per month. */
  vipSameDayPerMonth: number
  lines: FactLine[]
}

/** The guest booking fee (setting booking.guest_fee). Members pay none. */
export interface ShopFactsFee {
  guestBookingFeeCents: number
  /** counter: paid at the shop; link: staff text a payment link after the booking. Nothing is charged online. */
  collect: 'counter' | 'link'
  lines: FactLine[]
}

/** The cancellation and no-show policy (setting cancellation.policy), in words; the AI never computes a refund. */
export interface ShopFactsCancellation {
  freeCancelHours: number
  lines: FactLine[]
}

export interface ShopFactsCategory {
  key: string
  label: string
}

/** A vehicle size of the shop (facts-v4, ADR 0170): what the assistant asks a new client and prices by. Active sizes, smallest first. */
export interface ShopFactsSize {
  /** The size key set_my_vehicle and propose_booking take (compact_car, large_suv, ...). */
  key: string
  /** "Compact car" (Settings → Vehicle sizes). */
  label: string
}

/** An item's regular price at one size (a size without a price is not listed: "priced at the shop"). */
export interface ShopFactsItemPrice {
  class: string
  classLabel: string
  cents: number
  /** The top of a range (tint), never stated. */
  maxCents: number | null
  /** The member price at the lowest % off of the tiers sold online (whole dollars, half up). */
  memberCents: number
}

/**
 * A package or add-on of the Settings catalog (one entry per public catalog key; quote-only items included without prices), built
 * from GET /public/catalog/v2 (facts-v4). The prices are by vehicle size; the assistant states them only through placeholders,
 * always as STARTING prices ("starts at").
 */
export interface ShopFactsItem {
  /** The public catalog key (the slug check_availability and propose_booking take as serviceKey / addonKeys). */
  key: string
  /** The public name. */
  name: string
  kind: 'package' | 'addon'
  /** A category key (ShopFactsCategory.key). */
  category: string
  description: string | null
  /** Minutes the visit takes (packages); null for add-ons and quote-only items. */
  durationMin: number | null
  /** The sizes that have a price, in size order (empty: priced by its base price alone, or quote-only). */
  prices: ShopFactsItemPrice[]
  /** The starting price (the lowest over the sizes, else the base price); null for a quote-only item. */
  fromCents: number | null
  /** The size of the starting price ("Compact car"); null without prices by size. */
  fromClassLabel: string | null
  /** The member starting price; null for a quote-only item. */
  memberFromCents: number | null
  /** The tiers sold online whose inclusions name this item. */
  includedIn: { tier: string; tierLabel: string; mode: 'per_cycle' | 'every_visit'; perCycle: number | null }[]
  /** Priced per vehicle by the team: the AI offers "text us a photo for a quote", never a price. */
  quoteOnly: boolean
  /** The tint film (catalog.tint_films key) of a tint package, or null; its sizes read as {price:tint:<size>:<film>} too. */
  tintFilm: string | null
}

export interface ShopFactsCatalog {
  categories: ShopFactsCategory[]
  /** The active vehicle sizes, smallest first. */
  sizes: ShopFactsSize[]
  /** Active items listed online, ordered by category sort then item sort. */
  items: ShopFactsItem[]
  /** The tint films by key (label, VLT shades), for the tint items. */
  tintFilms: { key: string; label: string; vlt: number[] }[]
  lines: FactLine[]
}

/** What a tier includes (an inclusion), by the names of the items it covers. */
export interface ShopFactsInclusion {
  /** The public names of the listed items it covers. */
  services: string[]
  mode: 'per_cycle' | 'every_visit'
  /** per_cycle: visits a month (null: unlimited); null for every_visit. */
  perCycle: number | null
}

/** A membership tier the shop sells online (active, public and with a current price: plan decision 3). */
export interface ShopFactsPlan {
  /** The tier key (gold, vip, ...). */
  key: PublicTier
  /** "Gold" / "VIP" (the tier's name). */
  label: string
  /** The monthly price at each size that has one, in size order. */
  prices: { class: string; classLabel: string; monthlyCents: number }[]
  /** The starting monthly price and its size. */
  fromCents: number
  fromClassLabel: string
  /** The % off every line the membership does not cover, in basis points. */
  memberDiscountBp: number
  /** Members get the VIP booking rules. */
  vipBooking: boolean
  inclusions: ShopFactsInclusion[]
  /** The perks text from Settings (as saved). */
  perks: string[]
}

/** The texts a client gets on their own (reminders, status texts), so the AI can say what to expect. */
export interface ShopFactsAutomaticTexts {
  /** Minutes before the visit a reminder goes (reminders.offsets_min). */
  reminderOffsetsMin: number[]
  /** Reminders ask the client to reply C to confirm (reminders.confirm_request). */
  confirmRequest: boolean
  /** Per category key: the preparation line appended to the reminder (reminders.category_prep). */
  categoryPrep: Record<string, string>
  statusTexts: { checkedIn: boolean; runningLate: boolean; ready: boolean; pickedUp: boolean }
  lines: FactLine[]
}

/**
 * The shop facts document (design §3b). Built server side from every setting by buildShopFacts (W3a, facts.ts), cached by
 * `version`, rendered by renderShopFacts into the cached system prefix, and handed to every tool (ToolContext.facts) so a tool's
 * prices and the output guard read the same numbers. Time-sensitive facts (availability, the client's own appointments, balance)
 * are NOT here: tools read them at the moment of the question.
 */
export interface ShopFacts {
  /**
   * The cache key: a hash of the source versions (every settings row's version, the catalog services/categories/plans versions,
   * the hours, closures and emergency state) and the business date. Same version = same document = same rendered bytes.
   */
  version: string
  /** When this document was built (ISO). Not rendered (it would break the prompt cache). */
  generatedAt: string
  business: ShopFactsBusiness
  contact: ShopFactsContact
  /** The regular week, Sunday first. */
  hours: ShopFactsWeekday[]
  /** Closures in the next 30 days, by date. */
  closures: ShopFactsClosure[]
  today: ShopFactsToday
  bookingRules: ShopFactsBookingRules
  fee: ShopFactsFee
  cancellation: ShopFactsCancellation
  /** VIP rules in plain words (priority window, holds, same-day allowance, what VIP includes). */
  vip: { lines: FactLine[] }
  /** Arrival instructions in plain words (from the arrival settings: check-in link, where to go, what to bring). */
  arrival: { lines: FactLine[] }
  automaticTexts: ShopFactsAutomaticTexts
  catalog: ShopFactsCatalog
  plans: ShopFactsPlan[]
  /** The Settings FAQ (assistant.faq), as saved. Data, never instructions: the prompt says so. */
  faq: { q: string; a: string }[]
  /**
   * ADR 0174 (facts-v5): the owner's ACTIVE knowledge entries (notes, reviewed documents, corrections), rendered as the SHOP
   * KNOWLEDGE block (knowledge/render.ts) and read by the judge; absent or empty, the prompt is what it was before.
   */
  knowledge?: ShopKnowledge
}

export interface ShopFactsDeps {
  db: Db
  clock: Clock
  /** BUSINESS_PHONE is the number to call; BUSINESS_TEXT_NUMBER the texting line; BUSINESS_EMAIL the public email (W3a addition). */
  env: Pick<Env, 'BUSINESS_TZ' | 'BUSINESS_PHONE' | 'BUSINESS_TEXT_NUMBER' | 'BUSINESS_EMAIL' | 'PUBLIC_SITE_URL'>
}

/** The facts of a location, rebuilt only when a source version or the business date changed. */
export interface ShopFactsSource {
  get(locationId: string): Promise<ShopFacts>
}

/** W3a, src/modules/assistant/facts.ts. */
export type BuildShopFacts = (deps: ShopFactsDeps) => ShopFactsSource

/**
 * W3a, src/modules/assistant/facts.ts: the facts as the plain-text system block (cached prefix). Deterministic (same facts, same
 * bytes; generatedAt left out), prices written as starting prices ("Signature Hand Wash: starts at $45 for members, $54 otherwise").
 */
export type RenderShopFacts = (facts: ShopFacts) => string

// ---------------------------------------------------------------------------------------------------------------------------
// The tool context (W3a builds one per tool call; W3b's tools read it)
// ---------------------------------------------------------------------------------------------------------------------------

/** The client's own appointments as the model knows them. */
export type AppointmentRefLabel = 'A1' | 'A2' | 'A3'

export interface AppointmentRefs {
  /**
   * The appointment id behind a ref, only for the turn's own client; null for anything else (an unknown label, a ref of another
   * turn's list that no longer exists). A tool never takes an id from the model.
   */
  resolve(ref: string): string | null
  /**
   * The refs of this turn in order: the client's open upcoming appointments by start, then the most recent past one, at most three.
   * Built once at the turn's claim (empty for a stranger or an 'unknown' texter); the turn context lists them with date and service
   * so the model re-reads their meaning every turn.
   */
  all(): readonly { ref: AppointmentRefLabel; appointmentId: string }[]
}

/** Why a tool hands the conversation to staff (W3a adds its own: agent_keyword, fallback, guard, cap, lease_timeout). */
export type ToolHandoffReason =
  /** The client asked for a person. */
  | 'client_asked'
  /** The client is upset or complaining. */
  | 'upset'
  /** The AI cannot help with the request. */
  | 'cannot_help'
  /** Refunds, discounts, damage, legal, "ready by" promises: staff only. */
  | 'policy'
  /** A cancel inside the late window or with money held on the visit (propose_cancel). */
  | 'late_cancel'
  /** A payment link was asked for and the invoice has no payment URL. */
  | 'no_payment_link'
  /** The client texted a photo and the reply says the team will review it (W4b X8: the AI cannot see pictures). */
  | 'photo_quote'

export interface HandoffRequest {
  reason: ToolHandoffReason
  /** One or two plain sentences for staff (the alert's text). No PIN, code or card digits. */
  summary: string
}

/** What the audit row records; the actor ("Oasis AI (SMS)") and the request id (the turn id) are the context's. */
export interface ToolAuditDetail {
  entityType: string
  entityId?: string | null
  before?: unknown
  after?: unknown
}

/** The messaging queue (DbMessageQueue.enqueueFor): action_confirm texts, and the leads' follow-up. */
export type AssistantQueue = IdentityQueue

export type AssistantLog = Pick<Logger, 'info' | 'warn' | 'error'>

/** The audit actor's name for everything the assistant does. */
export const AI_ACTOR_NAME = 'Oasis AI (SMS)'

export interface ToolContext {
  /** The pool. A tool that writes opens its own transaction (platform/db.ts transaction) and audits in it. */
  db: Db
  clock: Clock
  /** The turn's instant: every tool of the turn reads the same now. */
  now: Date
  newId: NewId
  env: Env
  /** Who is texting. Replaced (read it again) after setCustomer. */
  readonly identity: TurnIdentity
  conversationId: string
  turnId: string
  facts: ShopFacts
  refs: AppointmentRefs
  /**
   * In-chat actions are on: AI_ACTIONS_ENABLED and the setting assistant.actions_enabled, read at the turn's start. While false the
   * action tools are not offered at all (AssistantTool.action) and a reply number never executes.
   */
  actionsEnabled: boolean
  /** The scheduling context of the location (clock, ids, tz, ports) for createAppointment / reschedule / cancel and availability. */
  scheduling: SchedulingCtx
  /** The assistant's actor (permissions sched.edit + jobs.status only; name AI_ACTOR_NAME) for scheduling commands. */
  actor: Actor
  queue: AssistantQueue
  log: AssistantLog
  /** The turn's deadline (AI_TURN_DEADLINE_MS): pass it to anything slow. */
  signal: AbortSignal
  /**
   * Registers a URL the reply may carry and returns its placeholder ("{link1}", "{link2}", …). The real URL never reaches the
   * model: the output guard allows only registered placeholders, and the reply is sent with them as secretVars (class
   * personal_link, the message row masked). W3a appends a registered placeholder the reply left out.
   */
  addLink(url: string, link: { kind: ClientLinkKind; expiresAt: Date }): string
  /** Hands the conversation to staff once the turn ends (alert ai_handoff, thread unread, AI paused). The first request wins. */
  handoff(reason: ToolHandoffReason, summary: string): void
  /** The turn has asked for a handoff (a tool's, handoff_to_staff's): the chat is the staff's from here, nothing is proposed. */
  handoffRequested(): boolean
  /** Writes an audit row in the tool's transaction: action "assistant.<what>" (e.g. assistant.booking.proposed). */
  audit(tx: Tx, action: string, detail: ToolAuditDetail): Promise<void>
  /**
   * Binds the turn to a client whose phone is identity.phone (W3a checks it and refuses another number's client), re-evaluates the
   * trust and records it on the conversation. For the welcome flow when the adoption happens in the turn rather than the webhook.
   */
  setCustomer(customerId: string): Promise<void>
  /**
   * What the tools DO (ADR 0174 §4b): every write a tool makes goes through this seam, its checks and reads stay in the tool. The live
   * turn passes the live effects (tools/effects-live.ts: the code the tools always ran, moved as it was); practice passes effects that
   * change only its own session. Absent: the live effects (the tools' own tests build a context without it).
   */
  effects?: ToolEffects
  /**
   * The conversation's language for the tools' own words (a proposal's summary). The live turn passes the language it answers in;
   * absent, the tools read the conversation's stored language (conversationVoice), as before ADR 0174.
   */
  lang?: ConvoLang
}

/** A proposal to record and text (propose_booking / propose_reschedule / propose_cancel; identity/pending-actions.ts). */
export interface ProposeEffect {
  kind: PendingActionKind
  /** The summary the client reads ("Signature Hand Wash, Sat Jun 13 at 10:00 AM"), in the conversation's language. */
  summary: string
  payload: { [key: string]: JsonValue }
  appointmentId: string | null
}

/** A vehicle set_my_vehicle saves (validated by the tool: the size is one of SHOP FACTS' sizes, the words are plain). */
export interface VehicleEffect {
  size: ShopFactsSize
  make: string
  model: string
  year: number | null
  color: string | null
}

/**
 * The tools' side effects (ADR 0174 §4b). Live (tools/effects-live.ts): the existing code, writing the live tables in its own
 * transactions with audit rows and texts. Practice: session state only (a link becomes "[booking link]", a proposal shows the
 * confirmation it would text); nothing is written to a client record, a lead, a link, a pending action, the outbox or the audit log.
 */
export interface ToolEffects {
  /**
   * The categories the texter asked about: added to the number's lead (note_interest also opens the lead first, `openLead`;
   * check_availability only adds to an open one). Returns the lead's interests, or null without a lead.
   */
  noteInterest(ctx: ToolContext, categories: readonly string[], o: { openLead: boolean }): Promise<string[] | null>
  /**
   * Issues a personal link of an allowed kind to the number that is texting (the tool checked the switch, the kind against the
   * texter and the plan), registers it with ctx.addLink and answers with its placeholder; `retext: false` never re-texts a link of
   * the hour (check_availability).
   */
  issueLink(ctx: ToolContext, input: ToolInputs['send_link'], o: { retext?: boolean }): Promise<ToolOutcome>
  /** Records a proposal and texts its reply number (the tool checked the switches, the trust, the slot and the handoff). */
  propose(ctx: ToolContext, o: ProposeEffect): Promise<ToolOutcome>
  /** Saves the new client's name (a cleaned person's name; the record decides whether it may change). */
  saveName(ctx: ToolContext, fullName: string): Promise<ToolOutcome>
  /** Adds the vehicle to the client's own record and answers with the price keys of its size. */
  saveVehicle(ctx: ToolContext, v: VehicleEffect): Promise<ToolOutcome>
  /** Records the opt-out (exactly like STOP) and texts the confirmation once. */
  optOut(ctx: ToolContext): Promise<ToolOutcome>
  /** handoff_to_staff: cancels the number's pending proposals (the chat is the staff's from here). */
  cancelPending(ctx: ToolContext): Promise<void>
}

// ---------------------------------------------------------------------------------------------------------------------------
// Tools (design §4): W3b implements them, W3a lists them to the model and runs them
// ---------------------------------------------------------------------------------------------------------------------------

/** The tool names the prompt (W3a) and the registry (W3b) agree on. */
export type AssistantToolName =
  | 'get_business_info'
  | 'list_services'
  | 'get_membership_info'
  | 'check_availability'
  | 'list_my_appointments'
  | 'get_balance'
  | 'set_my_name'
  | 'set_my_vehicle'
  | 'note_interest'
  | 'propose_booking'
  | 'propose_reschedule'
  | 'propose_cancel'
  | 'send_link'
  | 'opt_out'
  | 'handoff_to_staff'

/** A business date in the shop's time zone, YYYY-MM-DD. */
export type BizDate = string

/**
 * Each tool's input (the zod schema of AssistantTool.input parses to this). Strict JSON schemas: no extra property, every property
 * required (null for "not given"). No input names a client, a phone, an id or a price.
 */
export interface ToolInputs {
  get_business_info: {
    topic: 'hours' | 'closures' | 'address' | 'contact' | 'booking_rules' | 'fee' | 'cancellation' | 'vip' | 'arrival' | 'automatic_texts' | 'faq'
  }
  /** A category key (ShopFactsCategory.key), or null for all. */
  list_services: { category: string | null }
  get_membership_info: Record<string, never>
  /** The open times of that day for that service; partOfDay narrows them (morning before 12:00, afternoon before 17:00, evening). */
  check_availability: { serviceKey: string; date: BizDate; partOfDay: 'morning' | 'afternoon' | 'evening' | null }
  list_my_appointments: Record<string, never>
  get_balance: Record<string, never>
  set_my_name: { fullName: string }
  /** size: a size key of SHOP FACTS (ShopFactsSize.key, facts-v4), checked against them. */
  set_my_vehicle: {
    size: string
    make: string
    model: string
    year: number | null
    color: string | null
  }
  /** Category keys. */
  note_interest: { categories: string[] }
  /** startMin: minutes from midnight (business time zone). vehicle: the client's own vehicle as they named it ("the Civic"). */
  /** vehicleClass: the size key of the car (ShopFactsSize.key) when known; a size staff set on the car named wins. */
  propose_booking: { serviceKey: string; addonKeys: string[]; date: BizDate; startMin: number; vehicle: string | null; vehicleClass: string | null }
  propose_reschedule: { appointmentRef: AppointmentRefLabel; date: BizDate; startMin: number }
  propose_cancel: { appointmentRef: AppointmentRefLabel; reason: string }
  /** appointmentRef: for pay (that visit's invoice) or calendar (reschedule that visit); tier: for membership. */
  send_link: {
    kind: Extract<ClientLinkKind, 'calendar' | 'verify' | 'pin' | 'membership' | 'pay'>
    appointmentRef: AppointmentRefLabel | null
    tier: PublicTier | null
  }
  opt_out: Record<string, never>
  handoff_to_staff: { reason: Exclude<ToolHandoffReason, 'late_cancel' | 'no_payment_link'>; summary: string }
}

/**
 * Why a tool did not do it (the model reads `message` and acts on the kind):
 *   needs_verification  the trust is below the tool's minTrust: the model offers send_link {kind: verify} (or calendar)
 *   not_allowed         never for this texter (set_my_name on a real name, a membership link to a stranger)
 *   invalid             the input does not make sense (unknown serviceKey, a date in the past, a slot that is not open)
 *   not_found           the ref or the thing asked for does not exist (for this client)
 *   unavailable         switched off (actions off, links off) or the system cannot do it now
 *   rate_limited        a limit was reached (links per day/kind, AI bookings per client)
 */
export type ToolErrorKind = 'needs_verification' | 'not_allowed' | 'invalid' | 'not_found' | 'unavailable' | 'rate_limited'

export type ToolOutcome =
  | {
      ok: true
      /** What the model reads (the toolResult's JSON). No phone, id, token, URL (placeholders only), code or PII of others. */
      data: AiJsonObject
      /**
       * Dollar amounts (cents) a tool declares: only the client's own open balance (get_balance; the first one is the total). The
       * turn renders {balance} from get_balance's data.openBalanceCents, else from the first of these.
       */
      amountsCents?: number[]
      handoff?: HandoffRequest
    }
  | {
      ok: false
      error: ToolErrorKind
      /** One plain sentence for the model ("This needs a quick verification first."). */
      message: string
      /** Extra facts for the model (e.g. the next open dates after `invalid`). Same rules as `data`. */
      detail?: AiJsonObject
      handoff?: HandoffRequest
    }

/**
 * A tool. W3a, for each call: looks the tool up by name (an unknown name is an `invalid` result), checks identity.trust against
 * minTrust (below it: `needs_verification`, run is not called, the call is recorded as denied), parses the input with `input`
 * (failure: `invalid`), runs it under the turn deadline, records assistant_tool_calls (input, output, outcome ok | error | denied,
 * latency) and turns the outcome into the toolResult (status error when ok is false). An exception from run is an `unavailable`
 * result for the model and an error in the row (never its message: it may hold data).
 */
export interface AssistantTool<I = unknown> {
  name: AssistantToolName
  /** What the model reads to choose the tool: short, plain, stable (it is part of the cached prefix). */
  description: string
  /**
   * The input schema (zod v4, z.strictObject): W3a turns it into the tool's JSON Schema (z.toJSONSchema) for Converse, so every
   * property is required and "not given" is null.
   */
  input: z.ZodType<I>
  /**
   * The lowest trust that may run it. unknown: anyone texting (public facts, availability, interests, links that go to the number
   * itself, opt-out, handoff); caller: the client's own record; trusted: the in-chat actions. A tool may refuse more (set_my_name
   * only on a provisional client; send_link pin/membership/pay only for a client).
   */
  minTrust: TurnTrust
  /** An in-chat action (propose_*): offered to the model only while ToolContext.actionsEnabled. */
  action?: boolean
  run(ctx: ToolContext, input: I): Promise<ToolOutcome>
}

/** Any tool, whatever its input (the registry's element type). */
export type AnyAssistantTool = AssistantTool<unknown>

/**
 * The minimum trust of each tool (the design's §4 table; "caller" there means "whoever texts from the number" for the public ones,
 * which is `unknown` here). W3b's tools use these values; W3a's prompt may rely on them.
 *   get_business_info unknown · list_services unknown · get_membership_info unknown (the client's own membership view only from
 *   caller) · check_availability unknown (VIP-aware only when trusted) · list_my_appointments caller · get_balance caller ·
 *   set_my_name caller (provisional only) · set_my_vehicle caller · note_interest unknown · propose_booking / propose_reschedule /
 *   propose_cancel trusted (action) · send_link unknown (verify/calendar; pin/membership/pay need a client) · opt_out unknown ·
 *   handoff_to_staff unknown
 */
export type ToolTrustTable = { readonly [N in AssistantToolName]: TurnTrust }

/** The table above as data: W3b's tools take their minTrust from it, W3a's tests check the registry against it. */
export const TOOL_MIN_TRUST: ToolTrustTable = {
  get_business_info: 'unknown',
  list_services: 'unknown',
  get_membership_info: 'unknown',
  check_availability: 'unknown',
  list_my_appointments: 'caller',
  get_balance: 'caller',
  set_my_name: 'caller',
  set_my_vehicle: 'caller',
  note_interest: 'unknown',
  propose_booking: 'trusted',
  propose_reschedule: 'trusted',
  propose_cancel: 'trusted',
  send_link: 'unknown',
  opt_out: 'unknown',
  handoff_to_staff: 'unknown',
}

export interface ToolRegistry {
  /** Every tool, in a fixed order (the order is part of the cached prefix). */
  readonly tools: readonly AnyAssistantTool[]
  get(name: string): AnyAssistantTool | undefined
}

// ---------------------------------------------------------------------------------------------------------------------------
// Factories: W3a's wiring calls them once per process with the same deps; W3b implements them
// ---------------------------------------------------------------------------------------------------------------------------

/** What the process gives every W3 assistant part (built once by W3a's wiring). */
export interface AssistantDeps {
  db: Db
  clock: Clock
  newId: NewId
  env: Env
  queue: AssistantQueue
  log: AssistantLog
  facts: ShopFactsSource
  /** The scheduling context of a location (the production scheduling ports). */
  schedulingFor(locationId: string): SchedulingCtx
  /** The assistant's actor of a location (permissions sched.edit + jobs.status only, name AI_ACTOR_NAME). */
  actorFor(locationId: string): Actor
}

/** W3b, src/modules/assistant/tools/index.ts. */
export type CreateToolRegistry = (deps: AssistantDeps) => ToolRegistry

/**
 * W3b, src/modules/assistant/actions/handler.ts: the W2d ActionCodeHandler port (reply numbers). hasPending looks the number's
 * pending action up (identity/pending-actions.ts findPendingAction); handle re-checks the kill switches (AI_ENABLED,
 * assistant.enabled, the actions switches: off = the action is canceled, nothing runs), confirmPendingAction, executes it in the
 * webhook's transaction (createAppointment channel online, source sms_ai | rescheduleAppointment | cancelAppointment notify) as
 * actorFor(locationId), completes or fails it, marks the lead booked, and answers the client (ai_reply). Wrong / expired / locked
 * replies answer with a short line; the code is never stored readable or logged.
 */
export type CreateActionCodeHandler = (deps: AssistantDeps) => ActionCodeHandler

/**
 * W3b, src/modules/assistant/welcome/new-texters.ts: the W2d NewTexters port. adopt creates the provisional client (source
 * inbound_sms, consent inbound_text, needs_details, name "New texter ••NNNN") and opens the lead (source text) in the webhook's
 * transaction, idempotently per (location, phone); returns null (adopts nothing) while the assistant is off.
 */
export type CreateNewTexters = (deps: AssistantDeps) => NewTexters

/** The lead record (design §1 Leads, plan J), keyed by (location, phone). */
export interface Leads {
  /** Opens (or returns) the lead of a number: source text | website | walk_in. Idempotent. */
  open(tx: Tx, o: { locationId: string; phone: string; customerId: string | null; source: 'text' | 'website' | 'walk_in'; at: Date }): Promise<{ leadId: string }>
  /** Adds interest categories (note_interest) and moves last_contact_at. */
  noteInterest(tx: Tx, o: { locationId: string; phone: string; categories: string[]; at: Date }): Promise<void>
  /** A booking closes the number's open lead as booked (the AI's action, a personal link booking, a staff booking). */
  markBooked(tx: Tx, o: { locationId: string; phone: string; appointmentId: string; at: Date }): Promise<void>
}

/** W3b, src/modules/leads/index.ts. */
export type CreateLeads = (deps: AssistantDeps) => Leads

/**
 * W3b, src/modules/leads/index.ts: the leads' jobs: `leads.follow_up` (the one automatic follow-up text, settings leads.*, class
 * lead_follow_up, once per lead, never after STOP) and the 30-day archive of provisional clients that never gave a name nor booked.
 * Harmless with the defaults: they do nothing while AI_ENABLED=false or assistant.enabled=false (and no lead exists before then).
 */
export type CreateLeadJobs = (deps: AssistantDeps) => JobDefinition<never>[]
