# 21. Pricing: where the platform earns money, and the courier plan

Date: 2026-11-12 · Status: **accepted** 2026-11-12 (owner accepted the recommended option in full) · Refines spec D3 and open questions 2 and 4; touches ADR-0006

## Where we are today
The platform earns **$0 per order**.
- **Store subscription** (spec D3): not built.
- **Per-order platform fee:** built, but set to $0 (`PLATFORM_PER_ORDER_FEE_CENTS` in `src/lib/order/platform-fee.ts`).
- **Delivery:** the customer pays the courier's quote with no markup (ADR-0006), and we pass it through.
- **Card fee:** the 2.9% + 30¢ we keep from each capture repays Stripe, which debits the card fee from the platform on destination charges. It is cost recovery, not income. Today the store pays it on the **whole** capture, including the delivery fee it never receives.
- **Goods:** the store is the seller of record and keeps the item prices. We never mark up items.

## Proposal (recommended)

| Lever | Proposal | Why |
|---|---|---|
| Store subscription | **Starter $49/month** and **Pro $99/month**; features in [Plan features](#plan-features). First 3 months free for the first 5 pilot stores. | Predictable income that covers hosting, AI and support. Well below Shopify plus apps, or a 15–30% marketplace commission. |
| Per-order fee | **Customer service fee: 3% of goods, min $0.99, max $2.99**, shown at checkout, on delivery and pickup orders. **0% commission to the store.** | The store keeps 100% of its prices, which is the pitch against Instacart and DoorDash Marketplace. Customers already expect a small fee online. |
| Delivery | **Keep the courier quote at cost, no markup** (ADR-0006 unchanged). No extra dispatch fee. | Delivery is the price shoppers compare. The service fee already pays for dispatch and support. |
| Card fee | **The platform pays the card fee on the parts it keeps** (service fee and delivery). The store pays it only on its goods, tax and tip. | Fair, and easy to explain on the payout statement. It costs us about 3% of those parts. |

### Plan features
Decided 2026-11-12. The rule: **Starter is a complete online store**, and **Pro adds what grows the business or costs us money to run**. Shopper safety and core ordering are never locked behind Pro: allergy and diet rules, swap or refund prompts, cancellations and refunds.

| Area | Starter ($49) | Pro ($99) |
|---|---|---|
| Storefront | Branded store at its platform subdomain | Adds the store's **own domain** |
| Catalog | Shared catalog, CSV import, photos, stock levels | Same |
| Shopper assistant | Full (lists, recipes, photo lists, allergy and diet limits); fair-use cap of **1,000 chats a month** | **5,000 chats a month** |
| Orders | Pick list, swap or refund prompt, cancel and refund, issue reports | Same |
| Fulfilment | Pickup and the store's own delivery | Adds **courier delivery** (DoorDash or Uber, cheaper one picked, automatic switch-over) |
| Notifications | Email and web push to the store; email and SMS order updates to shoppers | Same |
| Customer chat | In-app chat with shoppers | Same |
| Store copilot | Stock alerts and daily digest | Adds **voice and photo stock reports**, and **WhatsApp** for copilot and alerts once built |
| Staff | Owner + **2 staff** | **Unlimited staff** |
| Analytics | Per-order payout breakdown | Adds the **analytics dashboard** (#498) |
| Payouts | Weekly Stripe payouts, per-order breakdown | Same |
| Directory (Phase 2) | Listed | Same |
| Support | Email, next business day | **Priority**, same day |

- **Locked features:** a Starter store sees each Pro feature locked, with an upgrade link.
- **Downgrade:** a downgrade never breaks an order in flight. New orders follow the new plan. Staff over the limit keep read-only access until the owner removes them.
- **Assistant cap:** past the monthly cap, the assistant tells the shopper it is unavailable and the store keeps selling by browsing. The owner is warned at 80%.
- **Not in either plan yet:** multiple locations under one account (a higher tier later, if a store asks).

### Example order
$60 of goods, an $8.99 courier quote, no tip, tax left out:

| | Customer pays | Store receives | Platform keeps |
|---|---|---|---|
| Goods | $60.00 | $60.00 − card fee on goods ($2.04) = **$57.96** | — |
| Service fee (3%) | $1.80 | — | $1.80 − card fee ($0.05) = **$1.75** |
| Courier | $8.99 | — | $8.99 − card fee ($0.26) − courier ($8.99) = **−$0.26** |
| **Total** | **$70.79** | **$57.96** | **$1.49** |

Card fee as built: 2.9% of each part, with the 30¢ fixed fee charged on the goods.

### Store-level income
A store with 300 online orders a month at about $60 each: 300 × $1.49 + $49 = **about $496 a month**. On Pro: **about $546**.

Variable cost per order, approximate, excluding the card fee above:
- assistant: about $0.001–0.01 per chat (the #146 eval ran about $0.001 per case on Haiku 5.5);
- SMS: about $0.01–0.03;
- copilot and email: cents.

Hosting is mostly fixed.

## Options considered
- **Store-paid per-order fee ($1 flat, or 2%) instead of a customer fee.** Simpler for shoppers, but it is a "commission" in the owner's eyes and weakens the pitch. Keep it as the fallback if owners prefer it.
- **Markup on delivery (a capped 10–15%, or a $0.99 booking fee).** About $1 more per courier order, but it reverses ADR-0006 and makes our delivery price look worse than the store's own.
- **Subscription only, no per-order fee.** Easiest to sell, but income doesn't grow with order volume, and AI and SMS costs do.
- **Per-order fee only, no subscription.** Easiest start for small stores, but a quiet store costs us hosting and support with no income.

## Courier plan

**Costs** (US, per delivery, no monthly fee; to confirm with written quotes):

| Provider | Cost | Notes |
|---|---|---|
| DoorDash Drive On-Demand | $6.99–$10.99 flat | No commission. |
| Uber Direct | From about $7.99 | Varies by distance, speed and city. Reported city surcharges and a $5 fee for cancelling after a courier accepts. |
| Aggregators (Burq and similar) | Courier cost + about $4 | Fewer integrations for us, but about $4 more per order. Rejected for now. |
| Roadie | Quoted per delivery | For heavy or large orders. Stays deferred (ADR-0006). |

**Build order:**
1. DoorDash Drive first (#135, #136): flat pricing and wide coverage.
2. Uber Direct (#139).
3. Cheapest-available selection and failover (#140).

Store delivery and Pickup already cover stores with their own drivers and orders over 50 lb.

**Needed from the owner before courier work starts:**
- DoorDash Drive and Uber Direct sandbox accounts and keys;
- written US pricing for a platform account;
- each provider's grocery weight limit, in writing.

**Status of the provider accounts (2026-11-12):**
- DoorDash: applied for **Drive** (not Marketplace or reporting), as a grocery and retail integration. The application is pending DoorDash's approval, so there are no keys yet. #135 is built against stubbed HTTP.
- Uber Direct: account created; test (sandbox) keys are in each developer's `.env.local` under `UBER_DIRECT_CUSTOMER_ID`, `UBER_DIRECT_CLIENT_ID`, `UBER_DIRECT_CLIENT_SECRET`. Production keys are not issued yet.
- Stores do not choose a provider; the platform picks per order (#140).

## Decisions (accepted 2026-11-12: items 1–4 as recommended; 5 and 6 are open tasks before launch)
1. The subscription tiers and prices ($49 / $99), and the pilot offer (3 months free for 5 stores).
2. The per-order fee: who pays (the customer, recommended, or the store), and the amount (3%, $0.99 min, $2.99 max).
3. Delivery: keep it at cost, no markup (recommended), or add a fee.
4. The card fee: the platform pays it on the parts it keeps (recommended), or keep today's behaviour.
5. Validate 1–2 with 3–5 store owners before launch (spec open question 2).
6. Tax: confirm with the tax advisor whether a customer service fee changes the marketplace-facilitator position (spec open question 3).

## Consequences
- Spec D3, §10 (charge model) and §18 open questions 2 and 4 are updated.
- New tickets: #494 (Stripe Billing subscriptions, plan features, pilot offer) and #495 (the service fee in cart, checkout, receipts and payouts, plus the card-fee split in `platform-fee.ts`).
- `PLATFORM_PER_ORDER_FEE_CENTS` is replaced by the service-fee rule.
