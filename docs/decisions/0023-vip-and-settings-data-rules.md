# 0023 VIP, arrival and settings data rules

Status: accepted (2026-10-06)

- **VIP is membership of `vip_clients`** for the location (resolved by customer id), never a name string or an appointment
  flag. The design's name box maps to `addVipByName`: one exact (case-insensitive) match is added; several exact matches or
  only partial matches return candidates (id, name, masked phone hint, vehicles) for the caller to pick; none is `not_found`.
- **Booking windows are ranges, not multiples of 7.** The design says 7-90 and 7-60 "step 7", but its own defaults (30 and 14
  days) are off that grid and its stepper drifts to 23 or 37. The server validates the range; the step is a UI affordance.
- **Allowed sets** are enforced twice, in the service (field-level 422 messages) and by database checks: release 24/48/72,
  same-day 0-8, offer 10/15/30, cadences weekly/biweekly/triweekly/monthly, radius 150/300/500, prep 10/15/20.
- **Duplicate hold** is `409 VIP_HOLD_EXISTS` with title and detail `That slot is already held` (the design's toast).
- **Hold release** is computed at query time: a held slot is VIP-only until `slotStart - release_hours`
  (`holdReleasesAt`, `isHoldReleased`); no job mutates holds.
- **Error strings** use straight apostrophes like the rest of the error catalog (`There's already a closure on that date.`);
  the design's source uses U+2019, which is a one-line change in `CLOSURE_ERRORS` if exact parity is wanted.
- **Seed profiles** `domain`, `domain-design`, `base` and `design` (see `docs/data-model.md`); `base` and `design` are
  compositions that the people, payments and appointment seeds extend through `dependsOn`.
