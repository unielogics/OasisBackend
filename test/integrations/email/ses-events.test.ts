import { describe, expect, it } from 'vitest'
import {
  decideFromNotification,
  extractAddress,
  SesNotificationError,
} from '../../../src/integrations/email/ses-events.js'
import { sesNotification } from './helpers/sns-fixtures.js'

const mail = { messageId: 'msg-1', timestamp: '2026-10-06T11:59:00.000Z' }

describe('decideFromNotification', () => {
  it('permanent bounce suppresses with message and feedback ids', () => {
    const [d, ...rest] = decideFromNotification(sesNotification('bounce', 'Jane@Example.com'))
    expect(rest).toEqual([])
    expect(d).toMatchObject({
      action: 'suppress',
      reason: 'hard_bounce',
      address: 'jane@example.com',
      feedbackId: 'fb-1',
      bounceType: 'Permanent',
      bounceSubType: 'General',
      diagnostic: 'smtp; 550 user unknown',
    })
    expect(d!.messageId).toMatch(/^0100019aaaaaaaaa/)
    expect(d!.at?.toISOString()).toBe('2026-10-06T12:00:00.000Z')
  })

  it.each(['General', 'NoEmail', 'Suppressed', 'OnAccountSuppressionList', 'OnTenantSuppressionList'])(
    'permanent/%s suppresses',
    (sub) => {
      const [d] = decideFromNotification({
        notificationType: 'Bounce',
        mail,
        bounce: {
          bounceType: 'Permanent',
          bounceSubType: sub,
          bouncedRecipients: [{ emailAddress: 'a@example.com' }],
        },
      })
      expect(d).toMatchObject({ action: 'suppress', bounceSubType: sub })
    },
  )

  it.each([
    ['Transient', 'MailboxFull'],
    ['Transient', 'General'],
    ['Undetermined', 'Undetermined'],
  ])('%s/%s is recorded as a soft bounce, not suppressed', (type, sub) => {
    const [d] = decideFromNotification({
      notificationType: 'Bounce',
      mail,
      bounce: {
        bounceType: type,
        bounceSubType: sub,
        bouncedRecipients: [{ emailAddress: 'a@example.com' }],
      },
    })
    expect(d).toMatchObject({ action: 'soft_bounce', reason: 'soft_bounce' })
  })

  it('handles several recipients in one notification, skipping unusable addresses', () => {
    const out = decideFromNotification({
      notificationType: 'Bounce',
      mail,
      bounce: {
        bounceType: 'Permanent',
        bouncedRecipients: [
          { emailAddress: 'a@example.com' },
          { emailAddress: '"B" <B@Example.com>' },
          { emailAddress: 'garbage' },
        ],
      },
    })
    expect(out.map((d) => d.address)).toEqual(['a@example.com', 'b@example.com'])
  })

  it('complaint suppresses, except a not-spam report', () => {
    expect(decideFromNotification(sesNotification('complaint'))[0]).toMatchObject({
      action: 'suppress',
      reason: 'complaint',
      complaintFeedbackType: 'abuse',
    })
    expect(
      decideFromNotification({
        notificationType: 'Complaint',
        mail,
        complaint: {
          complainedRecipients: [{ emailAddress: 'a@example.com' }],
          complaintFeedbackType: 'not-spam',
        },
      }),
    ).toEqual([])
    expect(
      decideFromNotification({
        notificationType: 'Complaint',
        mail,
        complaint: { complainedRecipients: [{ emailAddress: 'a@example.com' }] },
      })[0],
    ).toMatchObject({ action: 'suppress' })
  })

  it('delivery confirms every recipient', () => {
    const out = decideFromNotification({
      notificationType: 'Delivery',
      mail,
      delivery: { recipients: ['a@example.com', 'b@example.com'], timestamp: '2026-10-06T12:00:00Z' },
    })
    expect(out.map((d) => [d.action, d.address])).toEqual([
      ['delivered', 'a@example.com'],
      ['delivered', 'b@example.com'],
    ])
  })

  it('accepts the event-publishing format (eventType) and ignores unrelated event types', () => {
    const [d] = decideFromNotification({
      eventType: 'Bounce',
      mail,
      bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'a@example.com' }] },
    })
    expect(d?.action).toBe('suppress')
    expect(decideFromNotification({ eventType: 'Open', mail, open: { ipAddress: '1.2.3.4' } })).toEqual([])
    expect(decideFromNotification({ eventType: 'Send', mail })).toEqual([])
    expect(decideFromNotification({ notificationType: 'AmazonSnsSubscriptionSucceeded', mail })).toEqual([])
  })

  it('tolerates unknown fields and an unparseable timestamp', () => {
    const [d] = decideFromNotification({
      notificationType: 'Delivery',
      mail,
      newField: 1,
      delivery: { recipients: ['a@example.com'], timestamp: 'yesterday', extra: true },
    })
    expect(d?.at).toBeNull()
  })

  it('throws SesNotificationError for non-SES content', () => {
    expect(() => decideFromNotification('not json')).toThrow(SesNotificationError)
    expect(() => decideFromNotification('{"hello":"world"}')).toThrow(SesNotificationError)
    expect(() => decideFromNotification('"just a string"')).toThrow(SesNotificationError)
  })
})

describe('extractAddress', () => {
  it.each([
    ['A@B.com', 'a@b.com'],
    ['Name <n@x.org>', 'n@x.org'],
    ['rfc822; q@x.org', 'q@x.org'],
    ['nope', null],
  ])('%s', (raw, out) => expect(extractAddress(raw)).toBe(out))
})
