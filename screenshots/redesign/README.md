# Redesign screenshots

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
