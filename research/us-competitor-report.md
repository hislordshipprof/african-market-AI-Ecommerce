# US competitor scan & review gaps: African grocery delivery (2026-10-30)

Target market: United States. Method: agent-reach + web search. Reddit was unreachable (agent-reach upstream error, no hits via search); Google Maps reviews not reachable. Evidence comes from App Store, Trustpilot, ComplaintsBoard, press. [U] = unverified.

## Competitors

| Competitor | Model | Cities | Delivery | Fees / AI | Rating / status |
|---|---|---|---|---|---|
| OjaExpress | Ethnic grocer marketplace (+ store software, 2022) | Chicago → DMV, zip-gated | Own gig drivers [U] | $29.99 min per store on multi-store orders; no AI | US App Store 404; "temporarily unavailable" [U] |
| ETNOWE | Grocery + restaurant marketplace | TX, MD, GA, IN (Dallas, DC focus) | 2–4 hr or pickup, stores within 50 mi | Free delivery promo; $300K pre-seed; no AI | iOS 4.8 (19) |
| African Dishout | Mostly restaurants + some grocers; 120 partners, 250K orders | NY, NJ, MA; "expanding" DC/Houston/MD/ATL/CHI | Own drivers | Fees n/a; no AI | Old app 3.83 (135), pulled; new app 5.0 (14) |
| Bakkal | Ethnic grocer marketplace (not African-focused) | LA, Bay Area | Delivery/pickup | Possibly dormant [U] | n/a |
| Weee! (analogue) | Own inventory, next-day + nationwide ship | Major metros | Own fleet + parcel | Chatbot added v26.7 | iOS 4.8 (121K); Trustpilot 2.1 |
| Instacart | Marketplace; Storefront Pro white-label | Nationwide | Gig shoppers | 15%+ markup; **Clementine AI cart assistant (Sep 2026)** | iOS 4.8; Trustpilot 1.2 (12K) |
| Uber Eats | Marketplace; some Ethiopian grocers listed | Nationwide | Gig | Commission 20/25/30% (Mar 2026), pickup 7% | — |
| DoorDash | Marketplace; Dallas Ethiopian grocers listed | Nationwide | Dashers | 15/25/30%, pickup 6% | — |
| Gopuff | Own micro-fulfillment | Nationwide | Own | No African range found | — |

Nationwide/regional online African grocers: My Sasun (ships 48 states, insulated frozen; free next-day DFW/Houston over $75), Ethnic District (Atlanta, brand marketplace), Afelabu (Houston [U]), Abart Foods (DMV same-day), Afayi (DFW same-day over $100).

## Review gap themes
1. Missing items / silent cart edits (Weee!, Instacart)
2. Unapproved substitutions (Weee!, Instacart; ~11% of Instacart complaints [U])
3. Freshness & perishable packaging (rotten produce, melted frozen)
4. Phantom stock (out of stock hours before delivery)
5. Markups & hidden fees (Instacart −23% to +168% vs in-store; +12% bills)
6. Customer service / refunds unresponsive; ETNOWE praised for owner fixing issues fast
7. Delivery reliability (wrong address, never received)
8. App bugs (address not saving; app errors ignored)
9. Thin coverage & selection; African apps pulled from App Store, "expanding to…" for years
10. Store owners: 15–30% commission, tablet offline issues, payout delays

## Launch-city data
African-born by metro (Census ACS 2008–12): NYC 212K, DC 161K, Atlanta 68K, LA 68K, Minneapolis 64K, DFW 61K, Boston 60K. Houston: largest Nigerian community (Harris Co. ~35K Nigerian-born, 2020 [U]). Next step: pull ACS table B05006 for current numbers.

## Gap → feature
| Gap | Build |
|---|---|
| Missing items | Picker checks each line against AI pick list; shortages trigger customer approve/refund **before** courier is called; receipt photo at handoff |
| Substitutions | Per-item rule in AI cart: exact only / AI-suggested / contact me; nothing swapped without a tap |
| Phantom stock | Stock-confidence score that decays on stale SKUs; AI only promises high-confidence items |
| Freshness | Freshness notes/grades, frozen picked last, same-day courier only, cold-bag rule |
| Markups | Shelf price = app price, itemized delivery fee upfront |
| Support | One-tap photo refund for short/damaged items; in-app chat with store owner |
| Delivery | Uber Direct primary, DoorDash Drive auto-failover, live map, photo/PIN drop-off |
| Coverage | Branded store per market + "nearby partner store" fill-in; dense metro cluster first |
| Store pain | Flat SaaS / low fee, weekly payouts, phone/web admin (no tablet), AI order summaries & pick lists |
| Instacart Clementine | Win on cultural depth: local names (ugu, ogiri, teff), pidgin, recipe-to-cart for real dishes and serving sizes |

