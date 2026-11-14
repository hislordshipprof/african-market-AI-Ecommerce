# Shared cart implementation report

Implemented in the owned scope only:
- `src/lib/storefront/cart-store.ts`: cart item/line/store interfaces, `cartItemKey`, `EMPTY_CART`, and `createCartStore(storeId)`.
- `src/lib/storefront/cart-store.test.ts`: persistence/restore, malformed storage, store isolation, variants, zero/negative/removal/max quantity, unavailable storage, unsafe prices and duplicate line validation.
- `src/components/storefront/cart-provider.tsx`: `CartProvider`, `useCart`, `CartTrigger`, cart drawer content and minimum-order progress.
- `src/components/storefront/quick-add-stepper.tsx`: shared-state quantity control replacing local quantity.
- `src/components/storefront/sheet.tsx`: reusable native dialog with focus containment/Escape, trigger focus restoration, body scroll locking, desktop side/mobile bottom positioning, responsive Motion enter/exit animation.
- `src/components/storefront/mobile-nav.tsx`: route-aware Home/Categories/Search/Cart/Account mobile navigation with safe-area spacing.
- `src/components/storefront/cart.module.css`: isolated theme-aware component styling, minimum 44px targets and reduced motion overrides.

## Integration APIs

`CartProvider({storeId: string, storeName: string, minimumOrderCents: number, children})` wraps every cart control and renders the drawer. `CartTrigger({className?, children?})` opens it. `MobileNav()` requires this provider. `QuickAddStepper({item: CartItem, disabled?: boolean})` requires it as well.

`CartItem` is `{listingId, variantId?, name, price, imageUrl?, packLabel?}`. **price is integer cents**. `CartLine` adds quantity. `useCart()` returns `{lines, count, subtotal, store, openCart}`; subtotal is cents. The store offers snapshot(), subscribe(listener), setQuantity(item, quantity), remove(cartItemKey(item)). Storage key is `storefront-cart:${storeId}`. Listing plus variant identity uses JSON tuple encoding to avoid delimiter collisions.

Server snapshots stay empty and stable for safe hydration. Storage input is validated and malformed/duplicate/unsafe lines are rejected. Failed storage access falls back to memory. Storage event listeners attach only when subscribed and detach at the final unsubscribe. Quantities cap at 99; zero and negative quantities remove. No free-delivery claims or functional checkout/swap claims.

## Verification

Read DESIGN.md and the installed Next client directive and usePathname guides before implementation.

- `pnpm typecheck`: passed after lead integrated the QuickAddStepper callsite and cart narrowing fix.
- Targeted ESLint: all owned TypeScript files passed with zero errors and zero warnings after replacing the line thumbnail with lazy next/image.
- `pnpm test src/lib/storefront/cart-store.test.ts`: blocked before executing tests by existing esbuild `spawn EPERM` sandbox failure. This is not a passing unit test run.
- Independent direct Node checks using TypeScript transpilation passed persistence, independent stores, variants, quantity cap/removal, malformed data, storage event synchronization and listener cleanup.
- Final focused lint passed. The later full typecheck was interrupted by a concurrently edited SearchBar storeId signature mismatch in storefront-header.tsx:18; no owned-file errors were reported. Lead is continuing integration checks.

## Limitations and review needs

Browser interaction and visual checks remain for the lead: open/close animation, mobile 320px layout, keyboard focus and reduced motion. Currency remains USD to match existing storefront pricing. Checkout is disabled with coming-soon wording. Swap choice pill announces coming-soon behavior. No cookie/proxy changes were made, preserving the store override mechanism. No git mutations or subagents were used.

Lead review corrections applied: next/image lazy thumbnails, muted-foreground token for readable secondary text, floating mobile navigation pill inset 12px and safe-area offset, explicit expanded width under reduced motion, and responsive motion.dialog slide enter/exit durations. Browser checks remain necessary.

## Review follow-up

Sanitized all cart item photo metadata during mutation and persisted restore. Permitted photos are raster `/images/...` paths, HTTPS `images.unsplash.com/photo-*` URLs, and HTTPS Wikimedia raster URLs. Unsupported, SVG, malformed and non-string image values are dropped while valid cart lines survive. Added six rejection and three permitted-photo test cases; direct Node checks passed all nine and targeted lint passed.

Cart count animation is now aria-hidden, and a separate stable sr-only polite live region announces the item count without remounting on updates.

## Product-list motion follow-up

Added `ProductListMotion`, a minimal client wrapper that receives server-rendered children. Category, collection and search grids plus product rails use it; no catalog service or card renderer enters its client import graph. Items reveal in view with 240ms opacity/8px motion, 30ms stagger and maximum 210ms delay (eight stagger positions). Under reduced motion the reveal is disabled and opacity/position reset instantly. Semantic ul/li structure is preserved for search results and rail item sizing is preserved via display:contents.

Shared storefront Button already used 50ms press-in, 200ms release and reduced-motion overrides. Added equivalent CSS chip press feedback with reduced-motion transform disabled; no header/hero styles changed.

Targeted ESLint passed for ProductListMotion, ProductRail and all three edited routes. Final `pnpm typecheck` passed.
