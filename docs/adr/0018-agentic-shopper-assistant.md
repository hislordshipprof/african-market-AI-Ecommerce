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
- **Recipes are ingredient lists mapped to the store's products.** There are about 40 dishes, drafted by AI and approved by the owner in an admin review queue. The assistant does not give cooking instructions.

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

### Checkout and payment (supersedes D15 "cannot submit payment")

- The assistant may take the shopper through checkout end to end: summary, fulfillment, contact and address, payment method.
- **Money moves only on the shopper's tap.** The final step is a confirm card drawn by our server from an immutable checkout snapshot. It shows items, fulfillment, fee, tax, the hold amount and the card. The shopper taps **Place order**.
  - The tap posts a single-use `checkoutToken` bound to that snapshot straight to the server. The model is not in that path.
  - The model has no tool that places orders or charges cards.
  - A typed "yes" never places an order.
  - If anything changed since the card was drawn (price, stock, fee, slot), the token is rejected and a fresh card is drawn.
- **Cancellation window:**
  - after placing, the shopper has **10 minutes** to cancel from the chat, the confirmation page or the tracking page;
  - the window is a platform setting with an allowed range of 5–10 minutes;
  - cancelling voids the card hold (manual capture, #64) and cancels the order; nothing is captured;
  - the store gets the new-order alert when the window closes, so it never picks an order that may be cancelled;
  - v1 applies the window to orders placed through the assistant; extending it to normal checkout is a later decision.
- **Card data never touches the model.** Cards are entered in Stripe's Payment Element inside the sheet. The model only learns masked facts such as "card on file: Visa 4242". If a shopper types a card number into the chat, it is removed before the message reaches the model or the transcript.
- **Saved cards:** a Stripe Customer on the platform account. "Save this card for next time" is offered on the first order, needs the shopper's tick, and can be listed and removed from the account page. Cards work across stores through the existing destination charges.
- **Saved addresses:** an address book on the platform customer account (ADR-0002). An address is copied into an order only when used, so a store never sees addresses from other stores' orders. The address book is built in #248 and used at checkout by store delivery (#15). Pickup needs no address.
- **Guest contact details** are entered in form cards that post to our server, not typed in the conversation, so names, phones and emails stay out of model prompts and transcripts.
- v1 agentic checkout is **pickup only**, like checkout today. Delivery and courier options appear in the flow when #15, #16 and #17 land. Tax appears when #65 lands.

### Safety and grounding

- Every tool runs server-side through `storeScoped()` with Postgres RLS. The cart comes from the session (`resolveShopperCart`), never from the model.
- Prices, stock, fees and totals reach the shopper only from tool results. The allowed amounts for a reply are the newest keyed unit price (`priceCents` or `unitPriceCents`, keyed by `variantId` or else `listingId`) from tool outputs in the history sent to the model and this turn, every `*Cents` value in this turn's tool outputs, and the store's `minimumOrderCents`. Totals from earlier turns are not kept, and sums or multiples of allowed amounts are not allowed: the cart tools return `lineTotalCents`, `addedTotalCents` and `subtotalCents` instead. An amount that happens to equal a currently allowed unit price, the store minimum, or an amount returned this turn can still appear. User text, tool inputs and assistant text never add amounts. USD amounts (`$12.34`, `US$12.34`, `USD 12.34`, `12.34 USD`, `12.34 dollars`, `99¢`, `99 cents`) are checked as cents. Any other currency symbol, code, or name is removed, whether it is written before or after the number. A removed amount in a list line becomes "price not confirmed"; anywhere else the sentence becomes "I couldn't confirm that price." Newly generated replies never say "(see card)". A replay of an already stored reply is not grounded again.
- Store-written listing text is data, never instructions.
- Stock confidence below 0.6 (§8.1): the item is added as "may be unavailable" with a backup swap rule. That line never becomes "Exact item only": `set_swap_rule` refuses `exact_only` on it (owner, 2026-11-11).

### Model, library and cost

- **Library:** Vercel AI SDK (`ai` + `@ai-sdk/anthropic`), installed as published at ai-sdk.dev. Not LangChain or LangGraph: the flow is a single agent with about 10 tools, and the SDK gives streaming to React, typed tools and step limits without an orchestration layer we don't need.
- **Model:** **Claude Haiku 5.5** by default. The #146 eval separates the customer-visible CI gate from the model verdict. The gate fails on a hallucinated item, an excluded item in the cart, an ungrounded amount that the shopper still sees, a safety-rule miss, micro precision below 0.90 or micro recall below 0.85 on shopper-supplied lists, or fewer than 85% of dish-only cases passing. A dish-only case ("jollof for 6", no list) passes when the cart has the dish's core items this store sells, any brand, pack or quantity, with nothing made up, no excluded item, and a servings question when servings are unclear. Dish cases stay out of the precision and recall counts (owner, 2026-11-11). Egusi greens count only leaves, fresh, frozen or dried, not leaf powders such as baobab or moringa. "Agushi" names both whole and ground egusi, so either one passes, and so does one short question that names both with nothing added (owner, 2026-11-11). Amounts the grounder removes, and amounts the model stated before a tool had returned them, keep the verdict at `sonnet-candidate` even when the gate passes. `haiku-ok` requires the gate and a raw reply with none of those amount misses. Switching to **Claude Sonnet 5.5** is a later decision. The model id is a config setting, not code.
- **Spend cap:**
  - **$10 total** for this build phase, covering all assistant and eval calls through the app's AI client, measured from token usage;
  - at the cap the assistant switches off with a "the helper is resting" message, the storefront keeps working, and the platform admin is alerted;
  - the owner also sets a matching limit in the Anthropic console;
  - per-store budgets come later, once real costs are known.
- **Costs are kept low** with prompt caching on the system prompt and tool definitions, a cap on tool steps per turn, and rate limits per cart and per IP.

### Records and evaluation

- Conversations and tool calls go in `AiConversation` and `AiAction`, with RLS, and are deleted after **90 days** by a scheduled job.
- The golden eval (#146) is 200 English text requests. Checkout paths wait for #247. Photo and PDF lists are deferred. There is no multilingual set and no live hosted job.
- Default `pnpm test` and local-ci never call Anthropic. They check a committed report against the current prompt, tools, step cap, model, dataset, catalog fixture and seeded master-product names, synonyms and categories. A mismatch names the part that changed. The rerun is `ASSISTANT_EVAL_LIVE=1 pnpm eval:shopper-assistant`.
- A live run is opt-in, Haiku only, on the local `app_runtime` database, with a $2 stop for that run and a $20 stop for the ticket including earlier attempts (raised from $4 by the owner on 2026-11-11, issue #146). An incomplete run, a partial selection, or a failed teardown leaves the previous committed report in place. A request whose connection drops before its usage arrives keeps its reserve in the ticket spend. Its case still counts as complete when a retry succeeds; a request that still fails after its retries leaves the run incomplete (owner, 2026-11-11). Gap misses are reported and do not by themselves fail the gate.

## Consequences

- New work beyond #145 and #146: agentic checkout (confirm card, `checkoutToken`, cancellation window), saved cards, address book, and photo and PDF attachments.
- Order flow gains a "cancellable until" state and a delayed store alert for assistant orders.
- PCI scope stays SAQ A: card data only ever goes into Stripe's hosted fields.
- The $10 cap will be hit quickly if the assistant is opened to real shoppers. Raise it deliberately before launch.
- Spec D12, D15 and §8.1 are updated to match this ADR.