---

*Sections below merged from the earlier Canada-focused report (2026-10-30), kept where they apply to the US.*

## AI assistant landscape
- **Customer side:** Instacart Clementine (Sep 2026) + white-label Cart Assistant + ChatGPT Instant Checkout; Uber Eats Cart Assistant (Feb 2026: text/photo list → cart, user confirms); DoorDash recipe-to-cart in ChatGPT; Walmart Sparky (meal plan → cart, auto-reorder); Amazon Rufus (Buy for Me, Auto Buy). All generic, inside giant platforms.
- **Agentic checkout standards:** OpenAI/Stripe Agentic Commerce Protocol (ACP, Sep 2025), Google AP2 and UCP (Jan 2026). Design so ChatGPT/Gemini agents can later shop our stores.
- **Merchant side:** Shopify Sidekick (generic admin copilot), Local Express (catalog enrichment), enterprise replenishment (Afresh, Blue Yonder). No small-store tool turns orders into pick lists and explains stock movement in plain language.

## White-label platforms (why they don't fit small African stores)
Local Express, Instacart Storefront Pro / Rosie, Freshop (NCR), GrocerKey, Mercato: quote-based, sales-led, POS-dependent, chain-focused; Instacart products tie customer data to Instacart. Shopify / Ecwid ($35–149/mo) / Square Online: generic, no pick lists, substitutions or weighted items.

## Delivery providers (US)
| Provider | Use | Multi-store | Price (US docs) | Notes |
|---|---|---|---|---|
| **Uber Direct** | Primary | Organizations / locations API (confirm with sales) | Distance-based, negotiated; API access typically at ~1,000+ deliveries/mo, which a platform account clears | Quote (~15 min expiry) → create → webhooks with courier lat/lng, tracking URL, photo/signature/PIN proof; ~50 lb item guidance; scheduled up to 30 days |
| **DoorDash Drive** | Fallback | Explicit businesses + stores API | $9.75 base ≤5 mi + $0.75/mi, max 15 mi; −$2.75 if 100% tip passed; return-to-store 60% | Self-serve sandbox, production after demo |
| Burq / Shipday | Aggregator option | Yes | Per-delivery + % fee | One API routing to Uber + DoorDash |
| Onfleet / Tookan | Store's own drivers | Yes | SaaS | For heavy/bulk orders |
| UPS / USPS | Non-perishables only | — | — | Nationwide shipping of dry goods later |

**Design rules:** request courier only when store taps Ready (re-quote then); auto-failover if no courier in N min; weight per product with heavy orders routed to pickup / store driver; frozen = cold bag + PIN/photo, no leave-at-door; charge customer the quoted fee, pass tips through, define who absorbs failed-delivery costs.

## Risks
- **Supply side:** most stores have no digital catalog. Budget onboarding; AI drafts listings from shelf photos.
- **Inventory accuracy without POS:** stock-confidence scoring + confirm at pick time + swap/refund flow.
- **Courier economics:** ~$10–12 delivery on a $40 basket; use minimum order / free-delivery thresholds.
- **Payouts & compliance:** Stripe Connect (each market = connected account, platform fee per order); sales tax per state.
- **Incumbents:** Instacart Clementine and Uber Eats courting ethnic grocers. Moat = community brand + cultural AI + store tools + lower fees.

## Architecture sketch
- **Multi-tenant:** one codebase, `tenant` on every row, subdomain/custom domain → tenant. Next.js + Postgres (Prisma).
- **Payments:** Stripe Connect.
- **Delivery:** `DeliveryProvider` interface with Uber Direct + DoorDash Drive adapters; webhook-driven state.
- **Order states:** `PLACED → PAID → ACCEPTED → PICKING → READY → COURIER_ASSIGNED → PICKED_UP → DELIVERED`, plus `SUBSTITUTION_PENDING`, `CANCELLED`, `REFUNDED`, `RETURN_TO_STORE`.
- **AI (Claude, tool use):** shopper tools `search_catalog`, `add_to_cart`, `check_stock`, `suggest_substitute`, `prepare_checkout` (never pays without approval); store tools `list_new_orders`, `build_pick_list`, `mark_item_unavailable`, `inventory_report`, `low_stock_alerts`.
