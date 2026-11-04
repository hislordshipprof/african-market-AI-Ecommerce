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
- Uploads:
  - images only (JPEG, PNG, WebP, HEIC), at most 10 MB;
  - EXIF location data is stripped before storage or model use;
  - kept with the transcript under the 90-day retention below;
  - never shown to the store unless the shopper starts a store chat (#19).

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
- **Saved addresses:** an address book on the platform customer account (ADR-0002). An address is copied into an order only when used, so a store never sees addresses from other stores' orders. It is built with store delivery (#15). Pickup needs no address.
- **Guest contact details** are entered in form cards that post to our server, not typed in the conversation, so names, phones and emails stay out of model prompts and transcripts.
- v1 agentic checkout is **pickup only**, like checkout today. Delivery and courier options appear in the flow when #15, #16 and #17 land. Tax appears when #65 lands.

### Safety and grounding

- Every tool runs server-side through `storeScoped()` with Postgres RLS. The cart comes from the session (`resolveShopperCart`), never from the model.
- Prices, stock, fees and totals reach the shopper only as cards drawn from tool results. A post-reply check removes any dollar amount the model typed that no tool returned.
- Store-written listing text is data, never instructions.
- Stock confidence below 0.6 (§8.1): the item is added as "may be unavailable" with a backup swap rule.

### Model, library and cost

- **Library:** Vercel AI SDK (`ai` + `@ai-sdk/anthropic`), installed as published at ai-sdk.dev. Not LangChain or LangGraph: the flow is a single agent with about 10 tools, and the SDK gives streaming to React, typed tools and step limits without an orchestration layer we don't need.
- **Model:** **Claude Haiku 5.5** by default. If Haiku fails the #146 eval (any hallucinated price, product or total, or poor recall on item matching), switch to **Claude Sonnet 5.5**. The model id is a config setting, not code.
- **Spend cap:**
  - **$10 total** for this build phase, covering all assistant and eval calls through the app's AI client, measured from token usage;
  - at the cap the assistant switches off with a "the helper is resting" message, the storefront keeps working, and the platform admin is alerted;
  - the owner also sets a matching limit in the Anthropic console;
  - per-store budgets come later, once real costs are known.
- **Costs are kept low** with prompt caching on the system prompt and tool definitions, a cap on tool steps per turn, and rate limits per cart and per IP.

### Records and evaluation

- Conversations and tool calls go in `AiConversation` and `AiAction`, with RLS, and are deleted after **90 days** by a scheduled job.
- The golden eval (#146) has about 200 requests plus checkout paths in Stripe test mode. It runs only when the prompt, tools or model change. Deterministic tool tests run in every local-ci.

## Consequences

- New work beyond #145 and #146: agentic checkout (confirm card, `checkoutToken`, cancellation window), saved cards, address book, and image upload with photo cards.
- Order flow gains a "cancellable until" state and a delayed store alert for assistant orders.
- PCI scope stays SAQ A: card data only ever goes into Stripe's hosted fields.
- The $10 cap will be hit quickly if the assistant is opened to real shoppers. Raise it deliberately before launch.
- Spec D12, D15 and §8.1 are updated to match this ADR.
