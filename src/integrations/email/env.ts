import { z } from 'zod'

/**
 * Email variables beyond the provider switch, spread into envSchema (src/config/env.ts). Plain strings only, so parsing an
 * already-parsed Env again (createEmailProvider does) is a no-op.
 */
export const emailEnvShape = {
  SES_FROM_NAME: z.string().default('Oasis Auto Spa'),
  SES_REPLY_TO: z.string().email().optional(),
  SES_CONFIGURATION_SET: z.string().optional(),
  /** Comma-separated SNS topic ARNs accepted by /hooks/ses (bounce, complaint, delivery topic). Empty: /hooks/ses refuses everything. */
  SES_SNS_TOPIC_ARNS: z.string().default(''),
  /** SESv2 endpoint override, for the AWS simulator (scripts/verify-live/sim-aws.ts) only; leave unset for AWS. */
  SES_ENDPOINT: z.string().url().optional(),
  /** Where the sim driver writes .eml files. */
  EMAIL_CONSOLE_DIR: z.string().default('./.data/mail'),
}
export const emailEnvFragment = z.object(emailEnvShape)
export type EmailEnvFragment = z.infer<typeof emailEnvFragment>

export const sesTopicArns = (env: Pick<EmailEnvFragment, 'SES_SNS_TOPIC_ARNS'>): string[] =>
  env.SES_SNS_TOPIC_ARNS.split(',')
    .map((s) => s.trim())
    .filter(Boolean)
