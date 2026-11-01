# Storefront redesign report

Implemented the customer storefront rebuild using the existing store theme, scoped services, banners, collections and catalog. Auth, admin, store-admin, proxy/store resolution, RLS policies and payment code were not changed. No commit, push or branch commands were run.

## Screens and reference patterns

| Screen / section | Built | Reference pattern |
|---|---|---|
| App shell | Store-colored sticky header, logo/name, pickup estimate and ZIP chip, search, live cart count; desktop aisle navigation; floating mobile navigation with expanding active label; footer | Delivery teardown: persistent context, search and cart. A1/A3: strong brand header. DESIGN.md Palm & Shea tokens |
| Home hero | Split promo and smaller photographic offer; three seeded slides per store; separate dots/arrows, swipe, Left/Right/Home/End keyboard controls; no autoplay | A1 Dodolland / A3 Smart Food Delivery: asymmetric promotional hierarchy; delivery teardown: manual carousel |
| Category mosaic | Real ingredient photography, local-name eyebrows, bento layout, full all-aisles page | A4/A5 grocery category discovery; market review: familiar ingredients and local language |
| Product rails | Popular picks, Fresh in, Pantry sorted; label blocks, snap scrolling, desktop arrows, about 2.2 visible mobile cards | Delivery teardown: compact grocery tiles and quick add; owner references: editorial label blocks |
| Collections | Photographic home banners and dedicated scoped collection pages with descriptions and product grids | A1/A5: curated promotional cards; market review: meal-oriented shopping |
| Dark promo band | Store-banner offer, store delivery information and a licensed cut-out yellow chili photograph | DESIGN.md dark promo treatment; owner references: produce-led promotion |
| Store story | Credited market photograph, owner text with Read more, years open when present, neighborhood, Monday–Sunday hours, pickup/radius facts and swap promise | Market review: neighborhood trust and specific cultural cues |
| Category | Desktop aisle sidebar/mobile sticky aisle chips, In stock/Frozen/Pack size filters, sort, responsive grid, clear-filter empty state | Instacart/Weee! browse density and filter conventions |
| Search | Debounced and abortable instant results, local-name highlighting, keyboard shortcut, recent searches per store, popular suggestions, no-results/error treatments | Delivery teardown: immediate search feedback and local synonyms |
| Product | Main photograph, local/English names, selectable real pack variants, price/unit price, stock, origin/size/storage facts, description, related rail and sticky mobile add bar | Delivery teardown: pack choice and persistent add action |
| Cart | Desktop right drawer/mobile bottom sheet, line stepper/remove, placeholder swap-rule pill, subtotal, minimum-order progress and disabled “Checkout coming soon” | DESIGN.md swap pills; delivery teardown: persistent basket and accessible sheets |
| States | Route loading skeletons, themed empty/error/not-found views and account placeholder | DESIGN.md feedback states and 1.3-second shimmer |

## Components and behavior

Shared components live in `src/components/storefront/`: `StorefrontShell`, `Button`, `Chip`, `Badge`, `SectionHeader`, `EmptyState`, `ProductImage`, `ListingCard`, `PriceDisplay`, `ProductRail`, `RailScroller`, `Sheet`, `CartProvider`, `CartTrigger`, `QuickAddStepper`, `MobileNav`, `FulfillmentChip`, `ProductListMotion`, `ProductDetail`, `RecentSearches`, loading/error/not-found helpers, plus rebuilt home sections.

`src/lib/storefront/cart-store.ts` defines the replaceable `CartStore` interface. It namespaces localStorage by Store, distinguishes Listing variants, validates stored values and image URLs, handles denied/corrupt storage, synchronizes storage events, and exposes stable snapshots for React. Prices are client display snapshots; ticket #9 must revalidate them with server persistence. No checkout or payment is implemented.

Pack filtering considers every variant, including the “Each” fallback. A chosen pack also changes the displayed card price and quick-add variant. Search results retain actual frozen/perishable flags. All new storefront reads stay in the existing scoped service layer.

Motion uses the installed `motion` package: spring quantity expansion, cart count bump, carousel transitions, sheet entry/exit and 30 ms list stagger capped at eight positions. Button/chip press feedback and skeleton shimmer respect reduced motion. Native dialog focus trapping, Escape, focus restoration, visible focus rings, labeled navigation and a stable polite cart announcement are implemented. Browser-level accessibility verification remains outstanding.

## Photography and seed

