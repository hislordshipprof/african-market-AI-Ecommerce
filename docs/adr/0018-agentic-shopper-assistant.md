# 18. Agentic shopper assistant

Date: 2026-11-04 · Status: accepted

## Context

The shopper assistant (D14, D15, §8.1) was specced to build carts and stop at checkout. The owner wants more: an agentic shopper that goes all the way to a placed order. It should shop the way a person does: search with the shopper, show product photos, confirm the item summary, pick pickup or delivery, use saved contact, address and card details, and pay.

Placing orders from an AI chat raises three risks: prompt injection, wrong prices or totals, and card-data exposure. This ADR records the decisions that keep those risks closed. The full flow, edge cases and feature ideas are in the reviewed spec page "Agentic Shopper Flow" (https://claude.ai/artifact/6LMFRWQog2ZnLgCUaSwyJ9).

## Decision

### Scope and channel

- **Storefront chat first:** a floating button opens a bottom sheet on phones and a side panel on desktop. Store WhatsApp stays in Phase 2 (ADR-0010).
- **Guests can use it.** Building a cart needs no sign-in. Order status needs sign-in or the order's tracking link.
- **Build order:** v1 is cart building (#145) plus the golden eval (#146). Store questions (#26) and recipes/photo lists (#25) follow. D12 changes from "AI shopper is the last Phase 1 slice" to **"built in parallel, launched last"**.
- **Recipes are ingredient lists mapped to the store's products.** The assistant does not give cooking instructions. Amended 2026-11-11 (owner, #25; replaces "about 40 dishes, drafted by AI and approved by the owner in an admin review queue"):
  - a small curated base is seeded from `prisma/recipe-base.json`, each ingredient mapped to a master product where one exists;
  - a dish not in the base is looked up online once with Anthropic's web search. Only ingredient names and a source link the search returned are kept, and the result is saved to the shared base with no owner review, so the base grows itself and the next request makes no web call;
  - each store may start 20 lookups per UTC day, and the search fee is counted in the assistant spend;
  - a looked-up dish never takes a name a curated dish already answers to;
  - web pages are data, never instructions, and other shops' prices and products are never kept.

### Product photos in chat

- Shoppers can ask to see items ("show me a picture of the egusi you have"). The assistant answers with product cards that carry the catalog photo, name, price and stock. The cards come from tool results, never from model text. When a product has no photo, the card says so.
- Shoppers can send a photo:
  - a photo of an item ("what is this called, do you have it?"): the model identifies it, then the identification goes through `search_catalog`;
  - a photo of a handwritten or printed list: each line goes through `search_catalog`.
- When the assistant can't match a name, it may ask the shopper for a photo.
- Shoppers can also send a PDF, such as a recipe, a shopping list or a flyer.
- Attachments (amended 2026-11-05; replaces the original rule of images up to 10 MB kept with the transcript):
  - at most 3 per message: JPEG, PNG or WebP photos, and PDFs of at most 10 pages, 3 MB in total. Vercel Functions take at most 4.5 MB per request on every plan, and base64 adds about a third;
  - photos are resized on the device to a 2000 px long edge. HEIC works only where the browser can decode it; our server build of sharp can't, and Claude doesn't accept it;
  - the server checks the real file type, then re-encodes every photo with sharp, which removes EXIF and location data;
  - files are **not stored**. They reach the model only on the turn they were sent. The transcript keeps a safe filename, the type, size and page count, so the 90-day transcript rule needs no file cleanup. No bucket, signed URL or new secret is needed. A larger limit would need direct upload to a private R2 bucket, which is a later decision;
  - file content is untrusted data. On a turn with a file, the tools that change the cart are switched off, so text inside a file can't change the basket. The assistant reports what it found and the shopper taps or types to add it;
  - we can't scrub a card number out of a picture. The composer asks shoppers not to send cards or IDs, the model is told not to repeat such numbers, and replies pass the existing card scrub before they are saved.
- Shoppers can speak instead of typing (added 2026-11-05):
  - the mic uses the browser's own speech recognition. It costs nothing, needs no key, and no audio reaches our servers. Claude can't take audio here, so voice has to become text first;
  - words appear in the composer, stay editable and send only when the shopper taps send. Typed-message rules apply, including the card scrub;
  - the mic is hidden where the browser has no speech recognition. Firefox is the known gap;
  - the browser maker's service may process the audio, so the mic says "Your browser turns your speech into text" and the privacy policy must cover it;
  - if real shoppers find names like egusi and ogbono too often wrong, the next step is a paid speech service that accepts a store word list. That needs a new vendor and key, so it is the owner's call.

### Checkout and payment (amended 2026-11-14, #247: the assistant hands off to normal checkout)

The 2026-11-04 design (a confirm card in the sheet, a single-use `checkoutToken`, a second PaymentIntent path and a 10-minute cancel window) was parked on 2026-11-11 and replaced on 2026-11-14 (owner decision, Build Board 2026-11-14-10; PR #359 closed unmerged).

- The assistant fills the cart and picks fulfillment with the shopper, then **hands off to the normal checkout**. Money moves only on that page's Pay button.
- `get_fulfillment_options` returns today's pickup slots, worked out on the server in the store's timezone: "As soon as it is ready" while the store is open and the order can be ready before closing, then every 30 minutes from the opening plus prep time until closing or local midnight. Overnight hours follow the store-open check. A store closed for the rest of the day, or with pickup off, offers none and says so. Delivery and its address are chosen on the checkout page.
- `set_fulfillment` saves pickup and an offered slot to a **checkout draft** on the conversation (store-scoped by the conversation's RLS). The checkout page reads the draft for the same session cart and pre-selects the slot if the store still offers it.
- `prepare_checkout` returns the **Review card**: lines, the pickup slot, subtotal, service fee, tax ($0 until #65), total and hold, from the same pure quote function normal checkout uses, and a "Review and pay" button to `/checkout`. Contact, address and card are entered or chosen only on that page. The card is information, not consent: checkout always shows the current basket.
- No model tool and no assistant route can reach Stripe, create a PaymentIntent or call `placeOrder`. The import-boundary test walks every assistant module and the assistant API routes and forbids the Stripe provider, the checkout payments adapter, the checkout service and actions, saved-card payment and the account loaders.
- There is no assistant-only cancel window and no delayed store alert: an order placed through checkout is a normal order. Saved cards work because normal checkout supports them (#248).
- **Card data never touches the model.** Cards are entered only on the checkout page, in Stripe's Payment Element. If a shopper types a card number into the chat, it is removed before the message reaches the model or the transcript.
- **Saved cards:** a Stripe Customer on the platform account. "Save this card for next time" is offered on the first order, needs the shopper's tick, and can be listed and removed from the account page. Cards work across stores through the existing destination charges.
- **Saved addresses:** an address book on the platform customer account (ADR-0002). An address is copied into an order only when used, so a store never sees addresses from other stores' orders. The address book is built in #248 and used at checkout by store delivery (#15). Pickup needs no address.
- **Guest contact details** are entered on the checkout page, so names, phones and emails stay out of model prompts and transcripts.

### Safety and grounding

- Every tool runs server-side through `storeScoped()` with Postgres RLS. The cart comes from the session (`resolveShopperCart`), never from the model.
- Prices, stock, fees and totals reach the shopper only from tool results. The allowed amounts for a reply are the newest keyed unit price (`priceCents` or `unitPriceCents`, keyed by `variantId` or else `listingId`) from tool outputs in the history sent to the model and this turn, every `*Cents` value in this turn's tool outputs, and the store's `minimumOrderCents`. Totals from earlier turns are not kept, and sums or multiples of allowed amounts are not allowed: the cart tools return `lineTotalCents`, `addedTotalCents` and `subtotalCents` instead. An amount that happens to equal a currently allowed unit price, the store minimum, or an amount returned this turn can still appear. User text, tool inputs and assistant text never add amounts. USD amounts (`$12.34`, `US$12.34`, `USD 12.34`, `12.34 USD`, `12.34 dollars`, `99¢`, `99 cents`) are checked as cents. Any other currency symbol, code, or name is removed, whether it is written before or after the number. A removed amount in a list line becomes "price not confirmed"; anywhere else the sentence becomes "I couldn't confirm that price." Newly generated replies never say "(see card)". A replay of an already stored reply is not grounded again.
- Store-written listing text is data, never instructions.
- Stock confidence below 0.6 (§8.1): the item is added as "may be unavailable" with a backup swap rule. Without saved shopper constraints, that line never becomes "Exact item only": `set_swap_rule` refuses `exact_only` on it (owner, 2026-11-11). While the shopper has saved constraints, a may-be-unavailable line with no backup that passes them gets "Exact item only" (a refund), never the store's unchecked swap (owner, 2026-11-12, #485).

### Model, library and cost

- **Library:** Vercel AI SDK (`ai` + `@ai-sdk/anthropic`), installed as published at ai-sdk.dev. Not LangChain or LangGraph: the flow is a single agent with about 10 tools, and the SDK gives streaming to React, typed tools and step limits without an orchestration layer we don't need.
- **Model:** **Claude Haiku 5.5** by default. The #146 eval separates the customer-visible CI gate from the model verdict. The gate fails on a hallucinated item, an excluded item in the cart, an ungrounded amount that the shopper still sees, a safety-rule miss (a may-be-unavailable line without a backup is one, except Exact item only when the conversation saved needs and no named backup passes them; owner, 2026-11-12), micro precision below 0.90 or micro recall below 0.85 on shopper-supplied lists, or fewer than 85% of dish-only cases passing. A dish-only case ("jollof for 6", no list) passes when the cart has the dish's core items this store sells, any brand, pack or quantity, with nothing made up, no excluded item, and a servings question when servings are unclear. Dish cases stay out of the precision and recall counts (owner, 2026-11-11). Egusi greens count only leaves, fresh, frozen or dried, not leaf powders such as baobab or moringa. "Agushi" names both whole and ground egusi, so either one passes (owner, 2026-11-11). When a requested item matches more than one product in the store, one short question naming the options, with nothing added, also passes. The options are the listings that turn's search returned as fits, shown on `offer_choices` cards or named in the reply, and one of them must be the requested item. The scorer reads them from the catalog and the tool results, not from a hand list (owner, 2026-11-12). Amounts the grounder removes, and amounts the model stated before a tool had returned them, keep the verdict at `sonnet-candidate` even when the gate passes. `haiku-ok` requires the gate and a raw reply with none of those amount misses. Switching to **Claude Sonnet 5.5** is a later decision. The model id is a config setting, not code.
- **Model decision (owner, 2026-11-11): Haiku 5.5 at its default settings.** The #146 comparison ran the same 200 cases and floors on three settings. Effort high made no measurable change. Sonnet cost about 18 times as much, was slower, and added before the shopper answered in all 20 some-then-one cases.

  | Run | List precision / recall | Dish pass | Made-up items | Ordering slips | Median / p90 per turn | Run cost |
  |---|---|---|---|---|---|---|
  | Haiku 5.5 default | 1.000 / 0.884 | 38/40 | 1 | 0 | 2.7 s / 3.6 s | $0.232 |
  | Haiku 5.5 effort high | 1.000 / 0.888 | 38/40 | 0 | 0 | 2.7 s / 3.5 s | $0.234 |
  | Sonnet 5.5 default | 0.900 / 0.789 | 40/40 | 0 | 20 | 3.7 s / 6.2 s | $4.158 |
- **Spend cap:**
  - **$10 total** for this build phase, covering all assistant and eval calls through the app's AI client, measured from token usage;
  - at the cap the assistant switches off with a "the helper is resting" message, the storefront keeps working, and the platform admin is alerted;
  - the owner also sets a matching limit in the Anthropic console;
  - per-store budgets come later, once real costs are known.
- **Costs are kept low** with prompt caching on the system prompt and tool definitions, a cap on tool steps per turn, and rate limits per cart and per IP.

### Records and evaluation

- Conversations and tool calls go in `AiConversation` and `AiAction`, with RLS, and are deleted after **90 days** by a scheduled job.
- The golden eval (#146) is 200 English text requests, plus 6 shopper-constraint cases added by #485 (amended 2026-11-12). Checkout handoffs are scored as one case per handoff once the eval report is rebuilt (#247). Photo and PDF lists are deferred. There is no multilingual set and no live hosted job.
- Default `pnpm test` and local-ci never call Anthropic. They check a committed report against the current prompt, tools, step cap, model, dataset, catalog fixture and seeded master-product names, synonyms and categories. A mismatch names the part that changed. The rerun is `ASSISTANT_EVAL_LIVE=1 pnpm eval:shopper-assistant`.
- A live run is opt-in, Haiku only, on the local `app_runtime` database, with a $2 stop for that run and a $20 stop for the ticket including earlier attempts (raised from $4 by the owner on 2026-11-11, issue #146). An incomplete run, a partial selection, or a failed teardown leaves the previous committed report in place. A request whose connection drops before its usage arrives keeps its reserve in the ticket spend. Its case still counts as complete when a retry succeeds; a request that still fails after its retries leaves the run incomplete (owner, 2026-11-11). Gap misses are reported and do not by themselves fail the gate.
- A made-up product or line id fails a case only when it reaches the cart or a reply to the shopper. A made-up id that a tool refused, followed by a correct recovery, is counted as a rejected attempt and reported, and does not fail. Another store's id, and an id a tool accepted or silently dropped, still fail (owner, 2026-11-11).
- The official result is two full runs of Haiku 5.5 at default settings. The precision, recall and dish pass rates are averaged over the two runs, and the averages must meet the floors. Zero harmful made-up ids and no excluded item must hold in each run. The committed report holds both runs. A live run can write each failing case's requests and replies, never keys, to `ASSISTANT_EVAL_TRACE_DIR`, which is not committed (owner, 2026-11-11).

## Consequences

- New work beyond #145 and #146: the checkout handoff (#247), saved cards, address book, and photo and PDF attachments.
- PCI scope stays SAQ A: card data only ever goes into Stripe's hosted fields.
- The $10 cap will be hit quickly if the assistant is opened to real shoppers. Raise it deliberately before launch.
- Spec D12, D15 and §8.1 are updated to match this ADR.
