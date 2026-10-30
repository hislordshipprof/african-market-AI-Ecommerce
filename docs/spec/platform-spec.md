# African Markets Platform: Product & Technical Spec (v0.1)

Date: 2026-10-30 · Status: draft for review · Working name: **"the Platform"** (brand TBD)
Research: [US competitor report](../../research/us-competitor-report.md) · [Danlex teardown](../../research/danlex-teardown.md)

---

## 1. Summary

A multi-tenant e-commerce platform for independent African grocery markets in the US. Each market gets its own branded storefront and store admin, running on one shared platform. Customers shop by browsing or by telling an AI assistant what they need; they approve the cart and pay. The store picks the order with an AI-generated pick list, resolves any shortages with the customer *before* dispatch, taps **Ready**, and an on-demand courier (Uber Direct, DoorDash Drive fallback) delivers it. A store-side AI copilot summarizes orders and explains inventory movement.

### Goals
1. A market can go live with a branded store in **one day** of onboarding.
2. Customers get **shelf prices**, no silent substitutions, and live delivery tracking.
3. Stores pay a **low flat fee** instead of 15–30% marketplace commission, own their customers, and run everything from a phone.
4. The AI shopper understands African food vocabulary and recipes better than any generic assistant.

### Non-goals (v1)
- Owning inventory or warehouses (Oja UK failed this way).
- Running our own driver fleet.
- Alcohol, tobacco, or age-restricted items.
- Nationwide parcel shipping (phase 3 candidate for dry goods).
- Restaurant / hot food ordering (phase 3 candidate).
- Native mobile apps at launch: responsive web + PWA first.

---

## 2. Decisions taken (from research discussion)

| # | Decision | Choice |
|---|---|---|
| D1 | Launch metro | **DMV (DC/MD/VA) or Houston**: final pick open (see §17) |
| D2 | How customers find stores | Branded store per market first; combined marketplace app once ≥3 stores in a metro |
| D3 | Revenue | Low monthly subscription + small per-order platform fee; courier fee passed through at cost (+ optional small margin) |
| D4 | Heavy items (>50 lb / ~23 kg per order) | Not courier-eligible: pickup, store's own driver, or scheduled van slot |
| D5 | Catalog onboarding | Platform-led, AI-assisted (shelf photos → draft listings), store reviews |
| D6 | Couriers | Uber Direct primary, DoorDash Drive automatic fallback |
| D7 | Payments | Stripe Connect; each market is a connected account |

---

## 3. Users & roles

| Role | Where | Can do |
|---|---|---|
| **Customer** | Storefront (web/PWA) | Browse, AI shop, checkout, approve swaps, track, refund requests, reorder |
| **Store owner** | Store admin | Everything for their store: catalog, prices, stock, orders, staff, payouts, settings, store AI |
| **Store staff (picker)** | Store admin (phone view) | See order queue, pick, mark short, mark Ready, hand off |
| **Platform admin** | Platform console | Onboard tenants, manage shared catalog, billing, support, disputes, courier settings, AI oversight |
| **Courier** | External (Uber/DoorDash apps) | Not a user of our system; represented by provider webhooks |

Auth: email magic link / password + optional SMS OTP for customers; store users require 2FA. Customer accounts are **per platform** (one login works across markets) but each store sees only its own customers' orders and marketing consent.

---

## 4. Multi-tenancy

- **Tenant = one market** (may have multiple locations later; v1 = one location per tenant).
- **Routing:** `{slug}.platform.com` by default; optional custom domain (e.g. `shop.marketa.com`) via CNAME + automatic TLS.
- **Branding per tenant:** name, logo, colors, hero banner, about/hours/contact, policies, WhatsApp number.
- **Isolation:** every tenant-owned row carries `tenant_id`; enforced with Postgres Row-Level Security plus a tenant-scoped data access layer. No query may run without a resolved tenant (except platform-admin and shared-catalog tables).
- **Shared vs tenant data:**
  - Shared: master product catalog (canonical African products, synonyms, images, recipes), customer identity.
  - Per tenant: listings (price, stock, availability), orders, staff, settings, payouts, store analytics, marketing lists.
- **Phase 2 marketplace view:** a combined app at `platform.com` that searches across nearby tenants. Cart stays **single-store per order** (no multi-store carts in v1/v2 — avoids split dispatch).

---

## 5. Customer experience