- Added `images.unsplash.com` and `upload.wikimedia.org` to the existing remote image allowlist.
- Matched Listing names to the supplied verified master catalog. `catalog-media.json` retains the image, source page, author, license, description and local-name metadata. It is imported by server services, not shipped as a client catalog.
- **`public/images/CREDITS.md` is updated** with 40 distinct catalog Commons photographs, five Unsplash editorial photographs, and Tiia Monto’s CC BY-SA 4.0 yellow chili cut-out. The regeneration script includes license links.
- Editorial photography includes food by Keesha’s Kitchen, Bodija Market by Tunde Buremo, dried fish by Brah Lyrix and spices by Vincent Bélanger. No generated people or fictional owner portrait is used.
- Legacy food SVGs are retired from customer screens. Missing or failed Listing photos use a patterned, theme-colored initial tile. Cart and instant search share this fallback.
- The first hero photograph is preloaded. Product detail preloads its main photograph. Other photos are lazy and have responsive sizes.
- Palm wine was removed from future demo catalog creation. Existing seeded palm-wine Listings are deactivated within store scope to preserve historical references. Seed completed: 47 master products, 49 Listings per demo Store (48 active, one inactive), six banners and seven collections.

## Verification

| Check | Result |
|---|---|
| `pnpm typecheck` | Passed; final verification recorded below |
| `pnpm lint` | Passed; final verification recorded below |
| `pnpm test` | Standard command blocked while loading Vitest config: esbuild `spawn EPERM` |
| Alternate unit/integration run | Native config loader, TypeScript transpilation, thread pool and preserved symlinks avoid blocked launches. Final consolidated run: **23 files, 882 tests passed, zero failures or skipped tests** |
| Storefront service regression | 22 tests passed, including added assertions that all pack labels/prices remain available |
| `pnpm build` | Prisma generation passes; existing `prisma migrate deploy` stops at schema-engine `spawn EPERM` |
| Full Next production build | Passed with temporary `workerThreads: true`, `cpus: 2`, `useTypeScriptCli: false`. This still runs TypeScript and all page generation. Temporary options are restored afterward; no type-error bypass was used |
| Production HTTP checks | Home, categories index, category, search, product and collection returned 200 for Mama Ngozi through the existing `?store=` opt-in. Instant `ugu` search returned the scoped Listing and new metadata |
| `pnpm test:e2e --workers=1` | Blocked before tests: `spawn EPERM` |
| Screenshot run | `node scripts/capture-storefront-redesign.mjs` attempted against `pnpm start`; Chromium launch fails with `spawn EPERM`. Manual CDP launches also failed to render. No new screenshot PNGs were produced |
| Remote image checks | Editorial and cut-out GETs succeeded. Catalog HEAD checks received 200 for four originals and 429 for 36; bulk verification is rate limited. Failed image display has a designed fallback |

Added seven Playwright tests in `e2e/storefront-redesign.spec.ts`: carousel controls/keyboard, quantity/cart drawer, in-stock filtering, frozen/pack filtering, instant synonym search, pack price/cart selection and mobile navigation. The existing detail stock-badge assertion was scoped to the product detail because related cards now have their own badges; the assertion was not weakened.

The screenshot runner targets all six requested screens at 390 px and 1440 px in light/dark (24 PNGs), waits for fonts/images, checks horizontal overflow and page errors, and writes a manifest. See `screenshots/redesign/README.md` for the exact command sequence. Existing older screenshots were not relabeled as redesign evidence.

## Known gaps / review still required

1. Visual approval at 375/390, 768, 1024 and 1440 px, browser E2E execution, keyboard/screen-reader verification and the **LCP <2.5 s throttled-4G target are not verified** because a usable Chromium renderer could not be launched. Server compilation and HTTP checks are not substitutes for these checks.
2. Demo Stores have no verified owner portraits. The story uses an explicitly captioned real market photograph and labels fictional demo stories. Supply an authorized owner photo through the existing field for a real Store.
3. Catalog imagery is representative ingredient photography, not verified brand packshots. Detail pages label prepared-dish imagery as serving suggestions. The current catalog supplies one photograph per Listing, so detail uses one large image rather than inventing gallery angles.
4. No purchase history or restock timestamps exist in the retained model. “Order again” and “Back in stock” were not fabricated; the home uses Popular/Fresh/Pantry rails. There is no nested subcategory model; mobile chips navigate actual Categories.
5. Account remains a designed placeholder; ZIP is a UI preference and does not promise serviceability. Checkout is deliberately disabled, and swap rules remain placeholder UI as requested.
6. Commons may throttle image optimization on a cold cache. Validate images and performance on the intended deployment before launch.
7. Automatic approval review rejected recursive cleanup of temporary validation directories with “blocked by policy.” They remain under ignored `.validation-*` paths; temporary experiments are excluded from lint and the proposed source diff.

## Final verification

