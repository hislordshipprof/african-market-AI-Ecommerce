# Storefront redesign implementation plan

**Goal:** Implement the owner's storefront redesign brief using the existing Next 16 storefront services and DESIGN.md.

**Architecture:** Server-rendered shopping pages with client islands for cart, carousel, search, filters and size selection. Keep store resolution, auth, admin, payments and RLS unchanged. Reuse banners, collections and demo listings. No git commit, push or branch commands.

**References:** DESIGN.md, PRODUCT.md, GLOSSARY.md and all three research/ui reference documents. The detailed user brief is the approved scope; this file records implementation decisions.

## Tasks

- [x] Shared shopping controls: store-keyed CartStore/localStorage, quantity stepper, count, accessible animated responsive Sheet, bottom navigation. Unit tests cover corrupt persistence, quantities and store isolation.
- [x] Image catalog and visual foundations: match master catalog names to Commons assets, add credited Unsplash editorial photos, remove demo alcohol, build theme-aware primitives and product cards.
- [x] Home and shell: sticky header, split carousel, photo bento, labeled rails, collection banners, delivery band and expandable store story with sorted hours.
- [x] Browse flow: category chips/filter/sort, instant search/history, detail gallery/variants/stats, collection page and shared loading/empty/error states.
- [ ] Validate: typecheck, lint, unit/integration tests, production build, Playwright interaction coverage and screenshots at 390/1440 in light/dark. Record actual outcomes and gaps in CODEX_REPORT.md.

Validation implemented and attempted. Typecheck/lint pass; 882 tests and the complete Next build pass with local process-launch workarounds. Playwright execution, screenshots and LCP remain blocked by Chromium `spawn EPERM`; see CODEX_REPORT.md. No visual completion claim.

## Review focus

Store changes must never leak cart lines. Missing/invalid storage must not break shopping. Variant IDs and prices must agree between quick-add and detail. Stock and promotional claims must follow existing data. Reduced-motion, focus restoration and mobile safe areas apply to all floating controls. Demo photographs must not be represented as actual owners or stores.
