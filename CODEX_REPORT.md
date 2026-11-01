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

## Phase 3 — motion, depth and imagery

Implemented on 2026-10-31. **Source implementation and non-browser verification are substantially complete; Phase 3 is not fully accepted.** Actual background removal, browser interaction verification, replacement screenshots, motion recordings, measured LCP and the requested visual-quality score remain blocked or unverified. No commit, push or branch commands were run. Every server started for this phase was stopped.

### Deliverable status and reference patterns

| Request | Status and implementation | Reference pattern |
|---|---|---|
| Clean product imagery | **Partial.** Shared ProductImage now uses contain sizing, theme-tinted tiles and a contact shadow. Replaced meal/poor product mappings, repaired related-product name lookup, and added the offline rembg pipeline. No transparent WebPs were generated in this sandbox. | Shopery / Shopify Grocery cut-outs on quiet tiles |
| Hero and banner photography | Atmospheric, full-bleed backgrounds remain distinct from product photography. Foreground product is layered above the photo; it still retains its source background until processing succeeds. | Danlex / FreshMart layered editorial depth |
| Full-width hero | Removed the enclosing content-width box. Stage spans its parent edge to edge, 600px desktop / 460px mobile; content keeps the shared grid. Background crossfade/Ken Burns, oversized Bricolage word, spring product entrance, staggered text, glass reassurance pills and circular text badge. Long copy can scroll within reserved copy space. | Danlex full bleed; FreshMart display behind subject; Shopify Grocery pills/badge |
| Hero controls | Six-second autoplay, per-slide transform progress, swipe, arrows, Home/End and arrow keys; independent hover, focus, off-screen, hidden-tab, explicit pause and reduced-motion gates. Badge and background motion pause with the slideshow. | Accessible interpretation of reference motion |
| Offer beside hero | One desktop offer tile overlaps the lower hero area. Mobile omits this secondary tile. **No separate bento promo grid or two-stacked-offer composition was added.** | Shopery adjacent offer treatment, partial |
| Marquee | Two opposing infinite ingredient-name rows on desktop, one on mobile; hover/focus pause and explicit pause/play. Static wrapping names under reduced motion. | Danlex local-name band |
| Deals carousel | Accent-tinted cards with imagery breaking above the card edge, percent circles and shared quick-add. Explicit sample offers are limited to demo stores in demo mode; actual displayed demo prices remain authoritative. Production has no invented discounts. | Dribbble Food Website / Shopify Grocery |
| Category carousel | Rounded ingredient-photo tiles, local-name eyebrows, snap scrolling, arrows, keys and desktop pointer drag. | Shopery soft category tiles |
| Product rails | Popular picks, Fresh in, pantry and Back in stock demo rails reuse the shared card. Production uses Shelf favorites, Fresh ingredients and Available today because no popularity/arrival/restock event data exists. | Shopery card hover and Shopify Grocery ingredient rails |
| Collections / recipes | Desktop perspective coverflow with large selected card and receding sides; mobile snap rail. Buttons, keyboard navigation and scroll-selected state agree. Collection photos use small parallax offsets. | Food Website editorial collections with requested coverflow |
| Reviews | Sample review carousel is visibly labeled fictional and disappears in production even with the public demo flag enabled. No production review source was invented. | Shopify Grocery testimonials |
| Scroll reveals | Shared section reveal: opacity + 24px rise, once at 20% visibility. Product children stagger at 30ms, capped at eight. Visible server-rendered defaults preserve content before JS. | Danlex fade/rise sections |
| Parallax and header | Banner/collection image offsets are -20px to +20px. Header compact state starts after 40px and uses transforms plus a blur backdrop without changing document layout. | Requested scroll depth |
| Owner story | Sticky desktop photo with successive text sections; one-shot counters with reserved text width. Years derive from the existing story, product count from listings, delivery miles from the store. **No neighborhood count exists; delivery radius is shown instead.** Mobile uses normal flow. | Editorial sticky split |
| Cart motion | A loaded product thumbnail flies toward the existing cart trigger; the trigger bumps. Cart state updates synchronously and a polite live region announces count. No decorative flight under reduced motion. | Requested shopping feedback |
| Page / filter transitions | React 19.3 ViewTransition shares the selected card image with product detail; selection is unique across repeated cards and excludes modified/new-tab clicks. CSS opacity fallback remains. Results use AnimatePresence and position layout animation. | Requested shared-element continuity |
| Motion bundle | Shared LazyMotion uses domAnimation and `m` components. Result grids asynchronously load the separate layout feature/renderer because domAnimation alone does not implement `layout`; home rails do not request that extra feature. Quick view is dynamically loaded once per shell. | Small shared feature bundle |
| Product hover / touch | Fine-pointer image zoom to 1.08, lifted shadow, pointer-following tilt clamped to +/-6 degrees with 800px perspective, focus/hover quick-view button. Touch press-scale 0.98; no tilt. | Shopery hover / Food Website depth |
| Quick view | Shared accessible Sheet with zoomable product image, loaded pack choices/prices and shared add-to-cart; focus trapping/restoration and loading/error recovery. **The catalog has one image per product, so this is a one-image gallery, not an invented multi-image gallery.** | Instacart-style click expansion |
| Backgrounds | Existing store palette extended with a tile and lift token, alternating base/tinted/deep bands and low-opacity SVG woven line texture. Hero overlays derive from store colors. | Reference section rhythm without flags/maps/kente |
| Reduced motion / accessibility | Autoplay unit-tested; CSS motion disabled, parallax/flight/tilt/counters reduced, keyboard controls and visible focus retained. Mobile purchasing text enlarged and all navigation labels shown. **Rendered AA contrast and browser accessibility are not certified.** | Existing accessible design system |