- Final `pnpm typecheck`: exit 0.
- Final `pnpm lint`: exit 0.
- Full Next production build after the photo-error fallback and not-found views: exit 0; TypeScript and all 17 static-generation work items completed. Original Next config restored.
- Consolidated unit/integration run: exit 0, 882/882 tests, 23 files. JSON evidence is retained locally in `.validation-artifacts/test-results.json`; the temporary compiler config is archived beside it.
- Production preview is running at `http://localhost:3000/?store=mama-ngozi` with the existing local E2E override enabled.
- Screenshot/LCP/browser E2E status remains **blocked**, not passed. The implementation is ready for browser review, not yet visually approved for launch.

## Phase 2 — the customer journey

Phase 2 supersedes the phase 1 Account/disabled-checkout placeholders described above. The journey is implemented against guarded browser-only simulations; real orders, payments, authentication and messages are not sent.

### Screens and shared design-system check

| Screen | Built | Shared components / reference pattern |
|---|---|---|
| `/cart` | Store-grouped lines, quantity limits, minimum progress, estimated totals, exact/suggest/chosen swaps, same-category alternatives, related rail, mobile checkout bar | StorefrontShell, FlowHeading/Card, QuickAddStepper (extended with a maximum), ProductImage, Sheet, Chip, FeeLine/PriceDisplay, ListingCard, RailScroller; Musemind A5 Replace with row |
| `/checkout` | Pickup, eligible delivery/courier, contact with required phone, demo address lookup, notes/handoff rules, pickup slots, promo, editable tip, quote/tax/buffer disclosure, test payment and recoverable failures | Shell, FlowHeading/Card, Chip, AddressCard, FeeLine, PayButton, FlowError; A5 address thumbnail and fill-then-check confirmation |
| `/order/[token]?placed=1` | Confirmation, order number, hold explanation, next steps, pickup address/ETA, tracking and account links | FlowHeading/Card, SuccessMark, AddressCard, FeeLine; single spring confirmation, reduced-motion aware |
| `/order/[token]` | Five-second polling, full future timeline/current step, preparation estimate, substitution pending, demo cancellation, courier card, sample proof, final versus held amount, chat/report links | Reusable OrderFlow, FlowCard, ProductImage, AddressCard, FeeLine, Sheet, Button; store-owned branding |
| `/order/[token]/substitutions` | Original/proposed items, line price difference, ten-minute countdown, side-by-side Swap/Refund, saved timeout rule and resolved state | SubstitutionCards reused on tracking, FlowCard, ProductImage, Button, FlowError; DESIGN substitution prompt |
| `/order/[token]/report` | Issue type, fulfilled-line selection, optional local photo preview, description, net refund preview, 48-hour window and review threshold | FlowHeading/Card/Error, Button, shared settlement/refund calculations; refunded lines cannot be refunded again |
| `/account/sign-in` | Labelled SMS/email-link simulation, two-step code entry, credited market-photo story | FlowHeading/Card/Error, DemoNotice, Button; existing static photo direction (the existing 3D story feature remains disabled) |
| `/account` | Shared demo identity, profile editing, saved addresses, current Store order history, sign-out/re-sign-in without losing saved details | FlowHeading/Card, AddressCard, FlowToast, EmptyState, Button; A5 dark contextual toast |
| `/account/orders/[id]` | Scoped order lookup and the same tracking/detail presentation | OrderFlow, with no separate detail implementation |
| Store chat | Message sheet and explicit local preview; nothing is sent | Existing Sheet and Button, shared field styles |

The additions extend Palm & Shea and the existing Store theme variables, Bricolage Grotesque/Figtree, surface radii, focus rings and reduced-motion handling. New shared pieces live in `src/components/storefront/flow/common.tsx`, `feedback.tsx` and `flow.css`: FlowHeading, FlowCard, DemoNotice, ClosedFlow, FeeLine, AddressCard, FlowError, FlowLoading, FlowToast, PayButton and SuccessMark. Dedicated CSS handles each screen's layout; it does not introduce another palette. Existing Sheet close labels now describe their actual dialog. PriceDisplay handles negative promo amounts correctly.

### Adapters, persistence and replacement seams

`src/lib/customer-flow/contracts.ts` defines CheckoutService, PaymentForm, AddressLookup, OrderTracking, SubstitutionService, AuthService and IssueService. `createDemoServices(settings, catalog, enabled)` supplies the fake implementations. Server route wrappers obtain their Store and serializable catalog through `getFlowContext()`; the new `getFlowCatalog()` read is next to existing storefront queries and uses `storeScoped()`. Its database integration test verifies tenant isolation, active Listings and variant metadata. No schema, RLS, proxy, admin, real auth or payment implementation was changed.

The server gate and factory guard keep fake execution out of production: VERCEL_ENV=production always denies, even if the public demo flag is accidentally set. Otherwise development, VERCEL_ENV=preview, or explicit NEXT_PUBLIC_DEMO_FLOWS=1 allows the demo. An unset deployment environment on a local production build is denied unless explicitly enabled. Every new route renders the same polished “Checkout opens soon” view when disabled.

