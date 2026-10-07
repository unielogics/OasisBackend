# 0081 Role money limits: dollars in, cents out, pinned by a test

Status: accepted (2026-10-07). Closes gap 5 of the b6 list.

* The Settings design cycles a limit chip through 25, 50, 100, 250, 500, 1000 and No limit (dollars). `PUT /roles/:id/limits/:kind`
  therefore takes `{value}` in **dollars** (one of those chips or `null`); it is stored in `role_limits.limit_cents` and returned
  as `limitCents` in **cents**. Every read of a limit (`GET /roles` `limits` and `limitChoicesCents`, `GET /me`, the PUT response)
  is integer cents with `null` for No limit (ADR 0010). No other route takes a limit.
* The two units meeting on one path is the drift risk: a client that echoes `limitChoicesCents` back into the PUT would send 2500
  and, if a future edit loosened the chip check, set a $2,500 limit. The check stays strict (a cents value is 422 "Choose 25, 50,
  100, 250, 500, 1000 or No limit") and the contract now says so in every place a reader looks: the OpenAPI body field
  (`DOLLARS, not cents`), the response fields (`CENTS`), the API spec row and a paragraph in section 14. The dashboard's Settings
  port notes (`docs/screens-settings.md`: "limits are dollars in the design, cents in /roles; the PUT takes dollars") already
  state the same rule and its live port sends the chip value as is; no dashboard change is needed.
* Guard: `test/scheduling-gaps/role-limit-units.test.ts` walks every chip through the PUT (dollars to cents), proves a cents value
  and a string are refused, compares `limitChoicesCents` with the dollar chips times 100, and reads `docs/openapi.json` and
  `docs/api-spec.md` to fail when the unit wording disappears from either.
