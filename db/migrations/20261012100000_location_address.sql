-- The shop's street address (ADR 0160 W4b): locations.address existed since the platform core but nothing wrote it, so the
-- assistant's shop facts had no address (the W4 live eval: "what's your address?" got only the website). The website's address,
-- for the existing location only when none is set; the `catalog` seed does the same for a new install (db/seeds/domain.ts SHOP_ADDRESS).
update locations set address = '468 River Drive, Garfield, NJ 07026' where address is null;
