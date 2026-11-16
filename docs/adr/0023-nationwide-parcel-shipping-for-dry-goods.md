# 23. Nationwide parcel shipping for shelf-stable goods

Date: 2026-11-15 · Status: accepted (#567; labels and tracking in #568)

## Context

Spec §1 listed nationwide parcel shipping as a v1 non-goal and §17 named it a phase 3 candidate for dry goods. Shoppers far from any market still want garri, egusi, spices and other shelf-stable goods a store sells. Shipping them crosses state lines, so it touches sales tax (ADR-0008), and it adds a carrier that is not a courier (ADR-0006).

## Decision

- **What ships.** A listing ships only when the store marks it shippable, and only while it is not frozen, not perishable and every size has a real weight (`listing_variants.weight_placeholder` false, weight above 0). An edit that breaks the rule turns shipping off for that listing. Checkout checks the rule again on every line, so a listing frozen after it was marked never ships.
- **Who ships.** A store opts in by setting handling days, 1 to 10 business days (`stores.shipping_handling_days`; null means it does not ship).
- **Where.** Only to states on the platform allowlist (`platform_settings.shipping_states`, empty by default). A state is added only after the tax advisor signs off on it (ADR-0008). Delivery radius does not apply.
- **When.** Checkout offers Ship when every line ships, the store ships, the destination state is allowed and the order weighs at most 50 lb. It is one box per order (12 × 10 × 8 in).
- **Price.** A `ShippingProvider` seam (`src/lib/shipping/provider.ts`) with a Shippo adapter (`POST /shipments`, `async: false`) and a fake that refuses what Shippo refuses. Checkout shows only the cheapest rate, with carrier, service and days, at the carrier's price with no markup (ADR-0006). The rate is locked on the cart, keyed on the destination state, ZIP and order weight, until it expires 7 days after the quote, the window in which Shippo sells a rate. An expired rate is asked again; a different price is shown before the card hold. Placement charges the locked rate and never asks again.
- **Tax.** Stripe Tax taxes the order at the destination address (#65).
- **Money.** The hold and capture follow the existing flow; capture is at Ready (Packed). The postage is stored in `orders.delivery_fee_cents` with the rate id, carrier, service and days. Until #568 buys labels, the postage stays in the store's part of the capture, like a store delivery fee. #568 moves it to a platform pass-through, like the courier fee.
- **Not in scope.** Returns, multi-box orders, label purchase, tracking and the Shipped state (#568).

## Consequences

- Without `SHIPPO_API_KEY` no rate is quoted and checkout says shipping isn't available. The fake is used only outside production with `E2E_FAKE_SHIPPO=1` (decision 2026-11-14-05).
- With an empty allowlist nothing ships. Adding a state is a platform data change made after the advisor's sign-off; there is no admin screen for it yet.
- Listing weights now carry money: a wrong weight means a wrong rate the store pays the difference on when it buys the label.
