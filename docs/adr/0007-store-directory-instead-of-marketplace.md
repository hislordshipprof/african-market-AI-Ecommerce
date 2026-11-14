# 7. Store directory instead of a combined marketplace

Date: 2026-10-30 · Status: accepted · Supersedes spec D2 and the §4 Phase 2 marketplace view · Amended 2026-11-14 (#448)

Stores never share a cart or checkout. Instead of the planned combined marketplace app, the platform gets a **Store directory** (Phase 2): a public site where people search by state, city or "near me", then click through to that store's own storefront. Listing is opt-in per store. Product search across stores is deferred, because it would put competing stores' prices side by side, against stores owning their customers (ADR-0003). One customer account (ADR-0002) works at every store, but sessions are cookies scoped to each store's domain (ADR-0015), so a customer arriving from the directory signs in once more on that store's site.

## Note, 2026-11-14 (#448): owner decisions of 2026-11-11 (#447)
- No "3 stores in a metro" gate: the directory lists every listed store, wherever it is (amends ADR-0001).
- When no store is nearby, it shows the nearest stores with their distance, then the list of states. "Suggest a store" comes later (D7).
- The store owner turns the listing on and writes the blurb. Listing is off by default, and a platform admin can override it. The street address is shown only to platform admins.
- Cards show distance and "delivers to you", using the store's own delivery radius only, because courier coverage is known only from a quote (ADR-0006).
- ZIP and city lookups use static US Census Gazetteer tables in Postgres, with no new runtime provider (ADR-0017). The Census geocoder resolves only full street addresses.
- The directory is served on `PLATFORM_ROOT_DOMAIN`. Choosing the platform name blocks only DNS, so it is demoed on the vercel.app host.
- The build steps are D1–D7 in spec §17, Phase 2.
