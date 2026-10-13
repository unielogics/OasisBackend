// The request of a turn (ADR 0174 §4a and §4c "Prompt parity guarantee"): one assembly for the live turn (turn.ts) and the practice
// chat (practice/runner.ts), so for the same facts, settings and texts both send the model the same bytes: the turn context's last
// touches (the memberships step a shop without plans skips, "no just book it", a request for something free, the client's language
// and the owner's Spanish mode), the SHOP KNOWLEDGE block, the owner block, the tools the owner's limits offer and their specs, and
// the system blocks.
import type { AiSystemBlock, AiToolSpec } from '../../integrations/ports/ai.js'
import type { AnyAssistantTool, ShopFacts, ToolRegistry } from './contract.js'
import { renderShopFacts } from './facts.js'
import { renderShopKnowledge } from './knowledge/render.js'
import type { ConvoLang } from './lang.js'
import { allLinkKinds, policyHash, type AssistantPolicy } from './policy.js'
import { asksForFree, buildSystem, declinesPlans, PROMPT_VERSION, renderOwnerBlock, renderTurnContext, type TurnContextData } from './prompt.js'
import { offeredTools, toolSpecs } from './tool-runner.js'
import type { TranscriptEntry } from './transcript.js'

export interface TurnPromptInput {
  facts: ShopFacts
  /** The turn context as loaded (context.ts loadTurnContext, or practice's own). */
  loaded: TurnContextData
  policy: AssistantPolicy
  registry: ToolRegistry
  /** The client's texts this turn answers. */
  freshClientTexts: readonly string[]
  /** Every client text of the conversation's window ("no just book it" in any of them). */
  allClientTexts: readonly string[]
  /** The client's language: what their new texts are written in, else the conversation's (English by default). */
  clientLang: ConvoLang
}

export interface TurnPrompt {
  /** The language the turn answers in (English for a Spanish texter while the owner answers in English only). */
  lang: ConvoLang
  /** ADR 0174 §3b: the client writes Spanish and the owner hands Spanish chats to the team (no model call). */
  spanishHandoff: boolean
  turnContext: TurnContextData
  contextText: string
  knowledgeText: string
  ownerText: string
  factsText: string
  tools: AnyAssistantTool[]
  specs: AiToolSpec[]
  system: AiSystemBlock[]
  /** The transcript's `system` entry. */
  systemEntry: Extract<TranscriptEntry, { kind: 'system' }>
}

export function buildTurnPrompt(i: TurnPromptInput): TurnPrompt {
  const { facts, loaded, policy } = i
  // ADR 0174 §3b, Spanish: "english" answers a Spanish texter in English (the server's parts too); "handoff" answers with the
  // server's fixed Spanish line and hands the chat to the team, without a model call
  const englishOnly = i.clientLang === 'es' && policy.behavior.spanish === 'english'
  const spanishHandoff = i.clientLang === 'es' && policy.behavior.spanish === 'handoff'
  const lang: ConvoLang = englishOnly ? 'en' : i.clientLang
  // W4 final check L7: "no just book it" (any client text in the window) skips the memberships step and says not to pitch them
  const declinedPlans = loaded.membership === null && declinesPlans(i.allClientTexts)
  const turnContext: TurnContextData = {
    ...loaded,
    // ... and so does a shop that sells no plan online (facts-v4: a tier without a price is not sold)
    ...((declinedPlans || facts.plans.length === 0) && loaded.intake === 'memberships' ? { intake: loaded.vehicles.length > 0 ? null : ('vehicle' as const) } : {}),
    language: lang,
    ...(asksForFree(i.freshClientTexts) ? { asksFree: true } : {}),
    ...(declinedPlans ? { declinedPlans: true } : {}),
    limits: policy.tools,
    ...(englishOnly ? { englishOnly: true } : {}),
  }
  // ADR 0174: the owner's active knowledge ('' without any: the prompt is then exactly what it was before) and (§3b) the owner
  // block ('' with the default limits and tone)
  const knowledgeText = renderShopKnowledge(facts)
  const ownerText = renderOwnerBlock(policy)
  const contextText = renderTurnContext({ ...turnContext, ...(knowledgeText ? { knowledge: true } : {}), ...(ownerText ? { owner: true } : {}) })
  const tools = offeredTools(i.registry, policy.tools)
  const specs = toolSpecs(tools, policy.tools)
  const factsText = renderShopFacts(facts)
  const system = buildSystem({ factsText, contextText, knowledgeText, ownerText })
  const systemEntry = {
    kind: 'system' as const,
    promptVersion: PROMPT_VERSION,
    factsVersion: facts.version,
    tools: tools.map((t) => t.name),
    ...(ownerText || !allLinkKinds(policy.tools) ? { policy: policyHash(policy) } : {}),
  }
  return { lang, spanishHandoff, turnContext, contextText, knowledgeText, ownerText, factsText, tools, specs, system, systemEntry }
}
