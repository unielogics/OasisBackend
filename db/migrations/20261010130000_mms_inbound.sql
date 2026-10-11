-- Inbound MMS (ADR 0151). Some phones send a plain reply ("OK", "STOP", "C") as MMS; SMS Gate reports those only through
-- mms:received / mms:downloaded, which Oasis now subscribes to. An MMS is routed exactly like an SMS; what differs is kept here:
-- the kind of the inbound text and the list of its parts. Pictures (image/*, at most five of 5 MB each) are saved in the photos
-- store under messaging/mms/<location>/<message>/ (never public); other parts are listed by name, type and size only.
--
-- attachments: a JSON array, one item per part in the order the device reported them:
--   { "index": 0, "partId": "1", "name": "IMG_0001.jpg", "contentType": "image/jpeg", "size": 48213,
--     "status": "stored" | "listed" | "unavailable" | "skipped", "reason": null | "missing" | "decode_failed" | "too_large"
--       | "limit" | "unsupported_type" | "storage_error", "key": "messaging/mms/..." | null }

alter table messages
  add column kind text not null default 'sms' check (kind in ('sms', 'mms')),
  add column attachments jsonb check (attachments is null or jsonb_typeof(attachments) = 'array');

alter table sms_inbox
  add column kind text not null default 'sms' check (kind in ('sms', 'mms')),
  add column attachments jsonb check (attachments is null or jsonb_typeof(attachments) = 'array');

-- 'unparsed': a delivery whose signature verified but whose event Oasis does not handle (or could not read). It is kept for
-- diagnosis (body cut to its first 4 KB) instead of vanishing, and purged after 7 days by maintenance.purge.
alter table webhook_log drop constraint webhook_log_status_check;
alter table webhook_log
  add constraint webhook_log_status_check check (status in ('received', 'processed', 'ignored', 'failed', 'unparsed'));
