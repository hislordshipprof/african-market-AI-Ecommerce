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
_Avoid_: Platform team (only the customer-facing label on a platform admin's support reply)

**Customer**:
A person who buys from a store, whether or not they have an account.
_Avoid_: Buyer, shopper, user

**Account**:
A customer's single login, which works at every store on the platform.

**Guest**:
A customer who checks out with name, email and phone but no account.

**Claimed order**:
A guest order at a store that is linked to a customer's account because the account's verified email matches the email given at checkout. The order keeps the contact details it was placed with.

**Address book**:
The addresses a customer saves on their account and can reuse at any store. A store sees an address only when that customer uses it on an order.
_Avoid_: Wallet

**Saved card**:
A card the customer agreed to keep on their account, shown as brand and last four, and reusable at any store while they are signed in.
_Avoid_: Wallet, payment profile

**Store directory**:
The public site listing stores by state and location, linking each to its storefront.
_Avoid_: Marketplace, combined app

## Catalog

**Master product**:
A canonical product shared across stores (e.g. "Egusi, ground"), with its local names and synonyms.

**Listing**:
A store's offer of a product: its price, sizes and stock at that store.
_Avoid_: Product (when meaning the store's item), SKU

**Listing import**:
A CSV file a store owner uploaded, held for 30 minutes between its preview and the one commit that turns the chosen rows into listings.
_Avoid_: product import, upload token

**Variant**:
A size or weight option of a **Listing** with its own price and weight. Carts and orders point at a variant, so a variant a cart or order uses can't be removed. Customers always see a listing's packs cheapest first.

**Placeholder weight**:
The 100 g weight the platform stores for a variant when nobody has given its real weight. Shown to the owner as "Needs weight" until they enter one.
_Avoid_: default weight, fake weight

**Stock confidence**:
How sure the platform is that a listing's recorded stock is still true, given that counter sales are invisible to it.

**Stock reservation**:
The counted units an order holds from the moment it is placed. Capture converts them to a sale, and a cancel returns them, each exactly once. Holding units never refuses an order: it takes what is recorded, down to zero.
_Avoid_: Stock hold (a hold is the card authorization), stock lock

**Counter sale**:
A sale made in person at the store, outside the platform.
_Avoid_: Offline sale, POS sale

**Owner report**:
A stock change the store owner tells the Store copilot about (a restock, counter sales, a recount), confirmed with a tap.

**Product attributes**:
A product's ingredients, allergens (the US top 9) and dietary claims (halal, kosher, vegan, vegetarian, no pork, gluten free). Each group has a status: unknown, known (a store owner stated it) or reviewed (a platform admin approved it). Unknown is never safe: under a shopper's exclusion or dietary need it means "cannot confirm", neither included nor excluded.
_Avoid_: tags, labels

**Ingredient**:
One row per ingredient, under one lower-case English name, with its local names as synonyms (e.g. "ata rodo" for scotch bonnet pepper).

**Attribute proposal**:
Product attributes Claude read from a master product's label photo and description, waiting for a platform admin to approve or reject. Nothing on the product changes until approved.

**Listing draft**:
One product Claude read from a store's shelf photo, matched to the master catalog (one match, several for the owner to pick, none, or already listed). It becomes a listing only when the owner sets or checks its price and taps Publish. The shelf photo stays private and is never a product image.

**Stock proposal**:
A pending owner report the Store copilot drafted and has not applied. Stock changes only when the owner confirms it. Dismissing it writes nothing to the shelf.

## Assistants

**Shopper assistant**:
The AI that shops with a customer: finds items (with photos), builds the cart, confirms the summary and takes them through checkout, and answers their questions about a store. On the storefront first, later on the store's WhatsApp. It never pays by itself: only the customer's tap on a **Confirm card** places the order. Shoppers see it labelled "Shop with AI" (owner, 2026-11-10), so it is plainly an AI.
_Avoid_: AI shopper, chatbot, "the helper" in shopper-facing copy

**Choice chips**:
The tappable product options the Shopper assistant shows when more than one item fits. The server also draws them when a reply names two or more products from a single search and the model did not offer a choice. Tapping a chip sends that product's name and pack back as the customer's pick.

**Shopper constraint**:
An allergen to avoid, a dietary claim that must hold, or an ingredient to avoid, taken from the customer's words and saved on the conversation (#485). The Shopper assistant checks them on Product attributes only, never by matching product names: search leaves out an excluded listing, and add and swap refuse one with the reason. A constraint is hard: it gates search, recipes, add and swap. An ingredient term that names only a form of a known Ingredient, such as fresh tomato, triggers the clarify rule; one close to no known Ingredient is not saved, and the assistant says once that it can't check it. While any is saved, the store's own swap is not used: a may-be-unavailable line with no backup that passes gets Exact item only, a refund, including lines already in the cart (owner, 2026-11-12).

**Shopper preference**:
A form of a known Ingredient the customer would rather skip, such as fresh tomato, saved on the conversation (#485). Unlike a Shopper constraint it gates nothing and never gives Cannot confirm: the assistant skips products of that form when it chooses from search results.

**Clarify rule**:
When a ruled-out term matches no Ingredient or local name but is close to one in the ingredient table, the assistant carries on and asks one short question: avoid all of that Ingredient, or only that form? "All" saves a Shopper constraint on the Ingredient; "only that form" keeps the Shopper preference (#485, owner 2026-11-12).

**Cannot confirm**:
A listing whose attribute for a Shopper constraint is unknown. It is shown marked as such, never as a fit and with no quick-add on its card, and added only after the customer's next message confirms that one item. The confirmation is recorded on the conversation and covers only the constraints unknown when it was given.

**Acceptance-led message**:
A customer message that starts, as a whole word, with yes, ok, okay, sure, go ahead, add those, or add what you suggested. On that turn the Shopper assistant adds a product only when the previous reply or the customer's own message named it.

**Recipe base**:
The platform-shared dishes the Shopper assistant knows: seeded dishes mapped to master products with quantities for a number of servings, plus dishes it looked up online and saved as ingredient names and a source link, so the next request makes no web call. Not store data; the result is always matched against one store's catalog.

**Confirm card**:
The final card in the Shopper assistant's checkout, drawn by the server from a saved checkout snapshot: items, fulfillment, fees, hold amount and card. Tapping its Place order button is the only way an assistant order is placed.

**Cancel window**:
The 10 minutes after an assistant order is placed during which the customer can cancel it and the card hold is voided. The store is alerted when it ends.

**Store copilot**:
The proactive AI that keeps a store's stock current and tells the owner what needs attention, in the store admin and on WhatsApp.
_Avoid_: Store AI, store assistant

**Daily digest**:
The Store copilot's end-of-day summary for a store owner.

**Copilot alert**:
A stock alert the Store copilot raises for the store owner: sold out, running low (a counted listing at 5 or fewer, or a status listing marked low), or an order that needs a low or ask-store item. Owners only; at most 2 pushes per store per hour.

**Confirm-request**:
A Copilot alert asking the owner to confirm a listing whose confidence fell below 0.3. The owner answers with one tap ("Still have N", "Sold out" or "In stock"), which recounts the listing at confidence 1. It is not a Stock proposal and does not expire.

## Ordering and fulfillment

**Order**:
One customer's purchase from exactly one store.

**Tracking link**:
The unguessable link in every customer message that opens the order's tracking page without signing in.

**Support thread**:
The one conversation about an order between its customer and the store, opened from the tracking link. A platform admin can join it.
_Avoid_: Chat (the shopper assistant and store copilot are chats too), ticket

**Escalated thread**:
A support thread handed to the platform admins: the store did not reply within its SLA, or the problem is payment, courier or the app.

**Acceptance clock**:
When an order's 15-minute alert and 30-minute auto-cancel start counting: the order time if the store was open, otherwise its next opening. They count open minutes from it. Stored on the order and never changed by later hours edits.

**Store cancel**:
Staff cancel an order before capture (Authorized, Accepted or Picking) with a reason: out of stock, store closed, too busy or other, plus an optional note. The card hold is voided and the stock it held is returned. After capture it is a refund, not a cancel.

**Cancel cause**:
Why an order was cancelled before capture: a store cancel, the 30-minute auto-cancel, a pick timeout, or Stripe ending the card hold. It is written when the order starts cancelling and never changes.

**Pick timeout**:
An Accepted or Picking order nobody finished is cancelled 24 hours after the later of acceptance and its pickup slot start, and never later than 6 days 12 hours after it was placed, inside the card hold. Picked goods go back on the shelf by hand; the stock returns at once.
_Avoid_: Abandoned order (ABANDONED is a refund request state)

**Orphan hold**:
A card hold on a cart that never became an order, for example when the shopper closed the tab after confirming the card. It is released 60 minutes after authorization, timed from the charge, not from when the PaymentIntent was created.

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
The moment staff confirm every line is resolved and the order can be handed off. Marking it ready captures the final amount (goods picked, plus tip, plus delivery fee). Pickup orders then show Awaiting pickup. Delivery orders show Ready.

**System actor**:
The actor on audit rows written by timers and crons, when no person did the action.

**Capture released**:
The audit recorded when an unconfirmed card hold is released after capture does not settle. The store and the platform are both alerted.

**Orders to check**:
The platform-admin page that lists stuck orders and the alert rows nothing else reads. A stuck order has stayed in one state past its limit, such as a capture still retrying after 30 minutes.

**Refund failed**:
The capture still stands because the refund did not cover it. Staff see that the platform is resolving the refund and do not refund the customer themselves. There is no Capture failed status. The reconcile cron keeps checking until the capture is covered or an admin records the repayment. The queue shows the failed refund's id and when that failure was recorded. A later, different failure keeps its own time.

**Resolved manually**:
A platform admin recorded the amount they repaid outside the app. The order becomes Cancelled. The app moves no money. The record is the amount the admin entered, plus the refunded and captured cents. If that amount does not meet the capture, the store and the platform are alerted.

**RefundRequest**:
One refund the app asked Stripe for. The row stores the key, the amount and the fee flag. Stripe's refund object is the source of truth for what happened to the money.

**Open request**:
A RefundRequest that is still unanswered: reserved, unknown, or created at the provider but not yet succeeded, failed or canceled. Manual repayment waits until no request is open.

**ABANDONED**:
An open refund request that was still unknown 23 hours after it was created, and was not in the middle of a replay. The platform alert is written in the same locked transaction, so a failed insert does not leave the request abandoned. A refund that shows up later is still recorded, and the reconcile cron keeps matching it without sending the request again. A replay stays open until the provider answers, including on another server. Abandonment re-reads the current row under the store lock and does not overwrite a live reservation. This window is a coordinator default, pending owner confirmation.

**Issue report**:
A customer's one report of a problem with a finished order, made from the tracking link within 48 hours of completion: missing, damaged, wrong or poor freshness, with the items and quantities, an optional note and one photo. Its amount is the picked quantity times the unit price of the chosen items, never fees or tip. At or under the store's auto-refund limit it is refunded to the card at once (auto refunded); above it, it waits for the store (in review). Its states are auto refunded, in review, approved, declined and refund failed. A second problem goes through the store, not a second report.

**Partly refunded** / **Refunded**:
Order statuses after delivery, set only from money: Partly refunded while the succeeded refunds are below the capture, Refunded when they equal it. A reported problem alone does not change the order's status. A failed issue refund marks the issue refund failed and alerts the store and the platform; the order never becomes Refund failed, which is only for cancellations.

**Fulfillment option**:
How a customer gets an order: store delivery, courier delivery, or pickup.

**Store delivery**:
Delivery done by the store's own driver, at a fee the store sets.

**Delivery radius**:
The straight-line distance, in miles, from the store's confirmed coordinates. An address at exactly that distance is inside the area.

**Leave at door**:
The customer asked the store to leave the order without a handoff. Frozen items cannot use it.

**Out for delivery**:
A store-delivery order the store's driver has left with. The step between Ready and Delivered.

**Delivery proof**:
The photo the store's driver takes when a store-delivery order is delivered. Required to mark it Delivered. Private: stored in its own private bucket, and only the order's tracking link opens it. The order id does not. A courier's drop-off photo is copied into the same bucket.

**Drop-off PIN**:
A 4-digit code the courier must get from the customer at the door. Required for an order with a frozen item or a total above $150; other courier orders get a Delivery proof photo instead.

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