### 5.1 Browse & search
- Category browsing (Tubers, Grains & Flours, Spices, Oils, Vegetables, Fish & Meat, Frozen, Snacks, Drinks, Beauty).
- Search resolves synonyms and local names: *ugu → fluted pumpkin leaves*, *ata rodo → scotch bonnet*, *gari / garri*, *teff / injera flour*, *ogiri*, *dawadawa / iru*, *kpakpo shito*.
- Product page: sizes/variants, price, **stock confidence badge** (In stock / Limited / Ask store), freshness notes for produce/meat/fish, weight, frozen flag, recipes that use it.

### 5.2 AI shopper (see §8.1)
- Chat panel on every page. Text or a photo of a handwritten list or recipe.
- Builds a cart, explains gaps, proposes substitutes, asks quantity/serving questions.
- **Hands off to checkout for explicit approval. Never pays.**

### 5.3 Cart & substitution rules
- Each line has a swap rule: **Exact item only** (default for most) · **Let store suggest** · **AI-approved substitute: X**.
- Customer sees the delivery fee estimate, platform fee (if shown), tax, and tip **before** checkout.
- Minimum order (per tenant, default $35). Free-delivery threshold optional per tenant (store absorbs fee above threshold).

### 5.4 Checkout
- Fulfillment: **Delivery** (address validated, within store radius, courier-eligible weight) or **Pickup** (time slot).
- If cart > 50 lb: delivery options become *Pickup*, *Store delivery* (if store has a driver), or *Scheduled van* (if offered).
- Payment: card / Apple Pay / Google Pay via Stripe. **Authorize at checkout (total + small buffer), capture the final amount after picking** (see §10). Auth window 7 days; pickup orders > 6 days out not allowed.
- Delivery instructions, apartment/gate code, leave-at-door toggle (disabled when frozen items present).
- Tip (default 15%, editable), passed 100% to courier.

### 5.5 After ordering
- Order page + SMS/email/WhatsApp updates at each state.
- **Shortage prompt:** push/SMS "Egusi 1 lb is out — swap for Egusi 2 lb (+$4) or refund?" Customer has 10 min; no answer → apply the line's swap rule; if rule is *Exact only* → refund that line.
- Live courier map once assigned; drop-off photo/PIN shown on completion.
- **One-tap issue report** within 48 h: missing / damaged / wrong / poor freshness + photo → auto-refund up to a per-tenant limit, otherwise store review queue.
- In-app chat with the store.
- Reorder, favorites, saved lists ("Sunday soup").

---

## 6. Store admin

### 6.1 Onboarding (target: 1 day)
1. Platform admin creates tenant, slug, branding.
2. Owner completes Stripe Connect Express onboarding (KYC, bank).
3. Catalog: staff photograph shelves → AI matches to master catalog or drafts new listings (name, local names, category, size, image) → owner sets prices & reviews → publish. CSV import also supported.
4. Settings: hours, prep time, delivery radius (default 8 mi), minimum order, free-delivery threshold, pickup on/off, own driver on/off, auto-refund limit.
5. Courier registration: platform registers the store location with Uber Direct (location/org) and DoorDash Drive (business + store) automatically.
6. Test order → go live.

### 6.2 Catalog & inventory
- Listing = master product + store price + variants + stock.
- Stock modes per listing: **Counted** (quantity tracked) or **Status** (In / Low / Out) for stores without counts.
- **Stock confidence score (0–1)** per listing, from: last manual confirmation, recent sales velocity, recent shortage reports, time since restock. Decays daily. Shown internally; drives storefront badge and AI behavior.
- Quick stock check: phone list "Confirm these 10 fast movers" each morning (30 seconds).
- Bulk price update, variant management, perishable flag, weight per unit, frozen flag, max qty per order.

### 6.3 Order inbox & picking (phone-first)
- New order alert (push + sound + optional SMS to owner).
- **Accept** (auto-accept optional) with prep estimate.
- **Pick list** grouped by aisle/zone order set by the store; frozen and chilled last. Each line: tick, scan barcode (optional), or **Short** (enter qty found).
- Short lines trigger the customer prompt (§5.5) automatically; picker sees the answer live.
- When all lines resolved → **Ready** (or *Ready in X min* to pre-call courier).
- Handoff screen: courier name/vehicle/ETA, order bag count, handoff photo.
- Batch view: multiple open orders, combined pick for shared items (phase 2).

