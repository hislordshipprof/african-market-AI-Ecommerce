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
- Built in D2 (#450): the owner sets the switch, the blurb (at most 160 characters) and up to 3 cuisine tags from a fixed list (ADR-0004) on the store-admin "Directory listing" page; staff cannot open it. The platform admin's store form overrides the switch. Every change writes an audit row and clears the directory cache tag.
- Built in D4 (#452): near me takes a ZIP code, a city ("City, ST" or "City"; a name found in several states asks which one) or the browser location, asked for only when the shopper taps "Use my location". A denied location focuses the ZIP field with a message. Stores within 50 miles come back nearest first, ranked by SQL haversine (no PostGIS, ADR-0012); with none that close the 3 nearest show with their distance, then the state list. A browser point outside every US ZIP's reach gets the state list. ZIPs and city centroids come from the 2025 Census Gazetteer files, seeded by migration `20261114230000_store_directory_gazetteer` (50 states and DC). `GET /api/directory/near` is rate-limited per browser and per IP with the Postgres limiter. Its answer carries each store's distance, never the store's own lat/lng, which would locate its street address.
