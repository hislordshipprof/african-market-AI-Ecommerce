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
| D1 | Launch geography | **US only; stores onboarded in any state**: no single launch metro ([ADR-0001](../adr/0001-us-only-nationwide-onboarding.md)) |
| D2 | How customers find stores | Each store's own branded storefront; Phase 2 **Store directory** (search by state / near me → store's site), not a combined marketplace ([ADR-0007](../adr/0007-store-directory-instead-of-marketplace.md)) |
| D3 | Revenue | Low monthly subscription + small per-order platform fee; courier fee = real quote, **no markup** ([ADR-0006](../adr/0006-delivery-options-and-courier-selection.md)) |
| D4 | Heavy items (>50 lb item or order) | Not courier-eligible: Store delivery or Pickup. 50 lb is an adjustable platform setting ([ADR-0006](../adr/0006-delivery-options-and-courier-selection.md)) |
| D5 | Store & catalog onboarding | Platform team sets up every store (no self-serve sign-up in v1); AI-assisted catalog (shelf photos → draft listings), store reviews |
| D6 | Couriers | Platform picks the cheaper available of Uber Direct / DoorDash Drive, auto-failover; customer sees the brand, doesn't choose it ([ADR-0006](../adr/0006-delivery-options-and-courier-selection.md)) |
| D7 | Payments | Stripe Connect; each store is a connected account |
| D8 | Who can join | Any independent US grocery/food store; no restaurants in v1 ([ADR-0004](../adr/0004-any-independent-grocery-or-food-store.md)) |
| D9 | Customer accounts | One account across all stores + guest checkout ([ADR-0002](../adr/0002-platform-wide-customer-account-with-guest-checkout.md)) |
| D10 | Branding | Store's brand only; small "Powered by" footer ([ADR-0003](../adr/0003-store-branded-storefronts.md)) |
| D11 | System shape | One shared system for all stores ([ADR-0005](../adr/0005-one-shared-system-for-all-stores.md)) |
| D12 | Phase 1 order | Core loop first; Store delivery (simple) in Phase 1; AI shopper is built in parallel and launched last ([ADR-0018](../adr/0018-agentic-shopper-assistant.md)) |
| D13 | Stock & POS | No POS sync in v1: online sales auto-deduct, proactive Store copilot + owner reports, pick-time check ([ADR-0009](../adr/0009-stock-without-pos-sync.md)) |
| D14 | AI channels | Shopper assistant: storefront (Phase 1), store's own WhatsApp number (Phase 2). Store copilot: admin app + platform WhatsApp number (Phase 1) ([ADR-0010](../adr/0010-whatsapp-channels.md)) |
| D15 | Shopper assistant scope | Agentic shopper: searches with the shopper (incl. product photos and photo uploads), builds the cart, confirms the summary, takes the shopper through checkout with saved details; the order is placed only when the shopper taps a server-drawn confirm card, with a 10-minute cancel window. Answers order status, hours, delivery area and policies from real data; complaints and refunds go to the store ([ADR-0018](../adr/0018-agentic-shopper-assistant.md)) |
| D16 | Promotions | None in Phase 1 (no coupons, points, store credit) |

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
- Category browsing (Tubers, Grains & Flours, Spices, Oils, Vegetables, Fish & Meat, Frozen, Snacks, Drinks, Beauty). Custom-name-only listings (not linked to a master product) do not appear in category browse; they are reachable via search and the all-products view.
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
- **Store closed:** orders are still accepted. The customer sees when the store opens and an estimated ready time. The card is authorized now and the order joins the queue at opening. A store with no opening in the next 7 days, or whose next opening is more than 6 × 24 hours away, refuses the order before any card is held ("This store isn't taking orders right now"), because a card hold lasts 7 days. Scheduled delivery slots come later.
- Payment: card / Apple Pay / Google Pay via Stripe. **Authorize at checkout (total + small buffer), capture the final amount after picking** (see §10). Auth window 7 days; pickup orders > 6 days out not allowed.
- The Stripe Payment Element takes the store's theme: its colors are read from the store's tokens, with Stripe's `night` theme in dark mode, so labels stay AA in both schemes (#379). Stripe Link is turned off in the Payment Element, so our "Save this card for next time" is the only save offer.
- Delivery instructions, apartment/gate code, leave-at-door toggle (disabled when frozen items present).
- Tip (default 0%, owner 2026-11-09; 10/15/20% or custom), passed 100% to courier. Pickup orders carry no tip.

