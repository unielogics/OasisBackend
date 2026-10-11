// The one way to give a client a VERIFIED email (ADR 0160, migration 20261011050000). customers.email_verified feeds the
// Squarespace order sync's email tier, so the database drops the flag whenever the email changes (trigger
// customers_email_unverify): a single UPDATE cannot tell "this statement verified the new address" from "the old flag is still
// set", so it never keeps it. This function names the address it verified in a transaction-local setting the trigger reads,
// changes the email and sets the flag in one statement, then clears the setting so nothing later in the transaction inherits it.
import { sql } from 'kysely'
import type { Tx } from '../../platform/db.js'
import { AppError } from '../../platform/errors.js'
import { normalizeEmail } from '../payments-sync/identity.js'

/** The setting the trigger reads: the (lower-case) address the current statement verified. */
export const VERIFIED_EMAIL_SETTING = 'oasis.verified_email'

/**
 * Sets the client's email to `email`, verified (the caller proved the client controls it). Returns false when there is no such
 * live client. Must run inside a transaction (the setting is transaction-local).
 */
export async function setVerifiedEmail(tx: Tx, customerId: string, email: string): Promise<boolean> {
  const address = normalizeEmail(email)
  if (!address)
    throw new AppError('VALIDATION_FAILED', { detail: 'Enter a valid email.', errors: [{ path: 'email', message: 'Enter a valid email.' }] })
  await sql`select set_config(${VERIFIED_EMAIL_SETTING}, ${address}, true)`.execute(tx)
  try {
    const row = await tx
      .updateTable('customers')
      .set({ email: address, email_verified: true })
      .where('id', '=', customerId)
      .where('deleted_at', 'is', null)
      .where('merged_into', 'is', null)
      .returning('id')
      .executeTakeFirst()
    return row !== undefined
  } finally {
    await sql`select set_config(${VERIFIED_EMAIL_SETTING}, '', true)`.execute(tx)
  }
}
