// The assistant's tools (ADR 0160, design section 4; wave W3b). Every tool has a strict zod input (every property required, null for
// "not given"; no client, phone, id or price), binds the client from ctx.identity on the server, resolves appointments only through
// the turn's refs A1..A3, and returns JSON without phone numbers, ids, tokens, URLs (link placeholders only) or reply numbers. The
// minimum trust of each is TOOL_MIN_TRUST (the turn refuses below it); the in-chat actions are flagged `action` and offered only while
// actions are on. The order is fixed: it is part of the cached prompt prefix.
import type { AnyAssistantTool, AssistantToolName, CreateToolRegistry, ToolRegistry } from '../contract.js'
import { getBalance, listMyAppointments, setMyName, setMyVehicle } from './account.js'
import { proposeBooking, proposeCancel, proposeReschedule } from './actions.js'
import { checkAvailability } from './availability.js'
import { handoffToStaff, noteInterest, optOut, sendLink } from './conversation.js'
import { getBusinessInfo, getMembershipInfo, listServices } from './info.js'

export const TOOL_ORDER: readonly AssistantToolName[] = [
  'get_business_info',
  'list_services',
  'get_membership_info',
  'check_availability',
  'list_my_appointments',
  'get_balance',
  'set_my_name',
  'set_my_vehicle',
  'note_interest',
  'propose_booking',
  'propose_reschedule',
  'propose_cancel',
  'send_link',
  'opt_out',
  'handoff_to_staff',
]

const ALL = [
  getBusinessInfo,
  listServices,
  getMembershipInfo,
  checkAvailability,
  listMyAppointments,
  getBalance,
  setMyName,
  setMyVehicle,
  noteInterest,
  proposeBooking,
  proposeReschedule,
  proposeCancel,
  sendLink,
  optOut,
  handoffToStaff,
] as unknown as readonly AnyAssistantTool[]

/** The registry (the tools need no process deps of their own: everything comes through the turn's ToolContext). */
export const createToolRegistry: CreateToolRegistry = (_deps): ToolRegistry => {
  const tools = TOOL_ORDER.map((name) => ALL.find((t) => t.name === name)!)
  const byName = new Map(tools.map((t) => [t.name as string, t]))
  return { tools, get: (name) => byName.get(name) }
}

export { loadAppointmentRefs, refsOf } from './refs.js'
export { isProvisional, isProvisionalClient, provisionalName } from '../welcome/provisional.js'