### 5.5 After ordering
- Order page + SMS/email/WhatsApp updates at each state.
- **Shortage prompt:** push/SMS "Egusi 1 lb is out — swap for Egusi 2 lb (+$4) or refund?" Customer has 10 min; no answer → apply the line's swap rule; if rule is *Exact only* → refund that line.
- Live courier map once assigned; drop-off photo/PIN shown on completion.
- **One-tap issue report** within 48 h: missing / damaged / wrong / poor freshness + photo → auto-refund up to a per-tenant limit, otherwise store review queue.
- In-app chat with the store (#429): one support thread per order. The customer writes from the tracking page, opened with the tracking token only (never an order id), and the page polls for replies every 10 s. Sends are limited to 30 an hour per token and 60 an hour per IP. A new customer message pushes "New message" to store members. Any member answers from the store-admin Messages page; unread is the customer messages since the store's last reply, and the dashboard shows the store's total. The first store reply sends one "The store replied" email and SMS with the tracking link; later replies show on the page only. Escalation (#432): the customer picks a topic when opening the thread. A payment, delivery or app thread is escalated at once, and again on each later customer message. For an order thread, each customer message starts a timer of the store's SLA in open minutes (default 30, set in the platform admin store form; a store without hours counts wall-clock minutes); if no store or platform reply came after that message when it wakes, the thread is escalated, once. Platform admins see escalated threads from every store on `/admin/support` with store, order number, topic, age and reason, and can reply or resolve. A store or platform reply sets the thread back to open but keeps when it escalated; it stays on the queue until resolved. The customer sees platform replies labelled "Platform team", and the store sees an Escalated tag. A customer message on a resolved thread reopens it.
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
- **Stock confidence score (0–1)** per listing, from: last manual confirmation, recent sales velocity, recent shortage reports, time since restock. Decays daily. Shown internally; drives storefront badge and AI behavior. Elapsed time alone stops at 0.30, so a quiet owner's listing shows Limited and stays buyable; only shortage evidence goes lower. An owner's stock change restores it to 1.0 at once.
- Quick stock check: phone list "Confirm these 10 fast movers" each morning (30 seconds).
- Bulk price update, variant management, perishable flag, weight per unit, frozen flag, max qty per order.
- **CSV import** (owner only; staff and customers are sent away and nothing is written):
  - `name` and `price` are required. `stock_mode`, `qty`, `status` and one weight column with units are optional. Columns come from the header row, including when the first data row is short.
  - Limits: 2 MB, 5,000 rows, names up to 200 characters. The file must be UTF-8. A UTF-8 BOM is accepted. A file that is not UTF-8 is refused before anything is stored, unless it is a non-CSV signature (ZIP, PDF, PNG or UTF-16), which keeps the non-CSV message.
  - Prices must be above 0. `$` and comma thousands are allowed, with at most 2 decimals.
  - A quantity is a whole number up to 2,147,483,647, either plain digits (`12`, `007`) or digits grouped by commas in threes (`1,000`). The commas in a quantity must be inside quotes. Anything else, including `2.5`, `10 bags` and an unquoted thousands comma, is a row error and that row is not imported. Duplicate known column names are rejected.
  - For each row, a valid `stock_mode` wins (`counted` with an empty qty is qty 0; `status` ignores a valid qty). Otherwise a non-empty qty, including 0, makes the listing counted. Otherwise a non-empty status makes it a status listing. Otherwise the listing is counted with qty 0 when the file has a qty column, and status `in_stock` when it does not. A stock event is written only for a positive counted qty.
  - An active master product's exact name beats another product's synonym. Two exact names stay ambiguous with each other. A product is counted once. Inactive products are not candidates.
  - Among the selected rows, the lowest CSV row wins when two rows would create the same listing. A later duplicate is skipped. A row already listed in that store is skipped.
  - Weight is the CSV weight, then a positive master-product weight, then 100 g marked as a placeholder. A real weight of 100 g is not a placeholder.
  - A preview is valid for 30 minutes, measured at claim time against the database clock, and commits once. Each store keeps at most 10 pending previews; the oldest pending row is dropped in the same locked step that stores the new preview. A commit whose previewed product is no longer the sole candidate is refused and the owner uploads again.
  - A repeat commit of a committed preview, from any tab and with any selection, writes nothing and returns the first commit's result. To import other rows, upload the file again.
  - Server Actions accept bodies up to the CSV cap plus 64 KiB; Next.js allows only one app-wide limit.

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

Model: Claude via tool use, through the Vercel AI SDK. Shopper assistant defaults to Haiku 5.5 and moves to Sonnet 5.5 only if Haiku fails the #146 eval; the model id is a config setting. Build-phase spend cap: $10 total ([ADR-0018](../adr/0018-agentic-shopper-assistant.md)). The cap is measured from a platform spend ledger, by UTC day, that retention never deletes. All tools are server-side, tenant-scoped, and permission-checked; the model never sees other tenants' data.

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
| `show_products(listing_ids)` | Product cards with catalog photo, price and stock, drawn from data |
| `get_cart_summary()` | Item summary card for the shopper to confirm |
| `get_fulfillment_options() / set_fulfillment(option)` | Only options this store and cart allow, with real fees and times |
| `get_checkout_profile()` | Masked facts only ("card on file: Visa 4242"); raw contact, address and card data never reach the model |
| `prepare_checkout()` | Saves an immutable checkout snapshot and shows the confirm card; **cannot place the order** — only the shopper's tap on the card does, via a single-use token that bypasses the model ([ADR-0018](../adr/0018-agentic-shopper-assistant.md)) |
| `get_order_status(order_number?)` | Signed-in customer's own orders at this store only (account Customer plus claimed guest rows, as on the account page): status, lines, last event; newest five without a number. A guest is told to sign in (#26) |
| `check_delivery_area(line1, city, state, zip)` | Geocodes through the checkout address service (cache, then Census) and compares with `Store.deliveryRadiusMi`, equal counts as inside; reports store delivery, pickup, and courier as not offered. A ZIP alone cannot be geocoded, so the assistant asks for the street (#26) |
| `get_store_info()` | Hours, today and open now, minimum order, pickup, delivery fee and radius, owner story (#26). The auto-refund limit is never shown to shoppers (owner decision 2026-11-11). |
| `forward_to_store(order_number?, issue)` | Complaints and refund requests: posts the customer's words with the order number and lines to that order's support thread, then the store is pushed and the SLA timer starts. Signed-in, own orders only; the assistant never resolves or promises a refund (#26) |

**Rules**
- Only add items with confidence ≥ 0.6 as "in stock"; below that, say "may be unavailable — I'll add it with a backup".
- An explicit add fits a listing when English text search, with accents folded, matches the product words against its name, its other name, and its variant labels, or matches a catalog synonym exactly or by that same search. The model passes the product words as query, a named size or pack as pack, and excluded words as exclude. Search drops a row whose name matches exclude. A name fit outranks a synonym: if any result is a name fit, synonym rows in that result are near. Exactly one fit is added. Two or more fits is a choice and no add. A near row stays in the result so a recipe or a browse can use it, and an explicit add of a product does not add a variant that this turn only returned as near. Uniqueness is not forced with limit 1 or an invented brand. Several ambiguous groups are offered one group at a time with each waiting quantity kept. A named pack is the variant whose label shows that pack: the cheapest pack search returns is not a substitute, and show_products is how the other packs are chosen. A missing item is named and gets no substitute unless the customer asks.
- Always show what it added and name an item the search did not return. A missing item gets no substitute unless the customer asks.
- Product cards in the chat carry a quick-add stepper. Like the shelf, it is off for "ask-store" items, and it is off while a reply is still running, so a tap cannot overwrite what the assistant is adding.
- Ask how many people a dish is for when servings are unclear, and do not search or propose until the customer answers. When the customer states how many people a dish serves, search the store for that dish's ingredients in one response, using each plain ingredient name rather than only a narrow variety, pick one listing and one variant per ingredient from those results, and propose a whole-number pack count for each, using more than one small pack when the servings are many times six. Until #25, nothing is added that was not shown in that proposal. A reply that mentions a second option is a known limit. #25 restores one product per ingredient. A product the store sells fills that ingredient. Name an ingredient the search did not return as missing, with no count. Picking one variant applies only while building that dish proposal: a single item the customer asks for still waits on a choice, and the pick does not resolve an open choice, override a named product, pack, quantity, or dietary exclusion, or change the cart on a turn that includes a file. A proposal does not add anything. When the customer accepts that current proposal, add exactly those resolved items at those quantities, keeping the accepted variants, without asking again. A stated quantity overrides the proposal. An acceptance does not revive an older list, skip an unresolved choice, add a product that was not matched, or place an order. A different question ends that proposal, and the answer does not offer to add it.
- An acceptance-led message starts, as a whole word, with yes, ok, okay, sure, go ahead, add those, or add what you suggested. On that turn, `add_to_cart` adds its items only when each product was named in the previous reply or in the customer's own message. If any item was not, the whole call is refused before any cart write and the card says nothing was added. An acceptance phrase outside that list behaves as today, so the guarantee depends on the customer's wording. The check is per product, not per pack or quantity. A second option the proposal mentions stays addable until #25. A proposal does not expire after a time.
- When a turn runs one catalog search that returns two or more products, the reply names two or more of them, and the turn neither offers a choice nor changes the cart, the server draws Choice chips for those products. No extra model call is made.
- Never claims a price or stock it didn't get from a tool. The allowed amounts are the newest keyed unit price from tool outputs in the history sent to the model and this turn, every cent value in this turn's tool outputs, and the store minimum. The item key is the variant id on that price, otherwise the listing id. A newer price for the same key replaces the older one. Totals from earlier turns are not kept, and the model gets no credit for arithmetic: cart tools return the line, added and cart totals. An amount that equals a currently allowed unit price, the store minimum, or a value returned this turn can still appear. USD amounts are recognized in `$`, `US$`, `USD`, `dollars`, `¢` and `cents` forms. Any other currency is removed. A removed amount in a list line reads "price not confirmed"; any other sentence reads "I couldn't confirm that price." No medical/nutrition claims beyond product data.
- Shows product photos on request; accepts shopper photos of an item or a list and matches them through `search_catalog`; may ask for a photo when it can't match a name.
- Never places an order or touches card data. Payment happens only on the shopper's tap on the confirm card; the shopper can cancel for 10 minutes after placing (hold voided).
- Languages: English first; understands Nigerian Pidgin and common Yoruba/Igbo/Hausa/Twi/Amharic/Swahili/Somali food terms via the synonym base.

### 8.2 Store copilot
**v1 (#142).** The owner types an owner report in the store admin. The copilot uses two tools only: `find_listings(query)` and `propose_stock_change(listing_id, kind, quantity?, status?)`. Tools read and validate. They do not write stock. After the model returns, one transaction stores the turn and the **stock proposals**. The owner taps Confirm or Dismiss. Confirm writes one `StockEvent` keyed `copilot:<proposalId>` and updates the listing. A repeat confirm returns the same result and writes nothing.

| Kind | Listing | Confirm writes |
|---|---|---|
| `restock` | counted | `qty` increases by n, event `restock` |
| `counter_sale` | counted | `qty` decreases by n and floors at 0, event `counter_sale`, delta is the true units |
| `recount` | counted | `qty` becomes n, event `recount` |
| `set_status` | status | `status` becomes the value, event `adjust`, delta 0 |

"Out of" is a recount to 0 on a counted listing and `out_of_stock` on a status listing. A proposal expires 60 minutes after it is stored, measured by the database clock. Only a recount or an owner's stock edit supersedes a reservation return. A restock or counter sale does not.

**Which listing.** Code decides, not the model. `find_listings` returns an outcome from the search's match tiers: **one** when exactly one active listing matches every word of the query (exact, prefix or full-text match on its name, master name or a synonym), **several** when more than one does, or when the single match came only through its master product's name or synonyms (not its own listing name) while other listings look like the query ("gari" with Garri and Ijebu garri asks), **did you mean** when none does but trigram look-alikes exist, and **none** otherwise. `propose_stock_change` drafts only the listing of a **one** outcome from the same turn. Any other id gets a fixed tool error. For a **several** or **did you mean** outcome the call drafts nothing: it stores a **choice** (the candidates, kind, quantity or status) on the assistant message, and the panel shows "Which one?" (or "Did you mean?") with a button per candidate. "Rice" with both Rice and Ofada Rice asks; the exact name does not win. One tap calls `chooseProposalListing({ conversationId, messageId, listingId })`, owner only, with no model call. It accepts only a candidate of that stored choice on the owner's own conversation, re-validates the listing (active, stock mode fits the kind, whole number) and drafts the normal pending proposal, which the owner confirms as usual. A second tap returns the same proposal. A choice is refused after 60 minutes (database clock), when the listing was archived or its stock mode changed, when a newer report or choice covers that listing, or when another candidate was already picked. A turn that drafts nothing and offers no choice ends with "Nothing was drafted."

**Voice and photo owner reports (#21).** On the copilot page (or the dashboard card for staff), a store member taps Record and the browser's speech recognition writes the words into a box the owner can edit; where the browser has none, the owner types. A supplier invoice or shelf photo is re-encoded to JPEG and stored privately in `R2_PROOF_BUCKET` under `owner-reports/<storeId>/<reportId>.jpg`; it is never servable by the catalog route. `submitVoiceReport` and `submitPhotoReport` take any store member; `confirmOwnerReportItems` takes the owner only. One forced `report_items` tool call reads the transcript or photo into items (name, whole quantity or none, unit). Each item goes through the same listing search as `find_listings`, tried again without a pack size ("Egusi 5kg" as "Egusi"): **one** is matched at confidence 1, **several** takes the first candidate at 0.6 for the owner to check, and **did you mean**, **none**, or no whole quantity is **unmatched**. A counted listing gets a `restock` line of n; a status listing gets a `set_status in_stock` line. Unmatched lines are stored and shown in their own list, with the reported quantity, and are never written; at most 30 lines are stored and the owner is told to send the rest as a new report. Nothing touches stock until the owner confirms: one tap writes each ticked line through the copilot's stock write (event keyed `owner-report:<itemId>`, confidence back to 1, a `listing.stock_change` audit row) plus an `owner_report.confirm` audit row; unticked lines are rejected; a line whose listing was archived, changed stock mode or would overflow is rejected too. The report becomes `confirmed`, `partial` or `rejected` and cannot be confirmed again; a report with nothing confirmed writes an `owner_report.reject` audit row. Creating the report writes an `owner_report.propose` audit row. The copilot page lists the store's pending reports, newest first (up to 20), so the owner can come back to a report, confirm it, or dismiss it with its unmatched lines; a report whose lines are all unmatched is closed with Dismiss. Staff send reports from a submit-only card on the store-admin dashboard and never see the confirm controls; the owner confirms on the copilot page. The same spend cap and 30 sends an hour per member apply. **Copilot page layout (#469).** The page has one Report stock card with two tabs, Chat (the text copilot) and Voice or photo (this report flow; the tab shows the count of pending reports); the composer follows the content with no fixed-height gap. The photo is picked with a camera button and a file-name chip. Stock alerts show "No stock alerts" when there are none, and the daily digest setting sits at the bottom of the page until the store-owner settings page (#450) exists.

Later tools, not in v1: `list_orders`, `build_pick_list`, `mark_line_short`, `inventory_report`, `low_stock_alerts`, `reorder_suggestions`, `draft_listing`. The spec's `update_stock` is this propose-then-confirm flow.

**Proactive messages:** "3 new orders — 2 need egusi, you have 4 left", "Palm oil 1L sold 18 this week, est. out Thursday", "Gari shortage reported twice today — please recount".

**Copilot alerts and confirm-requests, built in #430.** Alerts live in `copilot_alerts` (store, kind, listing, optional order, state `open | resolved | dismissed`, `dedupe_key` unique per store, `pushed_at`; RLS like every store table, and the policy checks the listing and order belong to the store). Text is a template, never a model call.
- **Order alerts.** `copilot/order-stock-alerts` runs on `order/authorized`, after checkout reserved the stock. Per active listing on the order: counted qty 0 or status `out_of_stock` is `sold_out`; counted qty at or under the store-wide threshold of 5, or status `low`, is `running_low` (one key per listing per store day). Any line on a low or ask-store listing adds one `order_needs_low_stock` alert for the order ("Order #1042 needs Egusi; you have 4 left"). A replayed event adds nothing.
- **Confirm-requests.** After `listing/daily-confidence`, one step adds a `confirm_request` for each active listing below confidence 0.3 (where the storefront shows "ask store") with no open one, keyed per listing per store day.
- **One-tap answers.** The copilot page lists open alerts. The owner answers "Still have N" or "Sold out" on a counted listing, "In stock" or "Sold out" on a status listing, through `answerCopilotAlert` (owner only). It shares the proposal's locked write: one `recount` event (`adjust` for a status listing) keyed `copilot-alert:<id>`, confidence 1 and a `listing.stock_change` audit row naming the owner, with no StockProposal. It resolves that alert and every open alert on the listing. A recount supersedes reservation returns, as an owner count should.
- **Push cap.** Alerts are always written. Push goes to store owners only (`pushToStoreMembers` with `roles: ["owner"]`, tag `copilot-alerts`), at most 2 per store per hour (`takeRateLimit("copilot-push:<storeId>", 2, 1 h)`). Each push claims and summarises every open alert with no `pushed_at`; capped alerts wait for the next allowed push or the digest. Not built: dismissing an alert, alerts from `short` events, WhatsApp.
- **Daily digest, built in #433.** `Store.digestHour` (0 to 23 store time, default 20) is set by the owner on the copilot page (`updateDigestHour`, owner only, audit row `store.digest_hour`). One hourly cron, `copilot/daily-digest` (`TZ=UTC 0 * * * *`), reads one clock, then pages 100 stores per step and picks the non-suspended stores whose local hour (`timezone`, UTC if invalid) equals `digestHour`; there is no per-store event. Each owner gets one email: today's alerts by kind, open confirm-requests, active listings per band (in stock / limited / ask store, from `stock-badge.ts`), orders placed today and the 5 best sellers from today's `sale` stock events. A row in `copilot_digests` (unique store and local date, RLS) is claimed before sending, so a retry, a second run or the DST-repeated hour sends once; a failed send releases the claim. The DST-skipped hour sends nothing that night. Without `RESEND_API_KEY` the run logs one warning and sends nothing. A real sender domain (`EMAIL_FROM`) is owner setup.

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
PICKING ──(all lines resolved)──► CAPTURING ──(Stripe captured)──► { pickup: AWAITING_PICKUP, delivery: READY }
READY ──(courier delivery)──► COURIER_REQUESTED ──► COURIER_ASSIGNED ──► PICKED_UP ──► DELIVERED ──(48 h, no issue)──► COMPLETED
READY ──(store delivery: driver leaves)──► OUT_FOR_DELIVERY ──(delivery proof photo)──► DELIVERED (final; completed_at set at delivery)
AWAITING_PICKUP ──(customer collects)──► COMPLETED
```
Transitional statuses `CAPTURING` and `CANCELLING` are set inside a DB transaction before calling Stripe, so concurrent mutations are blocked while the external call is in flight. A reconcile sweep (Inngest cron, every 15 min) recovers orders stuck in either state by checking the real PaymentIntent status. Together with the 15-minute orphan-event sweep this is 5,760 idle runs in a 30-day month. Checkout does not wait on Inngest: `placeOrder` schedules `order/authorized` after the response. The event id is `order-authorized-<orderId>`, so a retried send and the orphan sweep cannot start a second timer. Both sweeps are singletons (`mode: skip`); a new run is dropped while one is still active. Local timers use `INNGEST_DEV=1` and the Dev Server, with no event key. In production, a missing `INNGEST_EVENT_KEY` is logged once per process as `inngest_event_key_missing`. The order still commits, and the orphan sweep retries the send.

Order recovery visibility, built in #420. `/api/health` requires `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY` in production (`VERCEL_ENV=production`): a missing key returns 503 `degraded`. Previews list both keys in the `env` body without failing, until the owner sets them (#269). `INNGEST_DEV` parsed as true (`1` or `true`) in production is logged server-side with `console.warn`, once per process, without failing and without changing the public body, because Vercel ignores it. Health checks env presence only; it never calls Inngest. Readers of `/api/health` checked before shipping: the preview check in `docs/agents/orchestration.md` stays 200 because previews only report the keys; Playwright's web server runs as `VERCEL_ENV=preview` and stays 200; the e2e servers started as production accept 503; no script in `scripts/` reads it. The platform-admin page **Orders to check** (`/admin/orders/check`, `requirePlatformAdmin`) is computed on load from the database, not by a job, because a broken Inngest is one of the things it shows. It lists each stuck order once, with state, how long, and the reason:

| Reason | Stuck when |
|---|---|
| Card hold expiring | any uncaptured state (AUTHORIZED, ACCEPTED, PICKING, CAPTURING, CANCELLING), created more than 5 days ago |
| Timer not started | AUTHORIZED, no `inngest_event_sent_at`, created more than 15 min ago |
| Timer overdue | AUTHORIZED, 30 min past the cancel timer's 30-open-minute deadline (`timerDeadline`) |
| Retry stalled | CAPTURING/CANCELLING, first `capture_retry`/`cancel_retry` audit row older than 30 min (else `updated_at`) |
| Picking overdue | ACCEPTED/PICKING, prep estimate + 60 min after the later of `accepted_at` and the pickup slot; a slot starting more than 7 days after `accepted_at` is ignored |
| Ready too long | READY 4 h after `ready_at` |
| Out for delivery too long | OUT_FOR_DELIVERY 4 h after `out_for_delivery_at` |
| Waiting for pickup too long | AWAITING_PICKUP 48 h after `ready_at` |

It also lists the newest `acceptance_alert`, `reconcile_failed`, `capture_released` and `refund_request_unknown` row per order and action from the last 7 days, newest first, with store and order number. A row older than 7 days stays while its order is not DELIVERED, COMPLETED or CANCELLED. Candidates are capped at 200 rows in SQL, in three groups with a cap each: AUTHORIZED; ACCEPTED, PICKING, CAPTURING and CANCELLING; READY, AWAITING_PICKUP and OUT_FOR_DELIVERY. Separate caps stop a backlog of uncollected pickups from hiding uncaptured orders. Within a group, the rows SQL already knows are stuck come first, then the oldest: an AUTHORIZED order with no `inngest_event_sent_at`; a CAPTURING or CANCELLING order, an order created more than 5 days ago, or an accepted order with no pickup slot. So orders not yet due, such as pickups scheduled days ahead or orders waiting for a store to open, cannot fill a cap and hide them. The alert list is capped at its newest 200 rows. When a group or the alert list hits its cap, the page says the list may be incomplete, and an empty stuck list then says "No stuck orders among those checked" instead of "No orders are stuck". `audit_logs (action, created_at)` is indexed for this read. The page only shows; acting on a row and sending alerts are not built.

Pickup orders skip the `READY` status entirely: once all lines are resolved and the Stripe capture succeeds, pickup orders move directly to `AWAITING_PICKUP`. Delivery orders move to `READY`, which triggers the courier dispatch flow. This avoids an ambiguous `READY` state for pickup where the customer would need to be separately notified that the order is ready for collection — `AWAITING_PICKUP` already carries that meaning.

Staff see those statuses plus `REFUND_FAILED`. There is no `CAPTURE_FAILED` status. On `REFUND_FAILED`, the inbox tells staff the platform is resolving the refund and that they must not refund the customer themselves. Staff actions return an allow-listed message, or "Something went wrong. Try again, or contact support if it keeps happening." Raw provider text is written only to the server log, with email and phone redacted.

Side states: `CANCELLED` (before PICKED_UP), `DELIVERY_FAILED` → `RETURN_TO_STORE` → redeliver or refund, `PARTIALLY_REFUNDED` / `REFUNDED` after delivery. There is no `ISSUE_REPORTED` order status (owner decision, #428): the issue report carries its own review state, and the order moves only on money.

| Transition | Trigger | Side effects |
|---|---|---|
| DELIVERED / COMPLETED → issue report (#428) | Customer, from the tracking link, within 48 h of `completed_at` (store delivery sets it at DELIVERED, pickup at COMPLETED) | One `issue_reports` row per order (store-owned, RLS): type (missing, damaged, wrong, poor freshness), lines with quantities, optional note, one photo, amount, state. The amount is the sum of `qty_picked × unit_price_cents` for the chosen quantities, never fees or tip. The photo goes through the delivery-proof pipeline to the private proof bucket at `issue-photo/<orderId>/<issueId>.jpg`. At or under the store's `auto_refund_limit_cents` the issue is `auto_refunded` and refunded through the refund ledger; above it, `in_review` with no Stripe call. A second report, a report after 48 h, or lines from another order are refused and write nothing. The public action is limited to 5 an hour per token and 20 an hour per IP. |
| Issue `in_review` → `approved` / `declined` (#431) | Any store member (owner decision 2), from "Problems to review" on the store orders page, which shows each in-review issue's photo, lines, amount and note | A new in-review issue pushes "Problem to review" to the store's members. **Approve** refunds the issue amount; **Partial** refunds an entered amount from 1 cent up to the issue amount and the remaining capture (captured minus succeeded and pending refunds, read from Stripe); a larger amount is refused before anything is written. Both claim the issue under the store lock (`in_review` → `approved`, amount set to the approved cents) with an `issue_approved` audit row naming the member, then refund through `submitRefund` with the `issue` cause, so a second click refunds nothing. If no refund request could be reserved, the issue goes back to `in_review` with an `issue_approval_not_started` audit row. **Decline** needs a reason (up to 500 characters), calls no Stripe and leaves the order; it writes one `issue_declined` audit row with the reason. The customer sees the generic declined message, not the reason. The photo is served by `GET /api/issue-photo/<issueId>` to the issue's store members only, private and no-store; the tracking token never opens it. |
| DELIVERED / COMPLETED / PARTIALLY_REFUNDED → PARTIALLY_REFUNDED → REFUNDED | The refund evaluation, from the ledger | Partly refunded while succeeded refunds are below the capture, Refunded when they equal it. If a refund fails after it succeeded and succeeded refunds drop to 0, the order goes back to Delivered or Completed. The customer gets one "Refund issued" email and SMS per order. A failed issue refund sets the issue to `refund_failed` with one `issue_refund_failed` alert per refund (store and platform), listed in admin Orders to check; the order is not moved to Refund failed. It is failed when Stripe answers or later marks the refund failed or canceled, or when Stripe refuses to create it on both tries (the request is NOT_CREATED, so no refund exists and nothing replays it; the alert is keyed on the request). An ABANDONED request is not failed: it can still become a refund. The customer's report form and tracking page then say the refund did not go through. |

| Transition | Trigger | Side effects |
|---|---|---|
| → AUTHORIZED | Stripe PaymentIntent `requires_capture` | Notify store. Reserve counted stock: `qty` falls by the units available, up to the ordered quantity, with a `reservation` stock event. Placement never refuses on stock. |
| → ACCEPTED | Store tap / auto | Customer notified with prep ETA |
| → SUBSTITUTION_PENDING | Picker marks short | Customer prompt; timer |
| → CAPTURING | All lines resolved | Set transitional status; Stripe capture in flight |
| → READY / AWAITING_PICKUP | Stripe capture succeeded | Delivery re-quote (delivery) or customer notified (pickup). The reservation converts to a sale in the same transaction, for both Ready and Awaiting pickup: a `reservation_release` and a `sale` stock event per line, so stock is not deducted twice. |
| → COURIER_REQUESTED | Ready (or Ready-in-X timer) | Create delivery with provider |
| → COURIER_ASSIGNED | Provider webhook | Courier name/ETA to store & customer |
| fallback | No assignment in 10 min or provider error | Cancel with provider A, create with provider B |
| → PICKED_UP | Provider webhook | Live map starts |
| → DELIVERED | Provider webhook + proof | Proof stored; payout eligibility |
| READY → OUT_FOR_DELIVERY | Staff tap, store delivery only (#134) | `out_for_delivery_at` set; one `delivery_events` row; customer notified. Pickup and courier orders, and any other status, are refused. |
| OUT_FOR_DELIVERY → DELIVERED | Staff tap with a photo, store delivery only (#134) | Photo (JPEG, PNG or WebP by its bytes, no larger than the server-action body limit) re-encoded and uploaded to R2 first, then `delivered_at`, `completed_at` and the proof key set; one `delivery_events` row; customer notified. Terminal for store delivery. READY → DELIVERED is refused. |
| → CANCELLED | Customer (before ACCEPTED) / store / system | Release auth or refund. Return what the order still holds with one `reservation_release` per line, exactly once. A count newer than the reservation supersedes the return (delta 0), so stock is not counted twice. While the order is Refund failed the reservation stays held. |
| AUTHORIZED / ACCEPTED / PICKING → CANCELLING → CANCELLED | One cancel core, `cancelOrder` (#421), with a cause: `store_cancel` (staff, from AUTHORIZED, ACCEPTED or PICKING, with a reason: out of stock, store closed, too busy or other, plus an optional note), `provider_canceled` (Stripe's `payment_intent.canceled` for an order in AUTHORIZED, ACCEPTED, PICKING or CANCELLING), `auto_cancel` (the 30-minute timer, AUTHORIZED only) and `pick_timeout` (#422: ACCEPTED or PICKING 24 h after the later of `accepted_at` and the pickup slot start, never later than created + 6 d 12 h) | Under the store lock: re-check the status, set CANCELLING and write the cause audit row (the staff member for a store cancel; the Stripe event id and `cancellation_reason` for a provider cancel). Then void the hold; refund only when Stripe says it was captured. Then the → CANCELLED effects above. A resumed CANCELLING order keeps its first cause. CAPTURING and every later status are refused: after capture it is a refund (§11.4). Our own void echoes back as `payment_intent.canceled`; on a CANCELLING or CANCELLED order that echo writes nothing. For a CAPTURING order the event runs the reconcile sweep instead. `cancellation_reason` `expired` or `automatic` means Stripe ended the hold. |

Unanswered store: if not ACCEPTED within 15 min while the store is inside its hours, alert owner (store web push with #129; until then, audit record only); at 30 min auto-cancel and void authorization. A day marked `Closed` or `{ closed: true }` is closed. A range whose open and close are the same time contributes no opening interval, on its own day or the following day, and does not suppress a valid overnight interval from the previous day. A range that cannot be parsed counts as open so a malformed schedule does not hide the alert. Null hours mean always open. The 15 and 30 minutes are open minutes counted from the order's acceptance clock, which is the order time when the store was open and otherwise its next opening, so an overnight order is alerted and cancelled after opening. An order placed 10 minutes before closing gets its remaining minutes after reopening. If edited hours leave no way to reach 30 open minutes, the order is cancelled no later than 6 days 12 hours after it was placed, inside the card hold.

Abandoned pick and orphan holds (#422): steps of the 15-minute orphan-event sweep, so the cron budget is unchanged. Each finder runs in its own step after the event and notification resends, so its failure cannot stop them. The pick timeout cancels ACCEPTED and PICKING orders through `cancelOrder` with cause `pick_timeout`, 50 per run, oldest first: 24 hours after the later of `accepted_at` and the pickup slot start (the same `slotStart` as the admin orders-to-check list, which ignores a slot more than 7 days out), and never later than created + 6 days 12 hours. The cap uses the order's creation time, not the charge's `capture_before`, which the order row does not store; customer-initiated card holds last 7 days. A failed cancel is logged and waits for the next run. The orphan-hold sweep reads carts with a PaymentIntent, no order and no release tombstone, not written in the last hour, 50 per run: never-checked carts first, then the least recently checked (`carts.orphan_checked_at`), oldest written first within each, so carts that never paid cannot starve a real hold. For each it retrieves the intent. When it is `requires_capture` and was authorized more than 60 minutes ago, it calls `releaseLosingHold` with `cancellation_reason: abandoned`: tombstone under the store and cart locks, cart cleared, then the void. When it never got a card (`requires_payment_method` or `requires_confirmation`) and the cart was not written for 24 hours, it is released the same way, so dead carts leave the sweep. Otherwise the cart is stamped checked and goes to the back. Reopening the payment step on a cart clears the stamp and touches the cart, so a reused intent is neither cancelled under a returning shopper nor left at the back. Authorization time is the latest charge's `created`, never the PaymentIntent's `created`, since one intent is reused per cart; a `requires_capture` intent without one is logged as `orphan_hold_without_authorization_time`. A later `placeOrder` with that intent is refused as a changed basket, and the shopper's next checkout makes a fresh intent. A Stripe error leaves the tombstone and the hold expires by itself.

---

## 10. Payments

- **Stripe Connect** (Express accounts). Each tenant = connected account.
- **Charge model:** destination charges with `on_behalf_of` the store (store is merchant of record for goods; the store's name shows on statements). Capture, cancel and refund run on the platform account and send no `Stripe-Account` header; the provider takes no connected-account id. `application_fee_amount` = platform per-order fee + card-processing recovery + courier fee recovery, capped at the captured amount. The per-order fee stays $0 until §14 pricing is decided. Card-processing recovery is the published US online rate (2.9% + 30¢) because destination charges debit that fee from the platform. A full cancellation before fulfillment sets `refund_application_fee`, which refunds the fee proportionally (the whole fee on a full refund), including courier recovery, because delivery has not completed.
- **Manual capture:** authorize the order total **plus a buffer of 10% (capped at $20)** at checkout, disclosed to the customer ("you'll be charged the final amount after picking"). Staff mark the order ready and the final amount — goods actually picked, plus tip, plus delivery fee — is captured then. Pickup orders move to Awaiting pickup; delivery orders move to Ready. The unused buffer is released. An amount below Stripe's [50¢ USD minimum](https://docs.stripe.com/currencies#minimum-and-maximum-charge-amounts) voids the hold and cancels the order. A swap that costs more (e.g. +$4) needs the customer's tap and must fit within the buffer; swaps that would exceed it are not offered.
- **Capture retries:** a failed capture waits 30 seconds, then doubles, capped at 15 minutes. After 5 attempts the hold is released. A completed or fulfilled order is a successful capture only when the row already stores the amount; a missing amount is reported as a status change, not a capture of zero. Every 15 minutes the reconcile cron sweeps CAPTURING and CANCELLING orders older than 5 minutes, and also Refund failed orders and orders with an ABANDONED request. Each set is 50 orders, oldest first, and a checked order moves to the back so the next sweep reaches the rest. An abandoned request is matched to a refund the provider already created and is not sent again. A replay is reserved on the request before the provider call, so another server cannot abandon it or record a manual repayment while that call is running. Abandonment re-reads the current row under the store lock and does not overwrite a live reservation. The reservation expires after two minutes if that server stops answering.
- **Store timezone:** each store has an IANA timezone, set on the admin store form. Hours and overnight windows are read in that timezone.
- **Refunds:** issue from the order; the platform fee is refunded proportionally per policy; courier fee non-refundable when delivery completed. One ledger entry point, `submitRefund`, takes a cause: `cancel` refunds the whole remaining capture from Cancelling; `issue` (#428) refunds an amount from Delivered, Completed or Partly refunded, capped at captured minus succeeded minus pending refunds. An issue refund returns the application fee in proportion on pickup and store-delivery orders and keeps it on courier orders, so courier recovery stays with the platform. Each app refund is a RefundRequest, committed before Stripe is called. Stripe is the source of truth for the outcome. Listing a PaymentIntent's refunds stops at 10,000, the most Stripe's `autoPagingToArray` returns; a real order never has that many, and a listing that reaches the cap logs a `stripe_refund_list_cap_reached` alert with no values (#473). A failed refund that leaves the capture uncovered becomes Refund failed. Each such refund keeps its own failure record and time; repeating the same refund does not add another. The admin queue shows that refund's id and when that failure was recorded. It loads the open requests in one query and reads Stripe for up to four orders at once, with each order's capture and refund reads together. The app does not start a second refund while a request is open or a failed refund still leaves the capture uncovered. A platform admin records the amount they repaid, the owed amount they were shown, the re-read refunded and captured cents, and the counted refund ids, and moves the order to Cancelled. That record moves no money. The balance is read again from Stripe just before the store lock is taken, never under it (ADR-0014). Under the lock the order and its open requests are checked again, and a change while the form is submitting refuses the repayment. After the commit the resolve runs the locked evaluation below once, so a refund that changed between that read and the lock still raises its alert. If the entered amount plus the refunds does not equal the capture, the resolution is kept and the store and the platform are alerted. A single locked evaluation then decides the order: a Refund failed order whose coverage is complete is cancelled, and an uncovered terminal failure with nothing open moves it to Refund failed. A cancelling order that is already covered stays in the cancellation flow. After the record, that evaluation compares the succeeded total with the stored baseline, alerts the store and the platform when the balance moves, advances the baseline, and does not reopen the order. An open request that Stripe has not answered after 23 hours becomes ABANDONED and alerts the platform. The alert-only rule and the 23 hour abandon are coordinator defaults, pending owner confirmation. See [ADR-0019](../adr/0019-refund-requests-are-a-ledger.md).
- **Retry keys:** capture and cancel use `capture:<orderId>:<n>` and `cancel:<orderId>:<n>`. A refund key is `refund:<orderId>:<seq>` and is sent as `metadata.reservation`, with `metadata.order_id`. The request row is reserved under the store lock, then Stripe is called after that transaction commits. Releasing an unconfirmed hold writes `capture_released` with a store and platform alert before the order is cancelled. If Stripe cancels the hold but its answer is lost, the next sweep finds the PaymentIntent canceled, sees the stored release request, and still writes `capture_released` with its alert.
- **Tips:** collected with the order, passed to provider tip field.
- **Card processing fees:** paid by the store, deducted from its payout. No customer surcharge (shelf price = checkout price).
- **Sales tax:** Stripe Tax. Grocery tax rules vary by state (e.g. DC, MD, VA, TX differ on food). Most launch states have **marketplace facilitator** laws that may make the platform responsible for collecting/remitting. Platform is built to collect and remit; **no real order until a tax advisor signs off per state** ([ADR-0008](../adr/0008-platform-built-to-collect-sales-tax.md)). `CHECKOUT_LIVE_MODE` enforces this: a live Stripe key fails checkout before any Stripe call unless the flag is exactly `true`, and a live/test key mix always fails. Turning the flag off while a customer holds an authorized PaymentIntent fails their order with zero Stripe calls (a release would itself be a live call), so that hold lapses on its own.
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

Built in #134: staff in the order inbox mark a store-delivery order Out for delivery, then Delivered with a required photo. The **delivery proof** photo is resized in the browser and, if still over the 2 MiB photo cap, re-encoded there at lower quality, so the request always fits the server-action body limit and staff see "too large" rather than a generic error. The server then re-encodes it with sharp: upright, at most 2000px on the long edge, JPEG, with all metadata stripped (no EXIF GPS of a customer's home). The photo is private. It is stored in its own private R2 bucket `R2_PROOF_BUCKET` (never the catalog bucket) under `delivery-proof/<orderId>/<timestamp>-<random>.jpg` (older keys without the suffix still read); if that bucket is not set, staff cannot mark the order Delivered. The photo is uploaded before the transition; if the transition is then rejected (another staff member delivered first), the photo is deleted. If the transaction throws, the photo is kept, since the commit may have landed. It is read only through `GET /api/delivery-proof/<tracking token>`, which resolves the store from the host like the tracking page, accepts the tracking token only (the order id is 404), answers `Cache-Control: private, no-store` and `X-Content-Type-Options: nosniff`, and returns 404 for an unknown token, another store's token or an order with no photo. There are no signed URLs, and the public catalog-image route accepts only `catalog/` keys. Not built: driver link, map, live GPS, PIN, multiple drivers.

---

## 12. Notifications

| Event | Customer | Store |
|---|---|---|
| Order placed | Email + SMS | Push + sound (+ SMS to owner if app closed) |
| Accepted | Email + SMS | — |
| Ready | Email + SMS | Push |
| Out for delivery (store delivery) | Email + SMS | — |
| Delivered (store delivery) | Email + SMS | — |
| Completed | Email + SMS | Push |
| Cancelled | Email + SMS | — |
| Item short | — | Live update on pick screen |
| Issue reported (in review only, #431) | — | Push "Problem to review" + Problems to review on the orders page |
| Daily summary | — | AI copilot digest |

Customer email and SMS go out for placed, accepted, ready, out for delivery, delivered, completed, cancelled and refund issued (once per order, when an issue refund first succeeds, #428). Delivered and completed are the same final step (a store-delivery order ends at delivered, a pickup order at completed), so neither supersedes the other. Each message carries the store's name and an unguessable tracking link. Item short and channel preferences are separate tickets; the owner's daily digest email is #433 (§8.2).

Channels: Resend (email), Telnyx (SMS), Web Push (ADR-0017).

Store web push, built in #129: a store member turns on **Order alerts on this device** on the store-admin orders page. The browser subscribes with the public VAPID key (handed to the page as a server-rendered prop) and the subscription is saved in `push_subscriptions` (store, member, endpoint, `p256dh`, `auth`; RLS like every store table; one row per store and endpoint). On `order/authorized` an Inngest function sends one push per subscribed device of a current member of that store: "New order", the order number and fulfillment, and a link to the orders page. It runs off the checkout path, so a push failure never fails or delays checkout. A push service answer of 404 or 410 deletes that subscription. Without `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` sending is skipped with one warning and the control is hidden. The service worker (`/push-sw.js`) only shows the notification and opens the orders page on click: no caching, no PWA manifest. Copilot alerts push to owners (#430, §8.2). Push for other events, sound, and SMS to the owner are not built.

---

## 13. Data model (core entities)

```
Tenant(id, slug, name, branding, settings, stripe_account_id, plan, status)
Location(id, tenant_id, address, geo, hours, radius_mi, uber_location_id, doordash_store_id)
User(id, email, phone, name)                      -- platform-wide identity
Membership(user_id, tenant_id, role)              -- owner | staff
Customer(id, user_id, tenant_id, marketing_consent, notes)
PlatformCustomerProfile(user_id, stripe_customer_id?, stripe_customer_status, phone?)
CustomerAddress(id, user_id, label, line1, line2?, city, state, zip, notes?, is_default)
CardSaveConsent(id, user_id, payment_intent_id, payment_method_id?, stripe_customer_id, terms_version, purpose)

MasterProduct(id, name, category_id, description, images, unit, weight_g, frozen, perishable)
ProductSynonym(product_id, term, language, region)
Recipe(id, name, cuisine, servings) / RecipeIngredient(recipe_id, product_id, qty, unit)
Substitution(product_id, substitute_id, rank, note)

Listing(id, tenant_id, master_product_id?, custom_name, price, stock_mode, qty, status,
        confidence, confidence_updated_at, max_per_order, active)
ListingVariant(id, listing_id, label, price, weight_g, weight_placeholder, sku, barcode)
ListingImport(id, store_id, csv_text, row_count, status[pending|committed], created_by_id, created_at, committed_at, commit_result?)
StockEvent(id, tenant_id, listing_id, type[sale|recount|restock|counter_sale|short|adjust|reservation|reservation_release], delta, actor, idempotency_key?, at)  # key is one per order line and moment, or `copilot:<proposalId>`, unique per store

Cart(id, tenant_id, customer_id, source[manual|ai]) / CartLine(cart_id, variant_id, qty, swap_rule, sub_variant_id, source[manual|ai])
Order(id, tenant_id, number, customer_id, status, fulfillment[delivery|pickup], address, totals..., 
      payment_intent_id, captured_amount, tip, platform_fee, delivery_fee, notes)
OrderLine(id, order_id, variant_id, qty_ordered, qty_picked, unit_price, swap_rule, status, substituted_variant_id)
SubstitutionRequest(id, order_line_id, proposed_variant_id, status, expires_at, answered_at)
Delivery(id, order_id, provider, external_id, status, quote_fee, actual_fee, tracking_url, courier_json, proof_url, pin)
DeliveryEvent(id, delivery_id, type, payload, at)
Refund(id, order_id, amount, reason, lines, stripe_refund_id, initiated_by)
Issue(id, order_id, type, photos, status, resolution)
AiConversation(id, store_id, cart_id unique, customer_id?, model, tokens_in, tokens_out, cost_micros, messages, in_flight_until, created_at, last_message_at) — one shopper conversation per cart. Store copilot records are the tables below, not these.
CopilotConversation(id, store_id, user_id, model, messages, in_flight_until, tokens_in, tokens_out, cost_micros, created_at, last_message_at) — one owner thread. A send past 100 stored messages starts another.
CopilotClientMessage(id, store_id, user_id, conversation_id?, client_message_id, reply?, claimed_until) — unique per store and owner and client message id, so a repeated send replays the stored turn.
StockProposal(id, store_id, conversation_id, listing_id, client_message_id, kind[restock|counter_sale|recount|set_status], quantity?, status_value?, before, state[pending|confirmed|rejected|expired], expires_at, decided_by_id?, decided_at?) — no foreign key to listings or stock events. The event is found by `copilot:<proposalId>`. Confirmed requires decided_by_id and decided_at.
OwnerReport(id, store_id, actor_id, type[voice|invoice_photo|shelf_photo], status[pending|confirmed|rejected|partial], raw_transcript?, image_key?, ai_extraction, decided_by_id?, decided_at?) — a voice report carries the transcript, a photo report the private R2 key; decided requires decided_by_id and decided_at.
OwnerReportItem(id, report_id, store_id, extracted_name, extracted_qty?, unit?, listing_id?, match_confidence, kind[restock|set_status]?, proposed_delta?, status[pending|confirmed|rejected|unmatched]) — unmatched has no listing, kind or delta; RLS also checks the report and listing are the store's.
      Attachments are stored as descriptors with no bytes. The server's safe name is the stored one, so a card-number filename sent from the sheet is
      stored as `card number removed.jpg` while the in-session chip shows `[card number removed].jpg`. There is no transcript restore, so the two never meet.
      Filename masking checks every 13-19 digit stretch of a run split by anything but a letter, and exempts a run that is one camera date and time. Digits split by letters are not treated as a card.
AiAction(id, store_id, conversation_id, tool, input, output, ok, created_at)
AssistantSpendDay(day, cost_micros, cap_alerted_at) — platform ledger, no store id; retention never deletes it
AssistantFileTurn(id, key, at_ms) — platform rate-limit row, no store id and no RLS (same pattern as rate_limits; GRANT to app_user).
      Key `assistant:files:cart:<cartId>`; 10 file turns per cart per rolling hour. Under pg_advisory_xact_lock(hashtextextended(key, 0))
      it deletes rows with at_ms <= now - window, counts the rest, and inserts one row if under the limit. The check runs before
      file preparation and the turn lease, so every file request that passes body validation and is not a completed-id replay
      takes a row: including ones that then get 409 assistant_busy, attachment_conflict or an unreadable/locked file, and every
      Retry of a failed (uncompleted) file id. Completed-id replays and text turns insert nothing. A cart's expired rows are
      pruned only on that cart's next file turn, so an abandoned cart can leave up to 10 small rows.
AuditLog(id, tenant_id, actor, action, entity, before, after, at)
```

---

## 14. Architecture & stack

Designed for ~1,000 stores, ~1M customers, ~20k orders/day (ADR-0012). Each choice's scale limits, cost and best practices are in ADRs 0013-0017.

- **Web:** Next.js (App Router, TypeScript) on Vercel Pro, one app for storefront, admin and API; middleware resolves the store from the host name. Tailwind + shadcn/ui; PWA for store staff (ADR-0013).
- **Custom domains:** Vercel domains API, queued during onboarding (ADR-0013).
- **DB:** Neon Postgres via its pooled endpoint, branch per PR; Prisma 7; row-level security per store via a transaction-scoped setting (ADR-0014).
- **Auth:** Better Auth: phone one-time codes for customers, organizations and roles for stores, 2FA for owners and staff, built-in rate limiting (ADR-0015).
- **Jobs:** Inngest Cloud free tier for timers and retries (substitution timeout, courier failover, confidence decay, digests) (ADR-0016).
- **Live updates:** Web Push + SMS alerts, ~10 s polling on open boards, courier tracking pages; self-hosted Centrifugo later if needed (ADR-0016).
- **Storage:** Cloudflare R2 + Cloudflare image CDN; proof photos in a separate private bucket `R2_PROOF_BUCKET`, read through the token-checked app route `/api/delivery-proof/<tracking token>`, no signed URLs (ADR-0013, amended 2026-11-09).
- **Search:** Postgres full-text + pg_trgm + synonym table, per-store indexes; pgvector for AI matching; Typesense only if p95 > 300 ms (ADR-0014).
- **Caching:** Next.js cache tagged per store; no Redis until needed (ADR-0017).
- **AI:** Anthropic API (Claude) with tool use; prompt caching for catalog/recipe context; embeddings for product matching.
- **Payments:** Stripe Connect, Stripe Tax, Stripe Billing.
- **Stripe webhooks (sandbox, set up 2026-11-10, #269):** both endpoints post to `https://african-market-ai-ecommerce.vercel.app/api/webhooks/stripe` (the production deployment, which runs on sandbox keys until go-live; previews change URL per deploy and sit behind Vercel's login). "Your account": `refund.updated`, `refund.failed`, `payment_intent.canceled`. "Connected accounts": `account.updated`. `STRIPE_WEBHOOK_SECRET` on Vercel Production holds both signing secrets, comma-separated. Production keys and live endpoints wait for live payments.
- **Delivery:** Uber Direct API, DoorDash Drive API.
- **Comms:** Resend (email), Telnyx (SMS), Meta WhatsApp Cloud API (ADR-0017).
- **Maps:** Photon for address suggestions and the US Census Geocoder for confirmation. No API key. Confirmed coordinates are cached for 90 days (ADR-0017).
- **DNS:** Cloudflare.
- **Observability:** Sentry free tier, Vercel logs, Inngest run history, uptime checks on webhooks; budget alerts on every metered service (ADR-0017).

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
- Courier delivery: Uber Direct + DoorDash Drive, cheaper available wins, auto-failover (ADR-0006).
- Store delivery (simple): store sets fee, taps out-for-delivery / delivered with photo; customer gets SMS updates.
- Notifications (email + SMS), order tracking page, issue reporting + refunds.
- Store copilot v1 (ADR-0009): online sales auto-deduct stock; stock confidence; proactive alerts (sold out, running low, new orders) + daily digest; asks owner to confirm uncertain items; owner reports restocks/counter sales by text, voice or photo in the app or on WhatsApp, one-tap confirm.
- AI shopper v1 (search, recipe-to-cart, gaps/substitutes, prepare checkout, answers status/hours/delivery-area/policy questions), built **last**, after the core loop works.
- Pilot with **1 friendly store** end to end; onboard the next known owners only once it's stable.
- No coupons, loyalty points or store credit in Phase 1 (refunds go back to the card); promotions are a Phase 2 candidate.

### Phase 2: Multi-store launch (weeks 9–14)
- Onboard 4 more markets; AI photo-to-listing onboarding.
- Store copilot, rest of it: weekly reports, sales trends, inventory movement, reorder suggestions.
- WhatsApp ordering for customers on the store's own number (ADR-0010).
- Store directory (search stores by state / near me → storefront; ADR-0007); WhatsApp notifications.
- Promotions: store coupons first.
- Reports & payouts dashboard; platform admin console.

### Phase 3: Scale
Second metro, native apps, batch picking, scheduled van slots, nationwide shipping for dry goods, hot food/catering, agentic commerce (MCP/ACP), store reorder from wholesalers.

---

## 18. Open questions

1. ~~Launch metro~~ **Resolved:** US-wide (ADR-0001). Was: DMV vs Houston. Need: which market owners we already know, current ACS B05006 data, Uber Direct/DoorDash coverage check for target store addresses.
2. **Pricing numbers:** subscription tier ($49? $99?) and per-order fee ($1–2? 3%?). Validate with 3–5 store owners.
3. **Merchant of record & tax:** (build approach settled in ADR-0008; advisor sign-off still needed) confirm destination-charge setup and marketplace-facilitator obligations per state with a tax advisor.
4. **Uber Direct account:** confirm multi-location/organization setup and US pricing for platform accounts; confirm weight limits with both providers.
5. **Brand:** (storefronts are store-branded per ADR-0003; only the platform name remains open) platform name and whether customers see the platform brand at all on tenant stores ("powered by").
6. ~~Customer accounts~~ **Resolved:** ADR-0002. Was: one platform login (current spec) vs per-store accounts; affects phase-2 marketplace.
7. ~~Customer support~~ **Resolved:** the store is first line (in-app chat, refunds). A platform admin handles payment, courier and app issues, or steps in when a store doesn't respond within the SLA (30 open minutes, set per store; owner decision 2026-11-10).
8. ~~Delivery fee policy~~ **Resolved:** ADR-0006. Was: flat by distance band vs pass-through quote; who pays above free-delivery threshold.
