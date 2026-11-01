# Browse screens implementation report

Implemented category index and category detail, product detail with client pack selection, collection detail and customer account placeholder. All successful routes use StorefrontShell. Added loading skeletons and retry-based error boundaries for each route.

Files: src/app/categories/{page,loading,error}.tsx; src/app/categories/[slug]/{page,loading,error}.tsx; src/app/listings/[id]/{page,loading,error}.tsx; src/app/collections/[slug]/{page,loading,error}.tsx; src/app/account/{page,loading,error}.tsx; src/components/storefront/{product-detail,browse-loading,browse-error}.tsx.

Category filters and sort use server GET query state, scoped listingsByCategory, actual available pack labels, clear-filter recovery, desktop sidebar and sticky mobile category chips. Product detail uses service detail data only, first photo preload, honest representative/serving-suggestion note, selected variant price/weight and variant-aware quick add, actual size/storage facts and unknown origin marked See packaging. Ask-store products cannot be added from detail. Related rail uses the same category scoped by store and excludes the current listing. Collection uses getCollectionListings and notFound for missing collections. Account has no admin sign-in link.

Checks: pnpm typecheck passed; targeted pnpm exec eslint src/app/categories src/app/listings src/app/collections src/app/account src/components/storefront/product-detail.tsx src/components/storefront/browse-loading.tsx src/components/storefront/browse-error.tsx passed. Local Next page and error docs read; error boundaries use retry(). No shared CSS or service edits. Full build/e2e left to lead as requested.

Integration notes: scope legacy product-detail stock badge assertions to [data-testid=product-detail], because the related rail introduces additional valid card stock badges. Sort uses explicit Sort submit button. Single real photo shown, with no fabricated gallery view. Pack filter currently uses listing service packLabel (the cheapest available pack represented by the listing card); selecting other actual variants is available on product detail. Visual browser QA remains for lead.
