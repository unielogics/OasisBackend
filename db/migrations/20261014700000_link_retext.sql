-- Re-texting a personal link (ADR 0160, wave Q3d, W4 leftover): when a client cannot find a link the assistant texted and send_link
-- is at its one-of-a-kind-an-hour limit, the server texts the SAME link again (its token derives from the link id under a key from
-- PIN_PEPPER, still never stored). retexted_at records that one re-text: a link is re-texted at most once, and the re-text counts in
-- the day's links to the number.
alter table client_links add column retexted_at timestamptz;
alter table client_links add constraint client_links_retexted_check check (retexted_at is null or retexted_at >= created_at);
