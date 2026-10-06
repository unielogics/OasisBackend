# 0030 Settings HTTP contract

Status: accepted (2026-10-06)

- **Versions.** Hours and booking rules share `booking_rules.version`. `PUT /settings/hours` requires it (the Save/Discard bar
  is an explicit, dirty-tracked save: 428 without, 412 when stale). Auto-saving sections (rules, VIP, arrival, federal toggle,
  checklists, catalog edits) take it optionally and enforce it when sent, so a click-per-change screen is not forced to track
  tokens. Rule chips save immediately through `PUT /settings/rules` (review B22, C10); the hours editor must adopt the version
  that call returns.
- **Both forms of a time.** The design speaks `"8:00 AM"`, the data model minutes. Requests take either and responses carry
  both. A day or closure that carries both forms and disagrees is a 422: a loaded object edited in one form would otherwise
  lose the edit silently. `PUT /settings/hours` also ignores the read-only fields of its GET (`day`, `len`, `weekHours`, ...).
- **Design aliases.** Emergency `reason` is the chip label or the key; `dur` `through` is an alias of `days`; `until` is
  `"2:00 PM"` or minutes. They cost nothing and keep the design's own vocabulary usable.
- **Labels.** `weekHours` and per-day `len` are the design's strings (`"65 hrs"`); numbers sit beside them. Toast sentences stay
  in the dashboard (they interpolate API values); error `title`/`detail` are the design strings.
- **Reads and the bundle.** The design table makes every settings GET `authenticated` (Operations needs hours, closures and the
  emergency banner), so `GET /settings/bundle` is the union of those read models and omits only what its own route restricts:
  `emergency.history` (`set.emergency`), `vip.clients` (`cli.member`), `counts.employees` (`team.view`), listing them in
  `omitted`. The table is `BUNDLE_READ_PERMISSIONS`; tightening a section later is one line.
- **Name-only VIP add.** backend.md 5.2 creates a stub customer for an unknown name; review B37 warns that this makes duplicates
  and wrong VIPs. An unknown name is 404 `VIP_CLIENT_NOT_FOUND`; several or partial matches are 409 with candidates (last-four
  phone hint only with `cli.contact`); exactly one exact match is added. Re-adding a VIP is 200 `added: false`.
- **Idempotency.** Required on `POST /emergency/close`; optional (honoured when sent) on `POST /closures`, `POST /emergency/reopen`
  and `POST /services`.
- **Strictness.** Bodies are `.strict()`; unknown keys are 422.
