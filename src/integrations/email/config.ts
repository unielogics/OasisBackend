import { SESv2Client } from '@aws-sdk/client-sesv2'
import { z } from 'zod'
import type { Env } from '../../config/env.js'
import { systemClock, type Clock } from '../../platform/clock.js'
import type { EmailProvider } from '../ports/email.js'
import { ConsoleProvider, type SentEmail } from './console-provider.js'
import { SesProvider } from './ses-provider.js'
import { withSuppression, type IsSuppressed } from './suppression.js'

/**
 * Extra variables for the email integration. env.ts is not edited here: the integrator spreads
 * `emailEnvShape` into envSchema. Plain strings and numbers only, so parsing an already-parsed object is a no-op.
 */
export const emailEnvShape = {
  SES_FROM_NAME: z.string().default('Oasis Auto Spa'),
  SES_REPLY_TO: z.string().email().optional(),
  SES_CONFIGURATION_SET: z.string().optional(),
  /** Comma-separated SNS topic ARNs accepted by /hooks/ses (bounce, complaint, delivery topic). */
  SES_SNS_TOPIC_ARNS: z.string().default(''),
  /** Where the sim driver writes .eml files. */
  EMAIL_CONSOLE_DIR: z.string().default('./.data/mail'),
}
export const emailEnvFragment = z.object(emailEnvShape)
export type EmailEnvFragment = z.infer<typeof emailEnvFragment>

export type EmailEnv = Pick<Env, 'EMAIL_PROVIDER' | 'AWS_REGION' | 'SES_FROM_ADDRESS'> &
  Partial<z.input<typeof emailEnvFragment>>

export interface EmailProviderDeps {
  clock?: Clock
  /** Override the SES client (tests); production relies on the default AWS credential chain. */
  sesClient?: ConstructorParameters<typeof SesProvider>[0]['client']
  isSuppressed?: IsSuppressed
  /** Persist sim mail to outbox_emails. */
  onSimSend?: (mail: SentEmail) => Promise<void> | void
}

export const sesTopicArns = (env: Pick<EmailEnvFragment, 'SES_SNS_TOPIC_ARNS'>): string[] =>
  env.SES_SNS_TOPIC_ARNS.split(',')
    .map((s) => s.trim())
    .filter(Boolean)

export function createEmailProvider(env: EmailEnv, deps: EmailProviderDeps = {}): EmailProvider {
  const x = emailEnvFragment.parse(env)
  const clock = deps.clock ?? systemClock
  let provider: EmailProvider
  if (env.EMAIL_PROVIDER === 'ses') {
    if (!env.SES_FROM_ADDRESS) throw new Error('SES_FROM_ADDRESS is required when EMAIL_PROVIDER=ses')
    provider = new SesProvider({
      client: deps.sesClient ?? new SESv2Client({ region: env.AWS_REGION }),
      from: env.SES_FROM_ADDRESS,
      fromName: x.SES_FROM_NAME,
      ...(x.SES_REPLY_TO ? { replyTo: x.SES_REPLY_TO } : {}),
      ...(x.SES_CONFIGURATION_SET ? { configurationSet: x.SES_CONFIGURATION_SET } : {}),
    })
  } else {
    provider = new ConsoleProvider({
      clock,
      dir: x.EMAIL_CONSOLE_DIR,
      from: env.SES_FROM_ADDRESS ?? 'no-reply@oasis.local',
      fromName: x.SES_FROM_NAME,
      ...(x.SES_REPLY_TO ? { replyTo: x.SES_REPLY_TO } : {}),
      ...(deps.onSimSend ? { onSend: deps.onSimSend } : {}),
    })
  }
  return deps.isSuppressed ? withSuppression(provider, deps.isSuppressed) : provider
}