### 6.4 Money & reports
- Payout dashboard (Stripe Connect: weekly by default), per-order breakdown: item total, refunds, platform fee, card fees, courier fee policy.
- Reports: sales by day/product, top items, shortages by product, refund reasons, customer repeat rate.

### 6.5 Store AI copilot (see §8.2)

---

## 7. Platform admin console
- Tenants: create, suspend, plan/billing, settings override.
- Master catalog: products, synonyms (by language), images, recipes, category tree; merge duplicates proposed by AI.
- Orders & disputes across tenants; manual refund; courier incident log.
- Courier config: provider priorities, failover timeout, per-metro settings.
- AI oversight: conversation sampling, flagged answers, eval dashboard.
- Billing: subscriptions (Stripe Billing), platform fees ledger.

---

## 8. AI assistants

Model: Claude (latest Sonnet-class for chat, Haiku-class for cheap classification/matching) via tool use. All tools are server-side, tenant-scoped, and permission-checked; the model never sees other tenants' data.

### 8.1 Shopper assistant
**Tools**
| Tool | Purpose |
|---|---|
| `search_catalog(query, filters)` | Synonym/local-name aware search within current store |
| `get_recipe(dish, servings)` | Ingredient list from curated recipe base, scaled |
| `check_availability(listing_ids)` | Returns stock confidence + price |
| `suggest_substitutes(listing_id)` | Ranked culturally valid swaps |
| `add_to_cart / update_cart / remove_from_cart` | Cart edits, visible to user in real time |
| `set_swap_rule(line_id, rule)` | Records customer's preference |
| `prepare_checkout()` | Navigates user to checkout with summary; **cannot submit payment** |
| `get_order_status(order_id)` | Own orders only |

**Rules**
- Only add items with confidence ≥ 0.6 as "in stock"; below that, say "may be unavailable — I'll add it with a backup".
- Always show what it added and what it couldn't find, with alternatives.
- Ask before assuming quantities when servings are unclear; default to recipe scaling.
- Never claims a price/stock it didn't get from a tool. No medical/nutrition claims beyond product data.
- Languages: English first; understands Nigerian Pidgin and common Yoruba/Igbo/Hausa/Twi/Amharic/Swahili/Somali food terms via the synonym base.

### 8.2 Store copilot
**Tools**
| Tool | Purpose |
|---|---|
| `list_orders(status, window)` | New / in-progress / ready orders |
| `build_pick_list(order_ids)` | Grouped, frozen-last pick list |
| `mark_line_short(order_line_id, qty)` | Triggers customer prompt (requires staff confirm) |
| `inventory_report(period)` | Movement, velocity, sell-through |
| `low_stock_alerts()` | Items likely to run out in N days |
| `reorder_suggestions()` | Suggested quantities from velocity (no auto-ordering in v1) |
| `update_stock(listing_id, qty/status)` | **Requires owner confirmation** |
| `draft_listing(photo)` | Catalog onboarding helper |

**Proactive messages:** "3 new orders — 2 need egusi, you have 4 left", "Palm oil 1L sold 18 this week, est. out Thursday", "Gari shortage reported twice today — please recount".

**Guardrails:** any write (stock, price, short, refund) is proposed by the AI and confirmed by a human tap. Full audit log of AI-proposed and human-confirmed actions.

### 8.3 Knowledge base (the moat)
- Master catalog with multilingual synonyms and regional naming.
- Curated recipe base: West, East, Central and Southern African and Caribbean dishes with ingredient mappings and serving scaling.
- Substitution graph (e.g. egusi whole ↔ ground; ugu ↔ spinach as last-resort).
- Built by platform team + store owner contributions; reviewed before publishing.

### 8.4 Evaluation
- Golden test set (~200 requests: "jollof for 10", "Ethiopian breakfast", "ata rodo and tatashe", photo lists) scored on cart precision/recall, hallucinated items (must be 0), correct gap reporting.
- Run on every prompt/model change; sample 1% of live conversations for review.

### 8.5 Later: agentic commerce
Expose store catalogs and checkout via an MCP server and the Agentic Commerce Protocol (ACP) so ChatGPT/Gemini agents can shop tenants with user approval (phase 3).

---

## 9. Order lifecycle