### Coordinator fixes

1. **Empty storefront cache:** tenant-keyed `unstable_cache` wrappers tag listing, banner, collection and related storefront reads with `storefront:<id>` and a 60-second fallback. Successful listing create/update/deactivate/reactivate calls expire that tag after the write. Banner and collection writes in this checkout occur in the seed; its final step calls `revalidateSeededStores`. An authenticated route expires storefront and existing store tags. Regression tests cover cached-empty reads, invalidation, tenant/query isolation, successful versus failed mutations, and unauthorized/malformed flush requests.
   - Immediate invalidation from an offline seed needs `STOREFRONT_REVALIDATION_URL` pointing to the running server's `/api/storefront/revalidate`, plus matching `STOREFRONT_REVALIDATION_SECRET` in seed and server environments. Without them the seed logs setup instructions; the 60-second cache freshness fallback remains. Next's request-scoped revalidation cannot be called directly from standalone Prisma seed code. No banner/collection admin mutation APIs existed to wire separately.
2. **Encoding:** repaired the search subtitle and empty-result copy as UTF-8. Repository text scan found no replacement character or its previously double-encoded form, excluding generated dependencies/build/Git data.
3. **Search:** exact English/local names rank first, prefixes second, then full-text and bounded fuzzy matches. Trigram similarity must exceed 0.3; minimum query/token lengths reject incidental matches. DB tests and HTTP checks put egusi first and exclude cassava/garden eggs; existing typo/prefix behavior remains covered.
4. **404:** unknown pages inside a known store show branded Page not found, store search and aisles. Unknown stores retain Store not found. No proxy/store-resolution changes. HTTP verified `/c/grains-flours` returns 404; unknown-store streaming behavior retains its existing noindex response.
5. **Credits:** footer now opens a designed `/credits` page with source links, authors, licenses and truthful processing notes. `public/images/CREDITS.md` remains the attribution record.
6. **Tip:** existing 15% default remains unchanged.

### Image processing and attribution

The requested `research/catalog/master-catalog.csv` did not exist in this checkout. Reconstructed it from the current manifest and reviewed Commons imageinfo metadata, preserving that provenance in `scripts/images/README.md` and `source-verification.json`.

