-- Inbound MMS follow-ups (ADR 0151).
--
-- An MMS the tablet reported without content ("MMS content incomplete": no sender, or neither text nor a part with bytes) is filed
-- under its own provider id ('mms:<id>:incomplete') with a placeholder and a manager alert. When the complete delivery of the
-- same message follows, it is routed normally and the placeholder row is marked superseded: its thread message (if any) is
-- removed, its alert resolved, and it no longer shows in the quarantine list.
alter table sms_inbox
  add column superseded_by uuid references sms_inbox (id) on delete set null,
  add column superseded_at timestamptz,
  add constraint sms_inbox_superseded_check check ((superseded_by is null) = (superseded_at is null));

-- What a notification is about, for the code that must find it again (a picture-message alert carries
-- 'sms_inbox:<device id>:<provider message id>' so the alert of a superseded placeholder can be resolved). Never shown.
alter table notifications add column source_ref text;
create index notifications_source_ref_idx on notifications (source_ref) where source_ref is not null;
