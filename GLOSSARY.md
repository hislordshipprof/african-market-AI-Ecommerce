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
A member of our team who approves store applications, sets up stores and supports them.
_Avoid_: Platform team (only the customer-facing label on a platform admin's support reply)

**Plan override**:
A plan a platform admin gives a store until a date, with a reason (for example, comped Pro). It decides the store's plan features while it runs, even over a Stripe downgrade, and never changes what Stripe bills. It always has an end date; after it, the store's Stripe plan applies again.

**Store application**:
A request to join the platform from the public "Sell on African Markets" page on the root domain: business name, kind of store, address, owner name, email, phone, a web or social link, and whether the store offers pickup or delivery today. A platform admin approves it, which creates the store in setup and invites the owner, or rejects it with an internal reason the applicant never sees. Rejected applications are deleted once the retention set by the platform admin (default 12 months) has passed since the decision.
_Avoid_: Sign-up, lead, merchant application

**Setup**:
Where every new store starts, from an approved store application or the stores page. Its storefront shows "Opening soon", checkout is refused before any payment call, and the Store directory never lists it. Stores created before the go-live checklist stayed live.
_Avoid_: Draft, pending, password page

**Go-live checklist**:
What a store in setup must finish before it goes live, shown on the store admin home and the platform admin's store page: payouts connected, hours and time zone set, pickup or a delivery option on, at least the go-live listing floor of active listings with a price (a platform setting, default 20), no placeholder weights on active listings, a plan chosen or a pilot store, and courier registration done or not needed (Starter). A test order is recommended after going live, never required.

**Go live**:
The store owner's button that moves a store from setup to live once every checklist item is done, with an audit row. A platform admin can go live for a store with items still open, only with a reason, which the audit row keeps.
_Avoid_: Launch, publish

**Suspended**:
A store a platform admin took offline. Suspension is separate from going live and wins over everything: the storefront is offline, checkout is refused and the store cannot go live. Lifting it returns the store to where the suspension found it, setup or live.

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
The public site listing stores by state and location, linking each to its storefront. Its state and city pages (`/stores/texas/houston`) exist only while a listed store is there. Each store card shows open now or when it opens, pickup and delivery, the owner's face and story, and after a near me search the distance and whether the store delivers to you (its own radius only; a courier is only "may be available").
_Avoid_: Marketplace, combined app

**Directory listing**:
A store's entry in the Store directory: the owner's "Listed in the directory" switch (off by default; a platform admin can override it), a blurb of at most 160 characters, and up to 3 cuisine tags from a fixed list. The street address is never part of it.
_Avoid_: Profile, store page

**Directory order**:
An order placed within 30 days of the shopper arriving on the store's site from a Store directory link (`?ref=directory`, kept in a first-party cookie that says only "directory"). The order stores `acquisitionSource = 'directory'`; the owner's dashboard counts them.
_Avoid_: Referral, marketplace order

**Near me**:
The Store directory search by ZIP code, city or the shopper's location (asked for only on a tap). It lists listed stores within 50 miles, nearest first, with their distance; with none that close it shows the nearest few, a Store request panel, and then the state list, which also answers a location outside the US. ZIPs and cities are looked up in Census Gazetteer tables seeded into Postgres.
_Avoid_: Store locator, geo search

**Store request**:
A shopper's "tell me when a store opens near me" from the Store directory: a ZIP and an email or US mobile number, with consent. It gets one message when a listed store is within 50 miles of that ZIP, and its contact is then deleted. Platform admins see the requests by state and ZIP as onboarding leads.
_Avoid_: Waitlist, lead form, store suggestion

## Catalog

**Master product**:
A canonical product shared across stores (e.g. "Egusi, ground"), with its local names and synonyms. Its status is active, needs review, rejected, archived or merged. Only an active one matches a CSV row or a shelf photo, and an archived one is also left out of the store's product picker. Archiving replaces deleting: listings already on the product keep selling unchanged. Platform admins edit it under Products in the admin console; its ingredients, allergens and dietary claims change only through Catalog review. A re-seed of the catalog keeps what an admin changed (#613).
_Avoid_: Deleting a master product

**Duplicate pair**:
Two master products in the same category that may be the same product, proposed by the duplicate scan and judged by Claude as same, different or unsure. A platform admin merges the pair or marks it not a duplicate; a pair marked not a duplicate is never proposed again.

**Merged product**:
A master product folded into another by a duplicate merge. Its listings (every store's, none deleted), synonyms, recipe links and ingredient links moved to the product kept, and it points at that product. It is read-only and never matched or proposed again. A merge cannot be undone in the admin console; the audit log keeps the record.
_Avoid_: Deleted product, duplicate removed

**Synonym**:
Another name a shopper searches for a master product: a local name ("egusi" in Yoruba), a regional name or a spelling ("garri"). It may carry an ISO 639 language code and a region. One product never has the same term twice; two products may share one ("agushi" names whole and ground egusi), and the admin editor warns when they do.
_Avoid_: Alias, keyword

**Category**:
A platform-wide aisle (e.g. "Grains & Flours") that master products belong to, with a local name, a photo and a place in the order. A category may sit under one top-level category as a subcategory; there is no deeper level. Its slug never changes after creation.
_Avoid_: Department, collection (a store's own curated list)

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

**Reorder list**:
The owner's saved list of what to buy from a wholesaler, started from the copilot's reorder suggestions and edited by the owner. One draft per store; saving replaces it. It orders nothing and changes no stock.

**Stock proposal**:
A pending owner report the Store copilot drafted and has not applied. Stock changes only when the owner confirms it. Dismissing it writes nothing to the shelf.

## Assistants

**Shopper assistant**:
The AI that shops with a customer: finds items (with photos), builds the cart, confirms the summary and takes them through checkout, and answers their questions about a store. On the storefront, and on the store's own WhatsApp number (#559), where it replies only inside Meta's 24-hour window and checks out through a **WhatsApp checkout link**. It never pays by itself: it hands off to the normal checkout with a **Review card**, and only the customer's Pay tap there places the order. Shoppers see it labelled "Shop with AI" (owner, 2026-11-10), so it is plainly an AI.
_Avoid_: AI shopper, chatbot, "the helper" in shopper-facing copy

**Choice chips**:
The tappable product options the Shopper assistant shows when more than one item fits. The server also draws them when a reply names two or more products from a single search and the model did not offer a choice. Tapping a chip sends that product's name and pack back as the customer's pick.

**Item handle**:
A short name such as `i3` (listing), `v12` (variant) or `c2` (cart line) that the Shopper assistant's tools show the model in place of a long id, and take back as input (#597). Each conversation keeps its own handles, so one never resolves in another conversation or store; an unknown handle is refused, never guessed.

**Shopper constraint**:
An allergen to avoid, a dietary claim that must hold, or an ingredient to avoid, taken from the customer's words and saved on the conversation (#485). The Shopper assistant checks them on Product attributes only, never by matching product names: search leaves out an excluded listing, and add and swap refuse one with the reason. A constraint is hard: it gates search, recipes, add and swap. An ingredient term that names only a form of a known Ingredient, such as fresh tomato, triggers the clarify rule; one close to no known Ingredient is not saved, and the assistant says once that it can't check it. While any is saved, the store's own swap is not used: a may-be-unavailable line with no backup that passes gets Exact item only, a refund, including lines already in the cart (owner, 2026-11-12). A budget and the items the customer has at home are saved on the same conversation but are not constraints (#476): a budget refuses only an add or a quantity raise that would take the item subtotal over it, and an item at home only leaves that ingredient out of a recipe; neither gates search or swap.

**Shopper preference**:
A form of a known Ingredient the customer would rather skip, such as fresh tomato, saved on the conversation (#485). Unlike a Shopper constraint it gates nothing and never gives Cannot confirm: the assistant skips products of that form when it chooses from search results.

**Clarify rule**:
When a ruled-out term matches no Ingredient or local name but is close to one in the ingredient table, the assistant carries on and asks one short question: avoid all of that Ingredient, or only that form? "All" saves a Shopper constraint on the Ingredient; "only that form" keeps the Shopper preference (#485, owner 2026-11-12).

**Cannot confirm**:
A listing whose attribute for a Shopper constraint is unknown. It is shown marked as such, never as a fit and with no quick-add on its card, and added only after the customer's next message confirms that one item. The confirmation is recorded on the conversation and covers only the constraints unknown when it was given.

**Acceptance-led message**:
A customer message that starts, as a whole word, with yes, ok, okay, sure, go ahead, add those, or add what you suggested. On that turn the Shopper assistant adds a product only when the previous reply or the customer's own message named it.

**Recipe base**:
The platform-shared dishes the Shopper assistant knows: seeded dishes mapped to master products with quantities for a number of servings, plus dishes it looked up online and saved as ingredient names and a source link, so the next request makes no web call. Not store data; the result is always matched against one store's catalog. The #146 eval uses seeded dishes only and never looks one up (#607).

**Review card**:
The last card in a Shopper assistant chat before paying, drawn by the server from the normal checkout quote: items, pickup time, fees, total and card hold. Its "Review and pay" button opens the normal checkout. It is information, not consent: it places nothing, and checkout shows the current basket (#247).
_Avoid_: Confirm card (the parked 2026-11-04 design; replaced 2026-11-14)

**Cancel window**:
Not used. The assistant-only 10-minute cancel window was dropped on 2026-11-14 (#247), because assistant orders are placed by normal checkout.

**Store copilot**:
The proactive AI that keeps a store's stock current and tells the owner what needs attention, in the store admin and on WhatsApp.
_Avoid_: Store AI, store assistant

**Daily digest**:
The Store copilot's end-of-day summary for a store owner.

**Weekly report**:
The Store copilot's Monday email to a store owner about the store week just ended (Monday to Sunday, store time), against the week before. The last 8 are on the copilot page.

**Copilot alert**:
A stock alert the Store copilot raises for the store owner: sold out, running low (a counted listing at 5 or fewer, or a status listing marked low), or an order that needs a low or ask-store item. Owners only; at most 2 pushes per store per hour.

**Confirm-request**:
A Copilot alert asking the owner to confirm a listing whose confidence fell below 0.3. The owner answers with one tap ("Still have N", "Sold out" or "In stock"), which recounts the listing at confidence 1. It is not a Stock proposal and does not expire.

**Linked WhatsApp number**:
The WhatsApp number a store owner has verified for their store; the Store copilot recognises the owner by it on the platform's WhatsApp number, or by Meta's business-scoped user id (BSUID) when the owner has adopted a WhatsApp username and Meta omits the number.

**WhatsApp checkout link**:
The link the Shopper assistant sends on WhatsApp when a customer is ready to check out. It opens the store's normal checkout with the cart the chat filled, works once and for 60 minutes, and places nothing: the customer pays on that page, as a guest or signed in. A used or expired link shows "This checkout link has expired".

**WhatsApp order updates**:
Order status messages a customer gets on WhatsApp from the Store WhatsApp number instead of SMS, after ticking "Get order updates on WhatsApp" at checkout (default off, offered only when the store's number is Live). Email is unchanged. If a WhatsApp message cannot go, that update goes by SMS once. Replying STOP turns them off for that store.

**Store WhatsApp number**:
The store's own WhatsApp Business number, which customers message (ADR-0010). Linked by the owner or a platform admin through Meta's Embedded Signup (in test mode, ids typed into a form); "Live" once registered. By default the store keeps the WhatsApp Business app on it (coexistence). Not the Linked WhatsApp number, which is the owner's personal number.

**Daily sample**:
The AI conversations a platform admin reviews for one UTC day (#544): up to N random Shopper assistant chats and N random Store copilot chats per store whose last message fell on that day, plus every auto-flagged chat. N is an AI and onboarding setting, 5 by default; 0 shows only auto-flagged chats. The same day always shows the same sample.

**Auto-flag**:
A reason the platform marks an AI chat for review without a person: the grounder removed an amount, a tool refused a made-up id, a constraint or Cannot confirm refusal, `forward_to_store`, or a turn over the cost threshold (an AI and onboarding setting, 2 cents by default). A shopper turn is marked when it is saved, so a later threshold change applies from the next turn; copilot chats and transcript views use the threshold in force when viewed.

**Review label**:
A platform admin's verdict on one AI chat: wrong item, wrong price, unsafe, tone or other, with an optional note. Stored in `ai_review_flags`, owned by the chat's store, and deleted with the chat or after 90 days.
_Avoid_: Flag (on its own), rating

## Ordering and fulfillment

**Order**:
One customer's purchase from exactly one store.

**Store coupon**:
A code a store owner creates (#556) that takes a percent or a fixed amount off the goods of one order; the store funds it. A cart takes one code. The discount is never on tip or fees, is recomputed on the goods picked at capture, and is never removed by a short (#557). Shown to the shopper as "Promo CODE".
_Avoid_: Voucher, promo (alone), discount code

**Coupon use**:
An order placed with a store coupon. It counts toward the code's total and per-customer limits until the order is cancelled.

**Tracking link**:
The unguessable link in every customer message that opens the order's tracking page without signing in.

**Driver route**:
One slot's Ready store-delivery orders handed to the store's own driver (#566). The driver gets an SMS with a route link that needs no login: stops in nearest-next order, Navigate, Out for delivery, and Delivered with a delivery proof photo. The link works until midnight at the end of the store day and the store can revoke it.

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

**Batch**:
2 to 4 Accepted orders of one store that staff pick together from one combined Pick list (#564). Each shared item is one line with its total and its split per order; each order has a tote letter (one bag per order), A for the oldest. Units found fill the oldest order first, so a Short lands on the newest. While an order is in a batch it is picked only from the batch; leaving the batch keeps what is picked. "Start packing" on the batch's packing screen starts packing every order and books the courier for courier orders (Ready time).
_Avoid_: Wave (a warehouse term for many batches)

**Ready**:
The moment staff confirm every line is resolved and the order can be handed off. Marking it ready captures the final amount (goods picked, plus tip, plus delivery fee). Pickup orders then show Awaiting pickup. Delivery orders show Ready.

**System actor**:
The actor on audit rows written by timers and crons, when no person did the action.

**Capture released**:
The audit recorded when an unconfirmed card hold is released after capture does not settle. The store and the platform are both alerted.

**Orders to check**:
The platform-admin page that lists stuck orders and the alert rows nothing else reads. A stuck order has stayed in one state past its limit, such as a capture still retrying after 30 minutes.

**Order search**:
The platform-admin page that finds any order at any store: by store and order number, exact customer email or phone, status, fulfillment, and a date range read as store days in each store's own time zone. Results are 50 to a page, newest first. It is read only. Opening an order shows its lines, money, timeline, refund requests, deliveries, issue reports and support thread, and writes a `platform.order_view` audit row naming the admin; going Back or Forward to it writes a new row before the data shows again. Captured shows what Stripe captured, and when if the app saw the capture happen; it stays after a refund or cancellation cleared the order's capture. Every thread has a link; Open in Messages appears only for a thread in the Messages queue. The tracking link shows only its last four characters.
_Avoid_: Order lookup, order explorer

**Refund failed**:
The capture still stands because the refund did not cover it. Staff see that the platform is resolving the refund and do not refund the customer themselves. There is no Capture failed status. The reconcile cron keeps checking until the capture is covered or an admin records the repayment. The queue shows the failed refund's id and when that failure was recorded. A later, different failure keeps its own time.

**Resolved manually**:
A platform admin recorded the amount they repaid outside the app. The order becomes Cancelled. The app moves no money. The record is the amount the admin entered, plus the refunded and captured cents. If that amount does not meet the capture, the store and the platform are alerted.

**Platform refund**:
A refund a platform admin makes from the order detail (#538) when the store does not act or the problem is the courier's or the app's: an amount from 1¢ up to what is left on the payment, and a reason of up to 500 characters. It goes through the refund ledger like an issue refund and comes out of the store's transfer; on a courier order the platform keeps its fee and returns only the service fee share and, when the platform collected the tax, the tax share (#65). A `platform_refund` audit row names the admin, the amount and the reason. The store sees "Refunded by the platform team" on the order in its inbox, and the customer gets the usual refund message once per order.
_Avoid_: Goodwill credit, manual refund (that is Resolved manually)

**Dispute**:
A customer asked their bank to reverse a card payment (#539). Stripe calls an early one an inquiry (status `warning_…`) and a formal one a chargeback. On our destination charges Stripe takes the disputed amount and its fee (US $15) from the platform balance, and the platform absorbs a lost dispute in v1; the store's payout is not touched, and recovering it from the store is a later manual decision. The `charge.dispute.*` webhooks are the only writer of the `payment_disputes` row: amount (may be less than the order), reason, status, evidence due date, outcome (won, lost or inquiry closed) and Stripe's fee. The store's owners get one push and the order shows Disputed in the store inbox while the dispute is open. A dispute whose charge matches no order is kept with no order and emailed to platform admins. Platform admins see open disputes on the Disputes page, soonest deadline first, and submit evidence in the Stripe Dashboard, not in the app.
_Avoid_: Chargeback (as the general term), claim

**RefundRequest**:
One refund the app asked Stripe for. The row stores the key, the amount, the fee flag, its service fee share and tax share (#65), and the Stripe Tax reversal it owes and, once made, its id (#671). Stripe's refund object is the source of truth for what happened to the money.

**Fee ledger**:
The platform admin's monthly report of what the platform keeps (#546), at `/admin/billing/ledger`, built from our order and refund rows, not from Stripe. Each captured order is a row: captured amount, service fee, courier fee passed through, the platform's card fee share, the application fee, and the platform net (service fee less the platform's card fee share). An order counts in the month its capture was confirmed; a cancel, refund or manual repayment never changes that row. A refund that returns fee is a negative row in the UTC month it succeeded, and a manual repayment is its own row in the month it was recorded. Months are UTC calendar months.
_Avoid_: Commission report

**Sales tax**:
The tax Stripe Tax works out for an order (#65, ADR-0008), shown before Pay as "Estimated tax" (Ready works it out again on the picked goods) and kept on the order with its lines and the **tax liable party**: `platform` (the default; the platform collects and remits as marketplace facilitator, so the tax is kept out of the store's payout) or `store`. Pickup is taxed at the store's address, delivery at the delivery address. Worked out again on the picked goods at Ready, where each order line keeps its own tax, and recorded as a Stripe tax transaction after capture. A refund returns the exact tax of the lines it refunds and reverses that part of the transaction (#671).
_Avoid_: VAT

**Open request**:
A RefundRequest that is still unanswered: reserved, unknown, or created at the provider but not yet succeeded, failed or canceled. Manual repayment waits until no request is open.

**ABANDONED**:
An open refund request that was still unknown 23 hours after it was created, and was not in the middle of a replay. The platform alert is written in the same locked transaction, so a failed insert does not leave the request abandoned. A refund that shows up later is still recorded, and the reconcile cron keeps matching it without sending the request again. A replay stays open until the provider answers, including on another server. Abandonment re-reads the current row under the store lock and does not overwrite a live reservation. This window is a coordinator default, pending owner confirmation.

**Issue report**:
A customer's one report of a problem with a finished order, made from the tracking link within 48 hours of completion: missing, damaged, wrong or poor freshness, with the items and quantities, an optional note and one photo. Its amount is the picked quantity times the unit price of the chosen items, less their coupon share, plus their service fee share and the exact sales tax of those lines (#65, #671); never tip or delivery. At or under the store's auto-refund limit it is refunded to the card at once (auto refunded); above it, it waits for the store (in review). Its states are auto refunded, in review, approved, declined and refund failed. A second problem goes through the store, not a second report.

**Partly refunded** / **Refunded**:
Order statuses after delivery, set only from money: Partly refunded while the succeeded refunds are below the capture, Refunded when they equal it. A reported problem alone does not change the order's status. A failed issue refund marks the issue refund failed and alerts the store and the platform; the order never becomes Refund failed, which is only for cancellations.

**Fulfillment option**:
How a customer gets an order: store delivery, courier delivery, or pickup.

**Store delivery**:
Delivery done by the store's own driver, at a fee the store sets.

**Slot**:
A time window a customer books for pickup or store delivery, set by the store and shown in the store's timezone. Each slot takes a set number of orders; a cancelled order frees its place.
_Avoid_: Time slot, Delivery window

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

**Courier settings**:
The platform-wide rules a platform admin sets for courier delivery: the selection mode (cheapest, DoorDash first or Uber first), the assignment timeout, which couriers are on, and the weight limit. Per-metro settings are not built (#577).

**AI and onboarding settings**:
The platform-wide numbers a platform admin sets at `/admin/settings/ai-onboarding` (#561): the go-live listing floor (1 to 200, default 20), the Daily sample size per store (0 to 20, default 5), the Auto-flag cost threshold (1 to 100 cents, default 2) and how long a rejected store application is kept (1 to 24 months, default 12). Out of range is refused, never clamped; every save writes an audit row, and the page shows who changed them last and when.

**Assignment timeout**:
How long a booked courier delivery may wait for a courier before failover cancels it and books the other courier. 5 to 20 minutes; 10 by default.

**Courier incident**:
A courier order where something went wrong: failover, both couriers failed, the courier company cancelled, the order came back to the store or the return failed, a courier was assigned after the assignment timeout, or it was delivered with no proof. One per order. Listed for platform admins at `/admin/couriers/incidents`; worked out from the delivery events each time the page opens, never stored. Only an admin's notes, and whether it is resolved, are stored. A newer incident event reopens a resolved one.

**Courier**:
A driver from a courier company. Not a user of the platform.
_Avoid_: Driver (reserve for the store's own driver)

**Ready time**:
When a courier order's bag will be packed. Set when packing starts (the first line picked or marked short, or "Start packing" on a Batch) from the item count and the store's recent packing pace, at least 10 and at most 45 minutes out; the courier is booked for it then. The store can push it once by 5 minutes ("5 more minutes").

## Relationships

- A **Store** has one **Storefront**, one **Store owner**, and many **Staff**
- A **Customer** with an **Account** can buy from many **Stores**. Each **Store** sees only its own **Customers**
- A **Listing** belongs to one **Store** and usually points to one **Master product**
- A **Listing** has one or more **Variants**. A cart line and an order line point at a **Variant**
- An **Order** belongs to exactly one **Store** and has one **Fulfillment option**
- A **Short** line triggers a **Substitution prompt**, resolved by its **Swap rule** if the **Customer** doesn't answer