```
PLACED ──(payment authorized)──► AUTHORIZED ──(store accepts)──► ACCEPTED ──► PICKING
PICKING ──(line short)──► SUBSTITUTION_PENDING ──(customer answers / 10-min timeout)──► PICKING
PICKING ──(all lines resolved, capture final amount)──► READY
READY ──(delivery)──► COURIER_REQUESTED ──► COURIER_ASSIGNED ──► PICKED_UP ──► DELIVERED
READY ──(pickup)──► AWAITING_PICKUP ──(customer collects)──► COMPLETED
DELIVERED ──(48 h, no issue)──► COMPLETED
```
Side states: `CANCELLED` (before PICKED_UP), `DELIVERY_FAILED` → `RETURN_TO_STORE` → redeliver or refund, `ISSUE_REPORTED` → `PARTIALLY_REFUNDED` / `REFUNDED`.

| Transition | Trigger | Side effects |
|---|---|---|
| → AUTHORIZED | Stripe PaymentIntent `requires_capture` | Notify store, decrement reserved stock |
| → ACCEPTED | Store tap / auto | Customer notified with prep ETA |
| → SUBSTITUTION_PENDING | Picker marks short | Customer prompt; timer |
| → READY | All lines resolved | **Capture** final amount; delivery re-quote |
| → COURIER_REQUESTED | Ready (or Ready-in-X timer) | Create delivery with provider |
| → COURIER_ASSIGNED | Provider webhook | Courier name/ETA to store & customer |
| fallback | No assignment in 10 min or provider error | Cancel with provider A, create with provider B |
| → PICKED_UP | Provider webhook | Live map starts |
| → DELIVERED | Provider webhook + proof | Proof stored; payout eligibility |
| → CANCELLED | Customer (before ACCEPTED) / store / system | Release auth or refund; restock |

Unanswered store: if not ACCEPTED within 15 min (store hours), alert owner by SMS; at 30 min auto-cancel and void authorization.

---

## 10. Payments

