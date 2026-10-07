# 0080 Emergency closing: one ops event per transition

Status: accepted (2026-10-07). Closes gap 4 of the b6 list; supersedes the Events bullet of ADR 0031.

* Closing publishes `emergency.started` `{id, summary, pause}` on the `ops` channel. Reopening publishes `emergency.reopened`
  `{id, auto}`; `auto` is true when the end-time job (`emergency.auto_reopen`, `emergency.sweep`) did it. Nothing else is
  published on `ops` for either transition. The design (5.7) names exactly these two events.
* Before, `reopenShop` (the service) published `emergency.ended` and `reopenCommand` published `emergency.reopened`, so one
  reopen reached an SSE subscriber twice under two names, and a direct call to the service (`reopenIfEnded`) announced only the
  name nobody consumed. The publish now lives in the service, once, so every path (route, job, direct call) announces the same
  way; the command layer adds nothing.
* `settings.changed {section: "emergency"}` on the `settings` channel is unchanged (one per transition, for the Settings screen).
* Notification consequences: the crew bell notification (`kind = emergency`, targeted `notification.new`) is created once, at the
  close, and only when the close asked to alert the crew. Reopening creates none; the banner clears from `emergency.reopened` and
  the ops snapshot. A test asserts both the SSE sequence a subscriber receives and that the notification count does not move on
  reopen.
* Tests: `test/scheduling-gaps/emergency-events.test.ts`; the three existing tests that encoded the duplicate
  (`test/settings/emergency.test.ts`, `test/settings-http/sse.test.ts`, `test/settings-http/emergency.test.ts`) now expect the
  single event.
