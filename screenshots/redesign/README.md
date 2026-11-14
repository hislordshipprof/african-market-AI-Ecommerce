# Redesign screenshots

## Design round 4 - capture blocked

On 2026-11-01, the updated capture runner reached Chromium launch and failed with spawn EPERM. No round 4 screenshots or recording were produced. The connected browser inventory was also empty. Historical screenshots are not evidence of round 4.

The current scripts/capture-storefront-redesign.mjs writes round4-* files: home top/middle/bottom, category and product at 390, 1024, 1440 and 1920px in light and dark (40 requested images), plus quick view and 404 at each size/theme (16 additional images). Normal motion is enabled; the hero is explicitly paused for still captures. The video in round4-motion/ includes page scrolling to show reveals and the scroll-linked band. round4-checks.json records image loading, horizontal overflow and browser errors.

After pnpm build, start the preview with E2E_STORE_OVERRIDE=1, NEXT_PUBLIC_DEMO_FLOWS=1 and VERCEL_ENV=preview. Run node scripts/capture-storefront-redesign.mjs, then stop the preview server with Ctrl+C. Run pnpm test:e2e --workers=1 for the geometry, keyboard, hydration, reduced-motion and existing throttled LCP gates. The <2500ms assertions are unchanged. No current LCP measurement is available.

The sections below describe historical capture runners.

## Phase 3 — capture blocked

The final Phase 3 runner was attempted on 2026-10-31. Chromium exited at launch with `spawn EPERM`. No Phase 3 screenshots, video, or transition frames were produced. Existing images are not evidence of the current implementation; they have not been relabeled as new captures.

After a normal `pnpm build`, start one preview server with `E2E_STORE_OVERRIDE=1`, `NEXT_PUBLIC_DEMO_FLOWS=1` and `VERCEL_ENV=preview`. Run `node scripts/capture-storefront-redesign.mjs` in another terminal, then stop the server with Ctrl+C.

The current runner replaces 28 images: home top/mid/bottom, category, product, quick view and branded 404, each at 390px and 1440px in light and dark. It checks visible image loading, horizontal overflow and browser errors; writes `phase3-checks.json`; and captures a short WebM plus four hero transition frames and three hover-tilt frames. Reduced motion freezes the still-image captures; the motion capture explicitly enables motion.

Run `pnpm test:e2e --workers=1` for interaction gates and real-image LCP tests. The LCP test disables browser cache, uses 1.6 Mbps down / 750 Kbps up / 150ms RTT and 2× CPU throttling, and retains the `<2500ms` assertions. No LCP numbers are available from this sandbox.

The older instructions below describe historical Phase 1/2 attempts, not the current Phase 3 screenshot set.

The 24-image capture was attempted against the production server on 2026-10-31. Chromium failed to launch with `spawn EPERM`; manually launched CDP browsers also could not render. **No screenshots in this directory are claimed as captured or visually reviewed.** Older PNGs in the parent directory predate this rebuild.

On a machine where Playwright Chromium can run, use PowerShell:

```powershell
pnpm build
$env:E2E_STORE_OVERRIDE='1'
pnpm start
```

In another terminal:

```powershell
node scripts/capture-storefront-redesign.mjs
pnpm test:e2e --workers=1
```

The runner requests `?store=mama-ngozi` using the existing test/preview override. It produces home, category, search, product, collection and cart images at 390/1440 px, light/dark, with a `checks.json` manifest. It also checks browser errors, horizontal overflow and image loading. No proxy changes are needed.

## Phase 2

The 48-image customer-journey capture was attempted against `pnpm start`. Chromium again failed at launch with `spawn EPERM`; **no phase 2 PNGs were produced**.

Enable the demo server for capture:

```powershell
$env:E2E_STORE_OVERRIDE='1'
$env:NEXT_PUBLIC_DEMO_FLOWS='1'
$env:VERCEL_ENV='preview'
pnpm start
```

In another terminal run `node scripts/capture-customer-journey.mjs`. The runner creates the demo Order and Account through the UI, then captures cart, checkout, declined payment, confirmation, tracking, substitutions, chat, issue report, sign-in, code entry, account and account order detail at both requested widths and themes. It writes `phase2-*.png` plus `phase2-checks.json`. Every navigation is scoped to `?store=mama-ngozi`; no real payment or message is sent.

`pnpm test:e2e --workers=1` uses the demo server on port 3000 and a separate production-gated server on port 3001. Both require an existing production build. In CI, supply those servers (and optionally PRODUCTION_FLOW_URL) before the test run.
