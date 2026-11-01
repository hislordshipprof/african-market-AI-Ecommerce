# Customer journey implementation plan

The user's phase 2 brief and DESIGN.md are the approved specification. Extend the phase 1 system in this existing worktree; no git commits, pushes, branch commands, auth/payment integration or database schema changes.

## Architecture and decisions

Server route wrappers resolve the Store and demo gate. Client islands receive serializable Store settings and scoped catalog metadata. A single typed adapter bundle supplies checkout, test payment, address lookup, order tracking, substitutions, customer identity and issue reporting. Fakes persist only demo data in the browser. Real integrations replace these adapters in later tickets.

Production Vercel deployments always deny demo execution, including an accidentally set public flag. Otherwise only development, explicit preview, or NEXT_PUBLIC_DEMO_FLOWS=1 enables it. An unset VERCEL_ENV on a local production build is not treated as preview. Server rendering and adapter creation both enforce the gate. Existing auth remains untouched.

One Order belongs to one Store. Tracking tokens use crypto.randomUUID; no predictable token grants access to persisted order data. Browser-local demo links are deliberately not presented as cross-device real tracking. State transitions are explicit demo controls with polling observations. Fee quotes, tax, addresses, maps, messages and payment are labeled simulations. No card-number input or external message submission.

Courier eligibility follows 50 lb item/order limits, radius and confirmed insulated packaging for frozen items. No leave-at-door for frozen. Buffer is 10%, capped at $20. Pickup scheduling is limited to six days. A positive-price swap requires consent and cannot exceed the hold. Issue reporting is within 48 hours of completion, with review above the Store limit.

## Tasks / ownership

- [x] Domain: typed adapters, guarded fakes, order persistence/state transitions, quote/eligibility math and unit tests.
- [x] Cart and checkout: full cart, per-line swap sheet, scoped catalog metadata, fulfilment/contact/address/time/summary/test payment and drawer links.
- [x] After ordering: confirmation/tracking, substitutions, issue form, chat sheet, shared tracking presentation and route states.
- [x] Shared UI/account: extend existing primitives with flow cards, fee lines, map thumbnail, toast, pay confirmation and account/profile/address screens. No forked palette.
- [x] Independent review, domain/integration tests, production build and HTTP gate checks; whole-journey E2E and screenshot runners authored; CODEX_REPORT.md updated.
- [ ] Browser E2E, actual screenshots, visual/accessibility/LCP verification: blocked by this environment's process-launch restriction (spawn EPERM), documented in CODEX_REPORT.md.

## Visual direction

Continue Palm & Shea, Bricolage Grotesque and Figtree. Dense shopping detail within calm surface cards, a narrow readable content column plus desktop summary. Use Musemind A5's per-line Replace with row, fill-then-check payment feedback, dark contextual toast, store-grouped basket and compact address map. Schematic maps are labeled demo maps rather than fabricated geographic imagery. Reuse all licensed phase 1 photos, ProductImage fallbacks, Sheet, PriceDisplay, Button/Chip/Badge and loading/empty states.
