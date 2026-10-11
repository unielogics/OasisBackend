// The kill switches the W3b parts read (ADR 0160, design section 9): the assistant answers only while AI_ENABLED (environment) and
// assistant.enabled (Settings) are both on; in-chat actions also need AI_ACTIONS_ENABLED and assistant.actions_enabled. Everything
// is off by default, so the welcome flow adopts nobody, the reply-number handler runs nothing and the lead follow-up sends nothing.
import type { Env } from '../../../config/env.js'
import type { Executor } from '../../../platform/db.js'
import { getSetting } from '../../../platform/settings.js'

type SwitchEnv = Pick<Env, 'AI_ENABLED' | 'AI_ACTIONS_ENABLED'>

/** AI_ENABLED and the setting assistant.enabled. */
export async function assistantOn(db: Executor, env: SwitchEnv, locationId: string): Promise<boolean> {
  if (!env.AI_ENABLED) return false
  return (await getSetting(db, locationId, 'assistant.enabled')).value
}

/** assistantOn, AI_ACTIONS_ENABLED and the setting assistant.actions_enabled: the in-chat booking, reschedule and cancel. */
export async function actionsOn(db: Executor, env: SwitchEnv, locationId: string): Promise<boolean> {
  if (!env.AI_ENABLED || !env.AI_ACTIONS_ENABLED) return false
  if (!(await assistantOn(db, env, locationId))) return false
  return (await getSetting(db, locationId, 'assistant.actions_enabled')).value
}
