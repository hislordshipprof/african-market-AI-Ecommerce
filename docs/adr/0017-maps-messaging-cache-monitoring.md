# 17. Maps, messaging, caching and monitoring services

Date: 2026-10-30 · Status: accepted

## Context
Smaller services each add per-use cost that grows with every order. The goal is the cheapest option that doesn't hurt delivery accuracy or reliability.

## Decision
- **Maps (updated 2026-11-08, owner):** free, keyless services for now. Address suggestions come from **Photon** (open source, OpenStreetMap data, public server at photon.komoot.io). The chosen address is confirmed and given coordinates by the **US Census Geocoder** (US only, no key), which feeds the store-delivery radius check. Cache confirmed addresses in Postgres. If Photon is down, the customer types the full address and the Census check still runs. Courier delivery (DoorDash, Uber Direct) needs neither: their quote APIs take the address and say whether they can deliver. To be reviewed later (#398): self-host Photon, Mapbox, or the original choice, Google Maps Platform with billing caps.
- **SMS:** **Telnyx**, at roughly half Twilio's per-message price.
- **WhatsApp:** Meta's **WhatsApp Cloud API** directly, with no middleman markup. Replies inside the 24-hour customer-service window are free. Fits ADR-0010.
- **Email:** Resend (free tier) as in the spec.
- **Caching and rate limits:** **no Redis for now.** Next.js caching with per-store tags, and Better Auth's rate limiter stored in Postgres. Add Upstash (free tier) only when Postgres-based limits show load.
- **Monitoring:** **Sentry** free developer tier for errors, Vercel's built-in logs, and Inngest's run history. Uptime checks on webhook endpoints.

## Consequences
- Two messaging integrations (Telnyx, Meta) instead of one (Twilio). Keep both behind one notifications interface so a provider can be swapped.
- WhatsApp business-initiated templates (order updates) are billed per message by Meta, so prefer replies inside open conversations and SMS for one-off texts, whichever is cheaper.
- Set budget alerts on Telnyx, Meta, Vercel and Inngest from day one (and on any paid maps service if #398 moves to one).
