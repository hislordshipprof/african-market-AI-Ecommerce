# 8. Build to collect sales tax as a marketplace facilitator, gated on advisor sign-off

Date: 2026-10-30 · Status: accepted

Stores operate in any US state (ADR-0001), and most states' marketplace-facilitator laws may make the platform, not the store, responsible for collecting and remitting sales tax on orders it processes. Grocery-tax rules also differ by state. We build tax calculation in from the start (Stripe Tax, per store address and per product tax category) and record which party is liable on each order, so either outcome works without rebuilding checkout. **No real order is taken until a tax advisor confirms the obligations** for each state with a live store. We rejected leaving tax to each store, because it is likely non-compliant in facilitator states.
