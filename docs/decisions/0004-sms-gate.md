# 0004 SMS only, via SMS Gate
Status: accepted (2026-10-06)

SMS is the only customer channel; every "WhatsApp" label in the designs is relabelled SMS. Transport is SMS Gate
(capcom6/android-sms-gateway) on a cellular Android tablet reached over Tailscale. Webhooks (sms:received/sent/delivered/failed/
cancelled, system:ping, app:started) are HMAC-SHA256 signed and must be HTTPS for non-localhost, served tailnet-only via
`tailscale serve --set-path /hooks/smsgate`. STOP/START/HELP/C are parsed in Oasis. Default send budget 30 per 30 minutes until
verified on the device. Seeds use synthetic numbers; non-production sends are restricted by `SMS_ALLOWLIST`.
