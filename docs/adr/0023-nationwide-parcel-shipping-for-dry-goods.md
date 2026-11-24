# 23. Nationwide parcel shipping for shelf-stable goods

Date: 2026-11-15 · Status: accepted (#567; amended 2026-11-16 for labels and tracking, #568; 2026-11-23 for a label refused after capture, #771)

## Context

Spec §1 listed nationwide parcel shipping as a v1 non-goal and §17 named it a phase 3 candidate for dry goods. Shoppers far from any market still want garri, egusi, spices and other shelf-stable goods a store sells. Shipping them crosses state lines, so it touches sales tax (ADR-0008), and it adds a carrier that is not a courier (ADR-0006).

## Decision

- **What ships.** A listing ships only when the store marks it shippable, and only while it is not frozen, not perishable and every size has a real weight (`listing_variants.weight_placeholder` false, weight above 0). An edit that breaks the rule turns shipping off for that listing. Checkout checks the rule again on every line, so a listing frozen after it was marked never ships.
- **Who ships.** A store opts in by setting handling days, 1 to 10 business days (`stores.shipping_handling_days`; null means it does not ship).
- **Where.** Only to states on the platform allowlist (`platform_settings.shipping_states`, empty by default). A state is added only after the tax advisor signs off on it (ADR-0008). Delivery radius does not apply.
- **When.** Checkout offers Ship when every line ships, the store ships, the destination state is allowed and the order weighs at most 50 lb. It is one box per order (12 × 10 × 8 in).
- **Price.** A `ShippingProvider` seam (`src/lib/shipping/provider.ts`) with a Shippo adapter (`POST /shipments`, `async: false`) and a fake that refuses what Shippo refuses. Checkout shows only the cheapest rate, with carrier, service and days, at the carrier's price with no markup (ADR-0006). The rate is locked on the cart, keyed on the destination state, ZIP and order weight, until it expires 7 days after the quote, the window in which Shippo sells a rate. An expired rate is asked again; a different price is shown before the card hold. Placement charges the locked rate and never asks again.
- **Tax.** Stripe Tax taxes the order at the destination address (#65).
- **Money.** The hold and capture follow the existing flow; capture is at Ready (Packed). What the shopper paid is stored in `orders.delivery_fee_cents` with the rate id, its expiry, carrier, service and days.
- **Labels (#568).** At Ready the platform buys the label on its own Shippo account, so the postage is a platform pass-through, like the courier fee: `orders.shipping_postage_cents` goes into the application fee and the #546 ledger's courier column. Before capture, an expired rate is quoted again; the store absorbs a rise up to $2 (it comes out of the store's part), and staff confirm a larger one. After capture (decision 2026-11-23-13, #771), a definitive refusal of the stored rate (HTTP 4xx, or a transaction ERROR not coded `carrier_timeout`; never Shippo's message text) quotes the parcel again and the Ready panel shows staff the fresh rate. Within $5.00 of the captured postage, staff confirm it and the label is bought on it; the platform absorbs the difference, recorded on the order (`orders.shipping_label_postage_cents`) with the fresh rate when staff confirm it, so a retry after a failed purchase keeps it without asking again, and counted as "Postage absorbed" in the #546 ledger once the label is bought, and what Stripe captured never changes. More than $5.00 above it, staff are offered Cancel shipment and refund instead of a purchase. A 5xx or lost answer is never quoted again, as the lookup for a label sold from it needs the old rate id. The label PDF is kept in the private proof bucket, for the store's members only.
- **Tracking (#568).** Shippo `track_updated` webhooks, verified by HMAC (`Shippo-Auth-Signature`), drive READY → SHIPPED (first scan) → IN_TRANSIT (a later scan) → DELIVERED, forward only, each status once, one customer message per step with the carrier's tracking link.
- **Cancel (#568).** Before the first scan the label is voided and the whole capture refunded; after it, the cancel is refused.
- **Not in scope.** Returns, multi-box orders.

## Consequences

- Ship is offered only when a label can be bought and kept: `SHIPPO_API_KEY` and `R2_PROOF_BUCKET` (#765). Without either, checkout hides Ship, and the quote and both placement paths refuse it, so no shipped order strands at Packing with the card held. The fake is used only outside production with `E2E_FAKE_SHIPPO=1` (decision 2026-11-14-05).
- With an empty allowlist nothing ships. Adding a state is a platform data change made after the advisor's sign-off; there is no admin screen for it yet.
- Listing weights now carry money: a wrong weight means a wrong rate the store pays the difference on when it buys the label.
