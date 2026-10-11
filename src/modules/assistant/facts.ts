// The shop facts (ADR 0160, design section 3b): STUB of the W3 contract. W3a replaces it: buildShopFacts assembles every setting
// into the ShopFacts document (cached by the hash of the source versions), renderShopFacts writes it as the cached system block.
import type { BuildShopFacts, RenderShopFacts } from './contract.js'

export const buildShopFacts: BuildShopFacts = (_deps) => {
  throw new Error('shop facts: not built (W3a)')
}

export const renderShopFacts: RenderShopFacts = (_facts) => {
  throw new Error('shop facts: not built (W3a)')
}
