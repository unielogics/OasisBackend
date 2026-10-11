-- The personal-link API (ADR 0160, design section 5, wave W3c): a visit booked on a client's personal link page records its own
-- source, 'link' (channel online: the online rules apply), beside the website's 'online' and the assistant's 'sms_ai'.
alter table appointments drop constraint appointments_source_check;
alter table appointments add constraint appointments_source_check check (
  source in ('dashboard', 'walk_in', 'online', 'phone', 'standing', 'reschedule_link', 'sms_ai', 'link')
);
