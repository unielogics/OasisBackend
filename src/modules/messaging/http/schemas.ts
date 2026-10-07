import { z } from '../../../http/zod.js'

export const Message = z.object({
  id: z.string(),
  direction: z.enum(['in', 'out']),
  from: z.enum(['staff', 'system', 'customer']),
  senderName: z.string().nullable(),
  text: z.string(),
  time: z.string(),
  at: z.string(),
  channel: z.enum(['sms', 'email', 'internal']),
  status: z.enum(['queued', 'sending', 'sent', 'delivered', 'failed', 'received', 'canceled', 'expired']),
  error: z.string().nullable(),
  templateKey: z.string().nullable(),
  appointmentId: z.string().nullable(),
  customerId: z.string().nullable(),
  segments: z.number().int(),
  read: z.boolean(),
})