- **Stripe Connect** (Express accounts). Each tenant = connected account.
- **Charge model:** destination charges with `on_behalf_of` the store (store is merchant of record for goods; the store's name shows on statements). `application_fee_amount` = platform per-order fee + courier fee recovery.
- **Manual capture:** authorize the order total **plus a buffer of 10% (capped at $20)** at checkout, disclosed to the customer ("you'll be charged the final amount after picking"). Capture the final amount at READY; the unused buffer is released. A swap that costs more (e.g. +$4) needs the customer's tap and must fit within the buffer; swaps that would exceed it are not offered.
- **Refunds:** issue from the order; the platform fee is refunded proportionally per policy; courier fee non-refundable when delivery completed.
- **Tips:** collected with the order, passed to provider tip field.
- **Sales tax:** Stripe Tax. Grocery tax rules vary by state (e.g. DC, MD, VA, TX differ on food). Most launch states have **marketplace facilitator** laws that may make the platform responsible for collecting/remitting. **Needs tax advisor sign-off before launch.**
- **Subscriptions:** Stripe Billing for tenant monthly plans.
- **Payouts:** weekly to the store's bank via Connect.
- Interac/e-Transfer style manual payments: **not supported** (US launch; manual matching was a Danlex pain point).

---

## 11. Delivery

### 11.1 Provider abstraction
```ts
interface DeliveryProvider {
  quote(req: DeliveryRequest): Promise<Quote>;          // fee, pickup ETA, dropoff ETA, expires_at
  create(quoteId: string, req: DeliveryRequest): Promise<Delivery>; // tracking_url
  cancel(deliveryId: string): Promise<void>;
  handleWebhook(raw: Buffer, headers: Headers): Promise<DeliveryEvent>; // verify signature
}
```
Adapters: `UberDirectProvider` (primary), `DoorDashDriveProvider` (fallback). Each tenant location is pre-registered with both.

### 11.2 Flow
1. **Checkout:** estimate quote (primary provider) shown to customer; we lock the **customer-facing** delivery fee (our pricing table or quote + margin, capped).
2. **Ready / Ready-in-X:** fresh quote → create delivery. Ready-in-X dispatches at `X − pickup_eta`.
3. **No courier assigned in 10 min**, or create fails → cancel → create with fallback.
4. Both providers fail → store notified to use own driver or convert to pickup; customer notified with options (wait, pickup, cancel with refund).
5. Webhooks drive state; courier lat/lng streamed to customer map (our map; provider tracking URL as backup).
6. Proof of delivery: photo for standard; **PIN** for frozen and orders > $150.

### 11.3 Eligibility rules
- Distance ≤ tenant radius (default 8 mi, max 15 mi DoorDash limit).
- Total weight ≤ 50 lb and no single item > 50 lb.
- No age-restricted items.
- Frozen: store must confirm insulated bag at handoff (checkbox).

### 11.4 Failed delivery
- Courier return-to-store fee is charged to the customer if cause was customer-side (unreachable/wrong address), otherwise absorbed by platform. Policy shown at checkout.

### 11.5 Own-driver / van (phase 2)
Store marks "deliver myself" → simple driver link (SMS) with map + photo proof; or Onfleet integration for stores with multiple drivers.

---

## 12. Notifications

| Event | Customer | Store |
|---|---|---|
| Order placed | Email + SMS | Push + sound (+ SMS to owner if app closed) |
| Accepted / prep ETA | SMS | — |
| Item short | SMS + push (action link) | Live update on pick screen |
| Ready / courier assigned | SMS with tracking link | Push with courier ETA |
| Picked up / delivered | SMS + photo | Push |
| Issue reported | Email | Push + inbox |
| Daily summary | — | AI copilot digest (WhatsApp or email) |

Channels: Resend (email), Twilio (SMS, WhatsApp Business API), Web Push. Customers choose preferred channel; WhatsApp opt-in.

---

## 13. Data model (core entities)

```
Tenant(id, slug, name, branding, settings, stripe_account_id, plan, status)
Location(id, tenant_id, address, geo, hours, radius_mi, uber_location_id, doordash_store_id)
User(id, email, phone, name)                      -- platform-wide identity
Membership(user_id, tenant_id, role)              -- owner | staff
Customer(id, user_id, tenant_id, marketing_consent, notes)

MasterProduct(id, name, category_id, description, images, unit, weight_g, frozen, perishable)
ProductSynonym(product_id, term, language, region)
Recipe(id, name, cuisine, servings) / RecipeIngredient(recipe_id, product_id, qty, unit)
Substitution(product_id, substitute_id, rank, note)

Listing(id, tenant_id, master_product_id?, custom_name, price, stock_mode, qty, status,
        confidence, confidence_updated_at, max_per_order, active)
ListingVariant(id, listing_id, label, price, weight_g, sku, barcode)
StockEvent(id, tenant_id, listing_id, type[sale|recount|restock|short|adjust], delta, actor, at)

Cart(id, tenant_id, customer_id, source[manual|ai]) / CartLine(cart_id, variant_id, qty, swap_rule, sub_variant_id)
Order(id, tenant_id, number, customer_id, status, fulfillment[delivery|pickup], address, totals..., 
      payment_intent_id, captured_amount, tip, platform_fee, delivery_fee, notes)
OrderLine(id, order_id, variant_id, qty_ordered, qty_picked, unit_price, swap_rule, status, substituted_variant_id)
SubstitutionRequest(id, order_line_id, proposed_variant_id, status, expires_at, answered_at)
Delivery(id, order_id, provider, external_id, status, quote_fee, actual_fee, tracking_url, courier_json, proof_url, pin)
DeliveryEvent(id, delivery_id, type, payload, at)
Refund(id, order_id, amount, reason, lines, stripe_refund_id, initiated_by)
Issue(id, order_id, type, photos, status, resolution)
AiConversation(id, tenant_id, user_id, side[shopper|store], messages_ref) / AiAction(id, conversation_id, tool, input, proposed, confirmed_by, at)
AuditLog(id, tenant_id, actor, action, entity, before, after, at)
```

---

## 14. Architecture & stack

- **Web:** Next.js (App Router, TypeScript), Tailwind + shadcn/ui; PWA for store staff (push, add-to-home-screen).
- **API:** Next.js route handlers / server actions for v1 (single deployable); background work in a worker (queues).
- **DB:** Postgres (Neon or RDS) + Prisma; Row-Level Security for tenant isolation.
- **Queue/jobs:** Inngest or BullMQ (Redis) for timers (substitution timeout, courier failover, confidence decay, digests).
- **Realtime:** Pusher/Ably or Supabase Realtime for order board, live courier location.
- **Storage:** S3/R2 for images, proof photos; image CDN.
- **Search:** Postgres full-text + trigram + synonym table (v1); Typesense/Meilisearch if needed.
- **AI:** Anthropic API (Claude) with tool use; prompt caching for catalog/recipe context; embeddings for product matching.
- **Payments:** Stripe Connect, Stripe Tax, Stripe Billing.
- **Delivery:** Uber Direct API, DoorDash Drive API.
- **Comms:** Resend, Twilio (SMS + WhatsApp).
- **Maps:** Google Maps Platform (address autocomplete, geocoding, distance) or Mapbox.
- **Hosting:** Vercel (web) + managed Postgres + worker on Fly/Render; custom domains via Vercel domains API.
- **Observability:** Sentry, structured logs, uptime checks on webhooks.

---

## 15. Security, compliance, quality

- PCI: card data only via Stripe Elements/Checkout (SAQ A).
- Webhook signature verification (Stripe, Uber `x-uber-signature` HMAC, DoorDash).
- Tenant isolation tests in CI (attempt cross-tenant reads must fail).
- Store users: 2FA; least-privilege roles; audit log for price/stock/refund changes.
- Privacy: customer data per tenant marketing consent; CCPA-style export/delete; no selling data.
- Food: stores remain responsible for food safety licensing; platform terms require it. Perishable handling rules (§11.3).
- Accessibility: WCAG 2.1 AA for storefront.
- Performance: storefront LCP < 2.5 s on 4G; AI first token < 2 s.

---

## 16. Metrics

| Area | Metric | Target (first 90 days) |
|---|---|---|
| Supply | Stores live | 5 in launch metro |
| Supply | Onboarding time | ≤ 1 day |
| Demand | Weekly orders per store | 25+ |
| Demand | 30-day repeat rate | ≥ 40% |
| Quality | Orders with an unapproved substitution | 0 |
| Quality | Short-item rate | < 5% of lines |
| Quality | Issue/refund rate | < 3% of orders |
| Delivery | Courier assigned < 10 min | ≥ 95% |
| AI | Cart built by AI → checkout conversion | ≥ 30% |
| AI | Hallucinated items in eval | 0 |
| Store | Avg time order → Ready | < 25 min |

---

## 17. Phases

### Phase 0: Foundations (weeks 1–2)
Repo, multi-tenant schema + RLS, auth, tenant routing/branding, Stripe Connect onboarding, master catalog seed (≈500 products with synonyms).

### Phase 1: MVP, one store end-to-end (weeks 3–8)
- Storefront: browse, search with synonyms, product pages, cart with swap rules, checkout (auth/capture), pickup + delivery.
- Store admin (phone-first): catalog/stock, order inbox, pick list, short → customer prompt, Ready, handoff.
- Uber Direct integration (quote, create, webhooks, tracking), DoorDash fallback.
- Notifications (email + SMS), order tracking page, issue reporting + refunds.
- AI shopper v1 (search, recipe-to-cart, gaps/substitutes, prepare checkout).
- Pilot with 1 friendly market.

### Phase 2: Multi-store launch (weeks 9–14)
- Onboard 4 more markets; AI photo-to-listing onboarding.
- Store AI copilot (summaries, pick lists, low stock, inventory movement), daily digest.
- Stock confidence scoring + morning quick-check.
- Combined marketplace view for the metro; WhatsApp notifications; own-driver link.
- Reports & payouts dashboard; platform admin console.

### Phase 3: Scale
Second metro, native apps, batch picking, scheduled van slots, nationwide shipping for dry goods, hot food/catering, agentic commerce (MCP/ACP), store reorder from wholesalers.

---

## 18. Open questions

1. **Launch metro:** DMV vs Houston. Need: which market owners we already know, current ACS B05006 data, Uber Direct/DoorDash coverage check for target store addresses.
2. **Pricing numbers:** subscription tier ($49? $99?) and per-order fee ($1–2? 3%?). Validate with 3–5 store owners.
3. **Merchant of record & tax:** confirm destination-charge setup and marketplace-facilitator obligations per state with a tax advisor.
4. **Uber Direct account:** confirm multi-location/organization setup and US pricing for platform accounts; confirm weight limits with both providers.
5. **Brand:** platform name and whether customers see the platform brand at all on tenant stores ("powered by").
6. **Customer accounts across stores:** one platform login (current spec) vs per-store accounts; affects phase-2 marketplace.
7. **Who handles customer support at launch:** platform team, store, or both (tiered)?
8. **Delivery fee policy:** flat by distance band vs pass-through quote; who pays above free-delivery threshold.