- **52 image-bearing catalog keys; 48 processing rows using 47 distinct Commons photographs.** Five existing Unsplash editorial images are credited separately.
- Replaced 17 mappings, including flour for semovita/poundo, raw rice for Ofada, seasoning for suya, flour for puff-puff mix, raw cow foot, dried pepper/hibiscus and packaged palm oil/Maggi/Peak/Maltina/tomato paste. Added the missing coconut oil, oxtail and ground-crayfish lookup coverage. These remain representative ingredients/packages, not verified store packshots; the rice photograph is not verified as the Ofada variety.
- **Processed: 0.** Creating the throwaway external venv failed in ensurepip with `PermissionError`. No rembg dependency was added to the app. The offline bookkeeping attempt recorded **48 failures due to uncached originals**; these are not segmentation-quality failures. See `scripts/images/processing-report.json`.
- `process-products.py` is ready to install/run with upstream `pip install "rembg[cpu]"` in an external venv. It reuses a small CPU model session, writes centered 800px alpha WebP under `public/images/products/<listing-slug>.webp`, updates the same seed/catalog manifest only on success, and records author/license plus “background removed.” Partial reruns retain credits for previously generated assets; BY-SA licenses remain BY-SA.
- Existing photos use contain sizing while processing is blocked. A failed network photo gets a Photo unavailable state; letter artwork is reserved for a genuinely unmapped item (for example Jollof Rice Seasoning). Related products now try the master product name when a listing-specific alias has no mapping.
- Actual segmentation edges, source suitability and final cut-out composition still need visual review after processing. `CREDITS.md` explicitly states that no alpha output exists yet.

### Verification and performance

| Check | Result |
|---|---|
| `pnpm typecheck` | **Passed**, including final motion and polish code |
| `pnpm lint` | **Passed**, final run with no warnings |
| `pnpm test` | Attempted; standard Vite/esbuild startup blocked by `spawn EPERM` |
| Full sandbox-compatible suite | **920/920 tests in 28 files passed**, zero failed/skipped. Same source tests/setup/assertions, in-process TypeScript transform and worker threads. JSON: `.validation-artifacts/phase3-unit-tests.json` |
| `pnpm build` | Attempted; Prisma generation passed, migrate-deploy schema-engine spawn blocked by `EPERM` |
| Next production build | **Passed** with `CODEX_IN_PROCESS_BUILD=1 pnpm exec next build`. Opt-in config uses worker threads, one worker and in-worker TypeScript checking; no type/build checks skipped. Final compilation 3.3s, TypeScript 11.6s, 22 static-generation work items. These are build times, not LCP |
| HTTP smoke against final build | **15/15 passed**: 12 preview checks plus 3 production checks. Home, category, product, credits, branded unknown page, unknown-store message/noindex, exact search, quick-view packs/image, unauthorized cache-flush denial and sample-content gates. Reports: `.validation-artifacts/phase3-http-*.json` |
| `pnpm test:e2e --workers=1` | Attempted again after updates; exits before browser tests with `spawn EPERM`. **Not passed** |
| Capture runner | Attempted; Chromium launch blocked by `spawn EPERM`. CUA had no browser; IAB unavailable. **Zero new screenshots or recordings** |
| Home LCP, throttled 4G | **Not measured**; no numeric result available. Target remains <2500ms |
| Product LCP, throttled 4G | **Not measured**; no numeric result available. Target remains <2500ms |
| Python scripts | Syntax compilation passed; external venv/rembg execution blocked as above |

Added nine browser regressions covering hero pause/resume, full-width stage geometry, marquee/pause, mobile coverflow control/snap agreement, quick-view pack/add/focus, fly-to-cart/live count, branded 404, exact search ranking and reduced motion. Existing assertions were retained. The LCP tests now use real images, disabled browser cache, 1.6 Mbps down / 750 Kbps up / 150ms RTT and 2x CPU throttling; prior transparent-image stubs and warming were removed. Their <2500ms assertions remain intact.

