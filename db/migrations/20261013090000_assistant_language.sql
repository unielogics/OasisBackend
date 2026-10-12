-- The conversation's language (ADR 0160 W4b fix X5): the server's own words in an AI conversation (the automated-assistant
-- disclosure, the STOP footer, the safety and card lines, the fallback, the reply-number line and the rendered prices, plans, perks,
-- fee and balance) follow the language of the client's texts; detected from the client's texts by each turn, English by default.
alter table assistant_conversations
  add column language text not null default 'en' check (language in ('en', 'es'));
