// The assistant's tools (ADR 0160, design section 4): STUB of the W3 contract. W3b replaces it with the real registry (the tools of
// contract.ts AssistantToolName, minTrust from TOOL_MIN_TRUST); until then the model is offered no tool.
import type { CreateToolRegistry } from '../contract.js'

export const createToolRegistry: CreateToolRegistry = (_deps) => ({ tools: [], get: () => undefined })
