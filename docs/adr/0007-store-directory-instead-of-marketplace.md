# 7. Store directory instead of a combined marketplace

Date: 2026-10-30 · Status: accepted · Supersedes spec D2 and the §4 Phase 2 marketplace view

Stores never share a cart or checkout. Instead of the planned combined marketplace app, the platform gets a **Store directory** (Phase 2): a public site where people search by state, city or "near me", then click through to that store's own storefront. Listing is opt-in per store. Product search across stores is deferred, because it would put competing stores' prices side by side, against stores owning their customers (ADR-0003). One customer account (ADR-0002) means a customer arriving from the directory is already signed in.
