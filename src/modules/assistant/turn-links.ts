// The links and the handoff request of one turn (ADR 0174 §4a, shared by the live turn and practice): ToolContext.addLink registers
// a URL under a placeholder ("{link1}", "{link2}", …) that the reply carries and composeReply sends as a secretVar; the kinds decide
// the safety line; the first handoff request of the turn (a tool's or handoff_to_staff's) wins.
import type { ClientLinkKind } from '../identity/schema.js'
import type { HandoffRequest, ToolHandoffReason } from './contract.js'

export class TurnLinks {
  private readonly urls = new Map<string, string>()
  private readonly kinds = new Set<string>()
  /** The turn's handoff request (the first one wins), or null. */
  handoffRequest: HandoffRequest | null = null

  /** Registers a URL and returns its placeholder. */
  add(url: string, link: { kind: ClientLinkKind | string }): string {
    const p = `{link${this.urls.size + 1}}`
    this.urls.set(p, url)
    this.kinds.add(link.kind)
    return p
  }

  get size(): number {
    return this.urls.size
  }

  /** placeholder -> URL, in the order they were registered. */
  get map(): ReadonlyMap<string, string> {
    return this.urls
  }

  placeholders(): string[] {
    return [...this.urls.keys()]
  }

  /** The kinds of the links registered, in order. */
  kindList(): string[] {
    return [...this.kinds]
  }

  /**
   * ADR 0174 §3b: the reply carries none of the turn's links (the handoff-topic backstop replaces the model's reply with the fixed
   * handoff line): the issued links stay unused, the safety line goes with them.
   */
  drop(): void {
    this.urls.clear()
    this.kinds.clear()
  }

  handoff(reason: ToolHandoffReason, summary: string): void {
    this.handoffRequest ??= { reason, summary }
  }

  requestHandoff(h: HandoffRequest | null): void {
    if (h) this.handoffRequest ??= h
  }

  requested(): boolean {
    return this.handoffRequest !== null
  }
}
