-- The AI's share of the tablet's send window (ADR 0160, design section 2): the AI classes (ai_reply, ai_fallback, personal_link,
-- action_confirm) together never spend more than AI_SMS_SEGMENTS_PER_30MIN segments per device window, and never lane 0's reserve.
-- The dispatcher counts them from the window accounting, so each usage row now records the class that spent it. Rows written before
-- this migration have none and count as shop texts.
alter table sms_usage add column klass text check (klass is null or klass ~ '^[a-z][a-z0-9_]{0,63}$');
