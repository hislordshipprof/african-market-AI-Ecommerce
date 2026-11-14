# Phase 3 storefront implementation plan

**Goal:** Implement the user's Phase 3 brief on the existing Palm & Shea storefront.
**Architecture:** Extend the shared shell, card, image, rail, sheet and catalog projections. One LazyMotion provider owns storefront animation. Keep all existing route, cart, tenant and journey contracts.
**Spec:** User's Phase 3 motion, depth and imagery request in this session.
**Tech stack:** Next 16, React, Motion, PostgreSQL/Prisma, Playwright, Vitest; offline Python/rembg only.

## Constraints and decisions

- No git commit, push or branch commands; no auth, admin, RLS, proxy, store resolution or payment changes. Listing cache invalidation is the narrowly requested mutation hook.
- Keep 15% default tip. Respect reduced motion, focus, touch and visible carousel pause controls.
- Images: manifest is present but research/catalog/master-catalog.csv is absent. Restore a traceable source CSV from the manifest; replace prepared meals with verified ingredient images.
- Animate opacity/transforms only. Hero background priority; other home images lazy. No fake production reviews or invented live discounts/counters.
- User supplied a concrete build specification; implementation is already authorized. No extra design approval gate.

## Tasks and checks

- [x] 1. Regression tests for autoplay gates, cache tenant keys/invalidation, search ranking and photo aliases; 920 tests pass through the sandbox-compatible runner.
- [x] 2. Offline processor, credits and seed/catalog mapping ready; outside-app venv blocked by ensurepip PermissionError. Zero alpha outputs; contain fallback retained.
- [x] 3. LazyMotion primitives, full-bleed layered hero, progress/autoplay controls, marquee and pointer-drag rails implemented.
- [x] 4. Product tilt/zoom, quick view, cart flight, shared image navigation and filter transitions implemented; browser validation blocked.
- [x] 5. Deals, category tiles, coverflow, demo reviews, sticky story/counts, textures/reveals and header shrink implemented.
- [x] 6. Branded 404, designed credits, UTF-8 repair and cache/search fixes implemented.
- [ ] 7. E2E and capture runners updated and all five commands attempted. Browser gates, screenshots and LCP blocked by spawn EPERM; standard test/build startup also needs subprocess permissions.
- [x] 8. Independent code review, dual-agent Impeccable critique and source polish completed. Report records unresolved visual target and other gaps; servers stopped.

## Review focus

1. Carousel pause reasons must combine independently; reduced motion never autoplays.
2. Store cache entries cannot cross tenants; invalidation must evict cached empty responses.
3. Exact/local-name search wins over fuzzy matches; short incidental trigram matches are excluded.
4. Quick view must trap/restore focus, expose pack prices and share the existing cart store.
5. Duplicate product cards must not create duplicate view-transition names; sample reviews must be denied in production.

## Evidence ledger

- Initial browser capability check: Playwright Chromium launch fails with spawn EPERM. No screenshots or LCP claimed from this check.
- Next local docs read: caching/revalidateTag, not-found, view transitions. Installed React capability checked before choosing shared-element implementation.
- Final Next production build passed with the opt-in worker-thread build configuration; typecheck and lint passed. Full alternate suite: 920/920 tests in 28 files. HTTP smoke: 12 preview + 3 production checks passed.
- Impeccable: 25/40 provisional source assessment, 179 static advisories; visual quality >=8/10 per heuristic remains unverified. See CODEX_REPORT.md for the complete status matrix.