Only the first hero background is preloaded on home; product-detail hero is preloaded on its route. Foreground/below-fold images use default lazy loading. New movement uses transforms/opacity, contact shadows are static, counters reserve width, and no broad will-change was added. Actual LCP/CLS/interaction smoothness and remote-image latency remain unverified; successful compilation does not establish the performance target.

### Impeccable critique, polish and review

Used the repository's `.claude/skills/impeccable/SKILL.md`, context command, craft floor, critique and polish references. Assessment A (`design_a`) independently reviewed design; Assessment B (`design_b`) ran one detector scan and held findings until A finished. Browser inspection was unavailable, so no overlays or rendered-quality claims were made.

Provisional pre-polish Nielsen scores, in order: visibility **3/4**, real-world match **3/4**, control **3/4**, consistency **3/4**, prevention **2/4**, recognition **2/4**, efficiency **3/4**, minimalist design **2/4**, recovery **3/4**, help **1/4**: **25/40**. Archived trend: 24/40 -> 25/40. **The requested >=8/10 for each heuristic is not achieved/verified.** Snapshot: `.impeccable/critique/2026-11-01T05-47-27Z__src-app-storefront-page-tsx.md`; backlog left open because browser and help/imagery gaps remain.

Strengths were local food vocabulary, shared shopping controls and independent motion pause gates. Priorities were tiny mobile purchase text, misleading ZIP-save language, hidden navigation labels, unsupported merchandising claims and hero content resilience. The detector returned 179 advisory differences (146 type size, 24 color, 9 radius), including legacy/overridden CSS; no critical/error finding. Decorative display sizing, neutral scrims and progress-strip corners were treated as intentional, not automatic defects. JSON: `.validation-artifacts/phase3-impeccable-detector.json`.

Polish enlarged mobile names/metadata/quick-view/category labels, kept all navigation destinations labeled, described ZIP entry as a temporary note rather than saved eligibility, qualified production rail headings, removed redundant hero/collection/credits labels, replaced fixed hero greens with store-derived colors, restored shared product corner sizing, reserved counter width and removed a false circular mask around unprocessed hero photography. Category accessible naming and optional story footer anchor were corrected. An independent code review also found and led to fixes for conflicting old hero CSS, mobile coverflow state, duplicate transition names after modified clicks, quick-view entry/exit and badge pause behavior. A real store contact path and end-of-rail disabled controls remain smaller usability gaps; no new contact backend was fabricated.

Questions skipped: the user's explicit brief already authorized the direction and polish; no redundant approval was requested.

### Screenshots, recording and remaining work

`scripts/capture-storefront-redesign.mjs` is prepared to replace **28 screenshots**: home top/mid/bottom, category, product, quick view and 404 at 390/1440px, light/dark. It checks visible images, overflow and page errors, writes `phase3-checks.json`, then records a WebM plus hero-transition and hover-tilt frame series. **The requested replacement was not possible here.** Existing screenshots are historical, not current visual evidence. Updated `screenshots/redesign/README.md` explains how to capture and stop the server.

Before acceptance on a machine allowing subprocesses: run external rembg and inspect all output; reseed with the revalidation URL/secret; run the five standard commands; run the capture runner and inspect long copy, text zoom, all widths/themes, focus, modal behavior, carousel/coverflow motion and shared transitions; record real LCP and tune until both routes are below 2.5s; repeat the rendered design critique to meet the target. Also resolve any desired bento/two-offer composition, multi-image gallery, real restock/promotion/review data, neighborhood count and contact-data requirements against real sources.

Auth, admin UI, RLS, proxy, store resolution, payment implementation, phase 2 service interfaces/adapters and demo gates were preserved. Listing mutation edits are limited to the explicitly requested cache invalidation. The default 15% tip remains. No servers are left running.
