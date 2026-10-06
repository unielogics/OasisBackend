# 0002 Money and time
Status: accepted (2026-10-06)

All money is integer cents; tax = half-up(subtotal × rate_bp / 10000), rate 700 bp stored as a setting; tip untaxed.
Operations shows cents only when an amount is not whole (the designs disagreed: whole-dollar vs cents). Limits are stored in cents.
Instants are UTC `timestamptz`; hours, closures and "today" are computed in the business tz (America/New_York, a setting).
Time is injected (`Clock`, SQL `app_now()`); bare `Date.now()`/`new Date()`/`Math.random()` are lint-banned.