Orders use random UUID tokens and Store-scoped localStorage. Demo identity is shared on the same browser origin, with saved profile records separate from the signed-in session. Swap choices are frozen per Order. Storage readers reject malformed nested values and provide a memory fallback when localStorage is unavailable. These are demonstration interfaces, not production authentication or cross-device bearer-link security.

The quote validates quantities, availability, required contact, minimum spend, scheduling, radius, 50 lb courier limits, insulated packaging and frozen handoff. Provider quote and tax are explicitly simulated. The 10% hold buffer is capped at $20. Substitutions validate the resulting basket and tax-adjusted hold before offer, consent and timeout. Final tax/discounts and issue refunds derive from fulfilled lines, excluding previously refunded lines. Early cancellation releases the simulated hold.

For tickets #9–#18, replace the service factory with server-backed implementations of these interfaces and replace demo Store settings/address fixtures with scoped operational data. PaymentForm accepts no card data; mount Stripe's Payment Element in the test-payment container in #10 and return an authorization through the interface. Replace AddressLookup with Places in its later ticket; replace polling/demo advancement with authenticated tracking/notification services. Preserve the shared UI and move authoritative validation to the server. CartStore remains the phase 1 persistence seam; swap-rule persistence is isolated in `rules.ts` for #9.

### Images

No uncredited images were added. Sign-in reuses the credited Bodija market photograph; all product surfaces reuse the phase 1 Commons catalog. `public/images/CREDITS.md` records phase 2 reuse. Maps are clearly labelled schematic demo maps. Delivered-order proof uses a plainly labelled sample Listing photograph until a real proof adapter exists. Uploaded issue photos are local previews only.

### Phase 2 verification

| Check | Result |
|---|---|
| `pnpm typecheck` | Passed; final run repeated after integration |
| `pnpm lint` | Passed; final run repeated after integration |
| `pnpm test` | Standard startup blocked by esbuild `spawn EPERM` |
| Full alternate unit/integration suite | **903 tests in 24 files passed**, no failures or skipped tests; native config loader + TypeScript transpilation + worker threads, JSON at `.validation-artifacts/phase2-test-results.json` |
| New domain tests | 20 tests: production gate, quotes, limits, tenant tokens, state transitions, timeouts, immutable rules, net settlements/refunds, hold cap, saved identity, corrupt/blocked storage and replacement eligibility |
| `pnpm build` | Prisma generation passed; existing migrate-deploy step blocked by schema-engine `spawn EPERM` |
| Full Next production build | Passed using temporary workerThreads/cpus/useTypeScriptCli options; TypeScript and all 20 static-generation work items ran. Original config restored afterward |
| Production HTTP gate | 16/16 checks passed: eight new routes in demo mode and the same eight in production; production showed “Checkout opens soon” |
| `pnpm test:e2e --workers=1` | Attempted; blocked before browser tests by `spawn EPERM` |
| Screenshots | `node scripts/capture-customer-journey.mjs` attempted against `pnpm start`; Chromium launch blocked by `spawn EPERM`. **No phase 2 PNGs produced** |

`e2e/customer-journey.spec.ts` adds the full add → swap preference → pickup checkout → fake pay → confirmation → tracking → substitution approval journey, payment-failure retry/cart retention, and production gating across all new routes. The existing assertions were retained. Playwright config starts a demo server plus a separate production-gated server. The screenshot runner creates its Order and Account through UI interactions and targets 12 states × 390/1440 px × light/dark = 48 images, with a manifest checking page errors and horizontal overflow.

### Remaining gaps

- Browser E2E, actual screenshots, visual approval at the requested widths, WCAG browser checks and throttled-4G LCP remain unverified because Chromium cannot launch in this environment. Successful compilation and HTTP checks do not prove these.
- Demo addresses/maps, opening-status fixture, delivery availability/fees, 6% tax, provider quote, proof photo, account and messages are deliberate simulations. Store time-zone/calendar, tax jurisdictions, real courier quotes, notifications and payments await the tickets named in the brief.
- Tracking links, profiles and saved addresses only persist in the creating browser origin. Account history is scoped to the current Store. Cross-domain/cross-device platform accounts require the later real AuthService and persistence.
- Pickup scheduling supplies demo 10 AM slots within six days; real capacity and Store-hour validation await checkout integration. The Store-closed view is implemented against FlowStore.closed, which defaults to an open demo fixture.
- Issue submission stores a simulated outcome, not an uploaded photo or real refund. The proof surface intentionally does not misrepresent a product photograph as an actual delivery photograph.
- Sign-in uses the licensed static market-photo fallback. No new 3D scene was introduced; the repository's existing StorySurface has ENABLE_3D_SCENE=false pending its separate fidelity work.
