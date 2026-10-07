// The Squarespace connection of a location: the API key (stored AES-256-GCM encrypted, never returned by any route) and
// its health. OAuth fields exist in the table but are reserved: webhook subscriptions need OAuth, polling does not.
import type { Clock } from '../../../platform/clock.js'
import type { Executor } from '../../../platform/db.js'
import type { NewId } from '../../../platform/ids.js'
import type { SecretBox } from './secrets.js'

export interface ConnectionView {
  configured: boolean
  keySource: 'database' | 'environment' | 'simulator' | 'none'
  authKind: 'api_key' | 'oauth'
  status: 'connected' | 'error' | 'disconnected' | 'unconfigured'
  siteId: string | null
  lastError: string | null
  lastVerifiedAt: string | null
  updatedAt: string | null
}

export class ConnectionStore {
  constructor(
    private readonly db: Executor,
    private readonly d: { locationId: string; clock: Clock; newId: NewId; secrets: () => SecretBox },
  ) {}

  private row() {
    return this.db
      .selectFrom('sqsp_connections')
      .selectAll()
      .where('location_id', '=', this.d.locationId)
      .executeTakeFirst()
  }

  /**
   * Public view: whether a key exists and where it comes from, never the key itself or any part of it. In sim mode with no key
   * the simulator's own key is used, which is reported as `simulator`.
   */
  async view(env: { apiKey?: string; provider: 'sim' | 'live' }): Promise<ConnectionView> {
    const r = await this.row()
    const disconnected = r?.status === 'disconnected'
    const hasDb = r?.api_key_enc != null && !disconnected
    // an explicit disconnect stops polling even when SQSP_API_KEY (or the simulator) could still be used
    const keySource = hasDb
      ? 'database'
      : disconnected
        ? 'none'
        : env.apiKey
          ? 'environment'
          : env.provider === 'sim'
            ? 'simulator'
            : 'none'
    return {
      configured: keySource !== 'none',
      keySource,
      authKind: r?.auth_kind ?? 'api_key',
      status: hasDb ? r!.status : keySource !== 'none' ? 'connected' : r ? r.status : 'unconfigured',
      siteId: r?.site_id ?? null,
      lastError: r?.last_error ?? null,
      lastVerifiedAt: r?.last_verified_at?.toISOString() ?? null,
      updatedAt: r?.updated_at.toISOString() ?? null,
    }
  }

  /** True after an explicit disconnect: no key is used until a new one is saved. */
  async isDisconnected(): Promise<boolean> {
    return (await this.row())?.status === 'disconnected'
  }

  /** The decrypted key of a connected database row; undefined when none (the caller falls back to SQSP_API_KEY). */
  async apiKey(): Promise<string | undefined> {
    const r = await this.row()
    if (!r?.api_key_enc || r.status === 'disconnected') return undefined
    return this.d.secrets().decrypt(r.api_key_enc)
  }

  async save(
    apiKey: string,
    o: { userId?: string | null; siteId?: string | null; verified: boolean },
  ): Promise<void> {
    const now = this.d.clock.now()
    const enc = this.d.secrets().encrypt(apiKey)
    const v = {
      auth_kind: 'api_key' as const,
      api_key_enc: enc,
      site_id: o.siteId ?? null,
      status: 'connected' as const,
      last_error: null,
      last_verified_at: o.verified ? now : null,
      updated_at: now,
    }
    await this.db
      .insertInto('sqsp_connections')
      .values({
        id: this.d.newId(),
        location_id: this.d.locationId,
        created_by: o.userId ?? null,
        created_at: now,
        ...v,
      })
      .onConflict((oc) => oc.column('location_id').doUpdateSet(v))
      .execute()
  }

  async setHealth(status: 'connected' | 'error', error?: string): Promise<void> {
    const now = this.d.clock.now()
    await this.db
      .updateTable('sqsp_connections')
      .set({
        status,
        last_error: status === 'error' ? (error ?? 'error') : null,
        ...(status === 'connected' ? { last_verified_at: now } : {}),
        updated_at: now,
      })
      .where('location_id', '=', this.d.locationId)
      .where('status', '<>', 'disconnected')
      .execute()
  }

  async disconnect(): Promise<void> {
    await this.db
      .updateTable('sqsp_connections')
      .set({
        api_key_enc: null,
        access_token_enc: null,
        refresh_token_enc: null,
        client_secret_enc: null,
        status: 'disconnected',
        updated_at: this.d.clock.now(),
      })
      .where('location_id', '=', this.d.locationId)
      .execute()
  }
}
