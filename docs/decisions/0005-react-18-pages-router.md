# 0005 Dashboard: Next Pages Router + React 18.3.1
Status: accepted (2026-10-06)

The originals run on React 18.3.1. Next's App Router renders with a vendored React canary, which would defeat the pixel/DOM
parity pin, so the dashboard uses the Pages Router (Next 15.x, fallback 14.2.x) with react/react-dom pinned to 18.3.1,
client-only screens, `reactStrictMode: false`, per-screen verbatim global CSS and full-page navigation between screens.
