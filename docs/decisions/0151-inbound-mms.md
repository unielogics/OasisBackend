# 0151 Inbound MMS is routed like SMS; pictures go to the photos store; signed deliveries Oasis cannot use are kept
Status: accepted (2026-10-10)

## Context

Production finding (2026-10-10): the owner's plain "OK" replies reached the shop tablet as **MMS** (tablet log: `MMS content
incomplete (id=4, sender=unknown, attachments=0), retrying`, then `ReceiverService::process - message received, messageType MMS`).
SMS Gate reports an MMS only through `mms:received` (the WAP push: metadata, no text) and `mms:downloaded` (the content), and Oasis
subscribed to neither. The parser answered every other event 200 `ignored` without storing it, so the replies, and any STOP, C or
question a phone chose to send as MMS (group texts, long texts, pictures, some carriers' defaults), were lost without a trace.

## Decision

1. **Subscribe** to `mms:received` and `mms:downloaded` (`SMSGATE_WEBHOOK_EVENTS`: nine `oasis-*` registrations). The existing
   sync converges a tablet that holds the seven SMS-era ones by creating the two missing ones (boot, hourly, every `app:started`).
2. **`mms:downloaded` is a received message.** It becomes the same port event as `sms:received` (sender from `sender`, else
   `phoneNumber`, normalised the same way; text = body trimmed, else the text of its `text/plain` parts (and of any `text/*` part
   that declares a charset, contact cards excepted; UTF-8 by default; 16 KB at most), else the subject; dedupe on the envelope id and on
   `(device, 'mms:' + messageId)`: the prefix because Android numbers MMS separately and a bare id could equal an SMS's) with the parts attached, and goes through the **same router**: keywords (STOP, START, HELP, C, CANCEL),
   quarantine and attribution are identical. The inbox row and the message carry `kind = 'mms'`; `messages.channel` stays `sms`
   (one thread). `mms:received` is recorded in `webhook_log` and applies nothing: its text is not known yet.
3. **No text is never dropped.** An MMS with parts and no text is filed as `[Picture message]`; one with neither (the device could
   not download it) as `[Picture message — content unavailable]`. Either raises the `sms.picture_message` manager notification
   ("Picture message from <name or masked number> — check the tablet / dashboard") whoever sent it, a stranger or an unreadable
   sender included, because nobody else will look at the tablet. A placeholder is never read as a keyword.
4. **Pictures go to the existing photos store** (`STORAGE_PROVIDER`; no new bucket, never public) under
   `messaging/mms/<location>/<device message id>/<index>.<ext>`: image parts only, at most five, up to 5 MB each, JPEG, PNG or WebP
   by their bytes (the store's own allow-list). Every part is listed in `attachments` (JSON on `messages` and `sms_inbox`) with its
   status: `stored`, `listed` (not a picture), `skipped` (`too_large`, `limit`, `unsupported_type`) or `unavailable` (`missing`,
   `decode_failed`, `storage_error`). The storage key never leaves the server; the message DTO lists name, type, size and status.
   A storage failure loses the picture, never the text: a STOP must not wait on S3. The daily retention (`maintenance.retention`)
   deletes the saved pictures with the message that lists them, and with an inbox row that has no message (a quarantined
   stranger's, a superseded placeholder's) when it purges that row; a row whose pictures cannot be deleted is kept for the next
   run, which then fails so the job retries. Once final (processed, ignored, failed, unparsed), the stored `webhook_log` copy
   loses the base64 bytes (90 days of megabytes would serve nobody).
5. **Diagnostics.** A delivery whose signature verifies but whose event Oasis does not handle (still answered 200, so the device
   stops retrying) or whose payload it cannot read (400) is stored with `webhook_log.status = 'unparsed'`, body cut to its first
   4 KB once its attachment bytes are stripped, the event name in `headers.x-event`, purged after 7 days by `maintenance.purge`, and logged at warn with the event name
   only. A payload shape that differs from the documentation therefore shows up instead of vanishing.
6. **Body limit.** The hooks listener takes up to 16 MB on `/hooks/smsgate` (pictures arrive base64-encoded in the webhook) and
   answers 413 above it; every other path keeps 1 MB.

7. **Incomplete, then complete (review 2026-10-10).** The tablet may report an MMS before its content is there (`MMS content
   incomplete`): no sender, or neither text nor a part with bytes. Such a delivery is filed under `mms:<messageId>:incomplete`, so
   it does not consume the message's dedupe identity: when the complete `mms:downloaded` of the same message follows, it is routed
   like any other (a STOP is honoured), and the placeholder is marked superseded (`sms_inbox.superseded_by`): its thread message is
   removed (`message.removed` on the `messages` channel, unread count adjusted), its picture alert is marked read with "The full
   message arrived later and was filed in its place." (found by `notifications.source_ref`), and it leaves the quarantine list. An
   incomplete delivery after the complete one, and a second complete one, are repeats. Both deliveries of one message are
   serialised by a transaction-scoped advisory lock.

## Consequences

- The field names come from the SMS Gate documentation, not from a captured delivery (`docs/integrations/smsgate.md` section 1
  lists each assumption, and assumptions 21 and 22 how to check them on the tablet). If the first real `mms:downloaded` differs,
  it lands as `unparsed` or 400 with its first 4 KB kept, not silently.
- There is no picture viewer in the dashboard yet: staff read pictures on the tablet; the store holds them for a later viewer.
- An MMS that never finishes downloading and for which the app sends only `mms:received` is recorded but not announced; a check
  for `mms:received` without a matching `mms:downloaded` is a possible follow-up once the tablet's behaviour is observed.
- MMS has no delivery receipts; Oasis never sends MMS.
