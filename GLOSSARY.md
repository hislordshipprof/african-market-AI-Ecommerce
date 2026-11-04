# African Markets Platform

A shared system that gives each independent US grocery or food store its own branded online store, with ordering, picking and local delivery.

## Stores and people

**Platform**:
The shared system we build and run that powers every store's website and admin. Customers rarely see its name.
_Avoid_: Marketplace

**Store**:
An independent grocery or food business with its own branded website on the platform (e.g. an African market, a Caribbean grocer, a butcher).
_Avoid_: Tenant, Market, Vendor, Merchant

**Storefront**:
A store's customer-facing website, carrying only that store's brand.
_Avoid_: Shop site, store app

**Theme preset**:
One of the platform's ready-made storefront color sets (Palm & Shea, Cocoa & Bottle Green, Lagoon & Coral) that a store owner picks at setup. A store's own brand color replaces the preset's primary color.
_Avoid_: Template, skin

**Store owner**:
The person who runs a store and controls everything about it on the platform.

**Staff**:
A person who works for a store and picks and hands off orders.
_Avoid_: Picker (a picker is staff doing a pick, not a separate role)

**Platform admin**:
A member of our team who sets up stores and supports them.

**Customer**:
A person who buys from a store, whether or not they have an account.
_Avoid_: Buyer, shopper, user

**Account**:
A customer's single login, which works at every store on the platform.

**Guest**:
A customer who checks out with name, email and phone but no account.

**Store directory**:
The public site listing stores by state and location, linking each to its storefront.
_Avoid_: Marketplace, combined app

## Catalog

**Master product**:
A canonical product shared across stores (e.g. "Egusi, ground"), with its local names and synonyms.

**Listing**:
A store's offer of a product: its price, sizes and stock at that store.
_Avoid_: Product (when meaning the store's item), SKU

**Variant**:
A size or weight option of a **Listing** with its own price and weight. Carts and orders point at a variant, so a variant a cart or order uses can't be removed. Customers always see a listing's packs cheapest first.

**Placeholder weight**:
The 100 g weight the platform stores for a variant when nobody has given its real weight. Shown to the owner as "Needs weight" until they enter one.
_Avoid_: default weight, fake weight

**Stock confidence**:
How sure the platform is that a listing's recorded stock is still true, given that counter sales are invisible to it.

**Counter sale**:
A sale made in person at the store, outside the platform.
_Avoid_: Offline sale, POS sale

**Owner report**:
A stock change the store owner tells the Store copilot about (a restock, counter sales, a recount), confirmed with a tap.

## Assistants

**Shopper assistant**:
The AI that shops with a customer: finds items (with photos), builds the cart, confirms the summary and takes them through checkout, and answers their questions about a store. On the storefront first, later on the store's WhatsApp. It never pays by itself: only the customer's tap on a **Confirm card** places the order.
_Avoid_: AI shopper, chatbot

**Confirm card**:
The final card in the Shopper assistant's checkout, drawn by the server from a saved checkout snapshot: items, fulfillment, fees, hold amount and card. Tapping its Place order button is the only way an assistant order is placed.

**Cancel window**:
The 10 minutes after an assistant order is placed during which the customer can cancel it and the card hold is voided. The store is alerted when it ends.

**Store copilot**:
The proactive AI that keeps a store's stock current and tells the owner what needs attention, in the store admin and on WhatsApp.
_Avoid_: Store AI, store assistant

**Daily digest**:
The Store copilot's end-of-day summary for a store owner.

## Ordering and fulfillment

**Order**:
One customer's purchase from exactly one store.

**Swap rule**:
A customer's choice, per order line, of what happens if the item is unavailable: exact item only, let the store suggest, or a named substitute.
_Avoid_: Substitution preference

**Short**:
An order line that staff could not fully pick.
_Avoid_: Out-of-stock (that describes a listing, not an order line)

**Substitution prompt**:
The message asking a customer to approve a swap or a refund for a short line before the order is sent.

**Pick list**:
The ordered list of lines staff collect for one or more orders, with frozen items last.

**Ready**:
The moment staff confirm every line is resolved and the order can be handed off. The final amount is charged at this point.

**Fulfillment option**:
How a customer gets an order: store delivery, courier delivery, or pickup.

**Store delivery**:
Delivery done by the store's own driver, at a fee the store sets.

**Courier delivery**:
Delivery by an on-demand courier company (Uber Direct or DoorDash Drive), chosen by the platform.

**Courier**:
A driver from a courier company. Not a user of the platform.
_Avoid_: Driver (reserve for the store's own driver)

## Relationships

- A **Store** has one **Storefront**, one **Store owner**, and many **Staff**
- A **Customer** with an **Account** can buy from many **Stores**. Each **Store** sees only its own **Customers**
- A **Listing** belongs to one **Store** and usually points to one **Master product**
- A **Listing** has one or more **Variants**. A cart line and an order line point at a **Variant**
- An **Order** belongs to exactly one **Store** and has one **Fulfillment option**
- A **Short** line triggers a **Substitution prompt**, resolved by its **Swap rule** if the **Customer** doesn't answer
