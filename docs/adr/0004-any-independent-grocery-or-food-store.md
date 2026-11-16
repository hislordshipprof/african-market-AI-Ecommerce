# 4. Any independent grocery or food store can join; no restaurants in v1

Date: 2026-10-30 · Status: accepted

## Context
African markets are the core focus, but the team is also talking to other vendors. The ordering loop (list items → order → pick → short prompt → Ready → deliver) is the same for any grocery retailer.

## Decision
Any independent **grocery or food retail store** can be a store on the platform: African, Caribbean, Asian, Latin, butchers, and so on. Restaurants, hot food and catering stay out of scope until Phase 3.

## Consequences
- The master catalog and the AI knowledge base lead with African food, but must not assume every listing maps to an African master product. Custom listings are first-class.
- Categories are configurable per store on top of a shared default tree.
- The brand and marketing still lead with African markets.

## Amendment, 2026-11-15 (#570): grocery stores may sell prepared food

Many African markets sell jollof, suya or puff-puff from a counter. A grocery store may now list
**prepared food** next to its groceries. Restaurants still cannot join: a store must be a grocery or
food retail store first, and prepared food is part of its listings, not a separate restaurant menu.
Catering and made-to-order modifiers (sides, spice level) stay out.

- A listing has a prepared flag: **hot** or **cold**, with its **prep time** in minutes (0 to 120).
- Tax: a prepared listing uses Stripe Tax code **`txcd_40060003`** ("Food for Immediate Consumption":
  prepared, ready-to-eat and heated food, and food sold with utensils), looked up with
  `GET /v1/tax_codes` on 2026-11-15. It wins over the category's code, so a dish in an exempt grocery
  category is still taxed as prepared food. Hot and cold use the same code; Stripe applies each state's
  rules for it (ADR-0008).
- Allergens: a prepared listing is on sale only while its store owner has stated its allergens
  (allergens group `known` on the listing). Until then it is saved off sale; withdrawing the statement
  takes it off sale in the same write. The shopper assistant applies needs to it as to any product.
- Prepared lines are always **exact item only**: no store swap and no named substitute. Placement
  writes them as exact item only whatever the cart line said; the assistant never gives them a backup.
- Prep time: an order's prep estimate is the store's prep time plus its longest prepared item (they are
  made side by side). Pickup times and the auto-accept estimate use it.
- Leave at door is off for hot items, for store delivery and courier alike.
