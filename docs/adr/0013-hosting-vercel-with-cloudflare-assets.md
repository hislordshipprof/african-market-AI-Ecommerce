# 13. Next.js on Vercel, with Cloudflare for images and DNS

Date: 2026-10-30 · Status: accepted

## Context
Storefronts need fast server-rendered pages that Google can index, one custom domain per store (ADR-0003), and preview deploys. Product photos will be most of the bandwidth. Cloudflare was compared because it's cheaper at scale.

## Decision
- **App:** Next.js (App Router, TypeScript) on **Vercel Pro**. Storefront, store admin and API routes live in one app. Middleware resolves the store from the request's host name.
- **Custom domains:** added through the Vercel domains API. Pro allows unlimited domains per project (100k soft limit).
- **Images and files:** **Cloudflare R2** (no egress fees) behind Cloudflare's image resizing CDN. Proof photos live in a private R2 bucket served through signed URLs.
- **DNS:** Cloudflare.
- **Not chosen: all-in Cloudflare.** Next.js runs on Workers only through an adapter (OpenNext, which Cloudflare is replacing with vinext), and Node.js middleware is unsupported. That's too much churn under the core app.

## Consequences
- Keep the app portable. Use no Vercel-only APIs except domains, keep storage behind an interface, and read config from env vars, so moving the app to Cloudflare or containers later is a deploy change.
- Best practices: follow the `vercel-react-best-practices` skill (no request waterfalls, small client bundles, server components by default). Cache storefront pages per store and tag them by store ID, so a price change revalidates only that store.
- Cost watch: function invocations and bandwidth on Vercel. Images are offloaded to R2 to keep Vercel bandwidth low. Set Vercel spend alerts.
- Vercel's domain-add API is rate-limited, so onboarding queues domain adds instead of doing them inline.
