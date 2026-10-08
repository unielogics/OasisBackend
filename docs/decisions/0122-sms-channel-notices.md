# 0122 SMS channel notices: flap debounce, app restarted without a reboot, texts queued with no device
Status: accepted (2026-10-08)

* **Flap debounce.** A device going offline and coming back used to notify every manager on every transition, so a tablet with a
  weak connection could produce a notice every few minutes. Now each kind (offline, back online) goes out at most once per device
  per 30 minutes (`FLAP_WINDOW_MS`); a held-back change still reaches the managers live (`sms.device.health` over SSE) and the
  Needs Attention alert is computed from the current state as before. When the window allows, the health poll compares the
  device's state with the last one announced and, if they differ (it ended offline after a "back online"), announces it once,
  saying how many changes were held back. State lives in `notice_debounce` (keys `sms.device:<id>:offline|online|state`).
* **App restarted without a reboot** (review B16). An `app:started` webhook while the tablet was heard from at most 90 seconds
  earlier (`APP_RESTART_QUIET_MS`), with no failed poll in between and not offline, means the app was restarted under a running
  tablet: Android or the vendor's battery manager killed it. Managers get "SMS app restarted" with the fix (battery Unrestricted,
  autostart), once per window. A reboot takes the tablet away first (a failed poll), and the first signal ever is never a
  restart; the payload carries no uptime, so this is a heuristic, tuned by the constant.
* **Texts queued and no enabled device.** The Needs Attention set (managers) shows a red "No SMS device" alert (kind
  `sms_device_down`, key `sms_no_device`) while texts wait and no device is enabled; the dispatcher tick and the health poll send
  one "No SMS device" notice per episode, repeated every six hours while it lasts; the episode closes when a device is enabled or
  the queue empties.
* Everything runs in the transaction that changed the state, like the notices it replaces. Recipients are unchanged (holders of
  `set.billing` or `sched.override`).
