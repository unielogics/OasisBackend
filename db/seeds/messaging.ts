// Seed profile "messaging": one SIMULATOR SMS device, so a seeded database can send and receive texts end to end with no
// tablet and no credentials. The `design` profile depends on it (db/seeds/index.ts). Idempotent per device key.
import { createSecretBox } from '../../src/modules/messaging/crypto.js'
import type { SeedContext, SeedProfile } from './index.js'

export const SIM_DEVICE_KEY = 'sim-device-design'
export const SIM_WEBHOOK_SECRET = 'sim-signing-key-design'

export const messagingProfile: SeedProfile = {
  description:
    'One simulator SMS device (in-process SMS Gate stand-in); no credentials, nothing leaves the process',
  async run({ tx, newId, location, clock, log }: SeedContext): Promise<void> {
    // SECRETS_KEY is read here because seeds run from the CLI and from tests, outside the app's Env object.
    const box = createSecretBox(process.env.SECRETS_KEY, process.env.NODE_ENV ?? 'development')
    const r = await tx
      .insertInto('sms_devices')
      .values({
        id: newId(),
        location_id: location.id,
        device_key: SIM_DEVICE_KEY,
        label: 'Front desk tablet (simulator)',
        provider: 'sim',
        base_url: null,
        username: null,
        password_enc: null,
        webhook_secret_enc: box.encrypt(SIM_WEBHOOK_SECRET),
        remote_device_id: null,
        sim_slot_default: null,
        min_interval_ms: null,
        max_per_window: null,
        window_minutes: null,
        state_changed_at: null,
        last_seen_at: null,
        last_ping_at: null,
        last_app_started_at: null,
        last_poll_ok_at: null,
        health_status: null,
        battery: null,
        charging: null,
        last_health: null,
        last_error: null,
        webhooks_url: null,
        webhooks_registered_at: null,
        created_at: clock.now(),
        updated_at: clock.now(),
      })
      .onConflict((oc) => oc.column('device_key').doNothing())
      .returning('id')
      .executeTakeFirst()
    log(r ? 'created the simulator SMS device' : 'simulator SMS device already present')
  },
}
