# 16. Inngest for background jobs; Web Push and polling for live updates

Date: 2026-10-30 · Status: accepted

## Context
The platform needs durable timers and retries: the substitution prompt timeout, courier failover from DoorDash to Uber (ADR-0006), stock-confidence decay (ADR-0009), daily digests and webhook retries. Staff need to see new orders quickly, and customers need to see substitution prompts. Keep cost as low as possible.

## Decision
- **Jobs:** **Inngest Cloud, free tier** (about 50k runs a month per third-party listings; confirm on Inngest's pricing page). Functions run as Vercel routes, so there's no worker server. Its server is source-available (SSPL, converting to Apache 2.0), so self-hosting it is the fallback if cost grows.
- **Live updates, v1:** **Web Push** (free browser standard, MIT `web-push` library) and SMS for alerts that must reach people with the app closed. Light polling (~10 s) on open order boards. Uber and DoorDash tracking pages for courier location.
- **Later:** self-hosted **Centrifugo** (Apache 2.0) when a screen proves it needs instant updates.

Not chosen: pg-boss (free, but needs an always-on worker that keeps Neon awake, and more code for multi-step flows), Trigger.dev self-hosted (we'd run Postgres, Redis and its dashboard), Ably or Pusher (per-connection pricing before any screen needs it), and Soketi (AGPL, unmaintained since March 2025).

## Consequences
- Estimated Inngest cost: $0 through the pilot, ~$50–100 a month around 1,000 stores. Set a usage alert at 70% of the free tier.
- Every job step must be idempotent (safe to retry), keyed by order or delivery ID.
- Polling load at target is modest (1,000 stores × a few open boards ÷ 10 s ≈ a few hundred requests a second at peak). Serve it from a cheap, cached endpoint, and switch boards to Centrifugo if it becomes costly.
