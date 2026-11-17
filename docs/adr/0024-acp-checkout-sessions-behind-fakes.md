# 24. ACP checkout sessions behind fakes

Date: 2026-11-16 · Status: accepted (#574), built behind a flag; no live agent payment

## Context

Spec §8.5 names the Agentic Commerce Protocol (ACP) for agents that take payment in the chat, as Instacart's ChatGPT app did with Stripe (December 2025). #572 gave agents a read-only catalog and #573 a checkout link the shopper pays on. #574 asked whether an in-chat payment path is worth building, and to decide before building. In ACP the merchant holds the checkout session (create, update, complete, cancel) and the agent pays with a delegated token: a Stripe Shared Payment Token (SPT), granted to the seller once, up to a maximum amount, until an expiry. The coordinator's brief for #574 took the decision: build ACP checkout sessions behind fakes, with no live agent payment. The owner's written go or no-go for a live launch is still to be recorded on #574.

## Decision

- **Endpoints.** `POST /api/acp/checkout_sessions`, `GET` and `POST /api/acp/checkout_sessions/{id}`, `POST …/{id}/complete` and `POST …/{id}/cancel` on the store host, shaped on ACP 2026-04-17 (`line_items[{id, quantity}]` with the variant id from the Catalog endpoint, `buyer`, `payment_data.instrument.credential{type: "spt", token}`; errors `{type, code, message, param}`). Separate from `/api/mcp`, whose import walk must not reach Stripe or `placeOrder` (#573).
- **Off by default, fakes only.** The routes answer 404 unless `ACP_CHECKOUT_ENABLED=1` and the checkout's Stripe fake is in use (`E2E_FAKE_STRIPE=1`, never on Vercel). So the flag cannot take a live payment. A live SPT path is not built.
- **Who may call.** One agent-platform bearer key, `ACP_API_KEY`, compared in constant time; unset means 401. The store must be active, able to take payment, and have "Let AI assistants read my catalog" on: the same owner switch as #572 and #573. 60 calls a minute per IP (`acp:ip:<ip>`).
- **Session.** A row in `acp_checkout_sessions` (RLS by store) holds a new guest cart with `source = agent`, the buyer's name, email and phone, and the order once placed. Its stored status is open, complete_in_progress, completed or canceled; ready or not ready for payment is worked out from the quote each time.
- **Prices.** Every amount comes from `quoteCheckout`. Unknown fields an agent sends (`unit_amount`, `totals`) are dropped at parse.
- **Pickup only.** The one fulfillment option is pickup at the store, ASAP. No delivery, courier or shipping, so no address confirm or courier quote.
- **Complete.** The first call claims the session (`open` → `complete_in_progress` in one conditional update). It creates the checkout's guest PaymentIntent (manual capture, `on_behalf_of` and `transfer_data.destination` the store's account) for the quote's **hold** with `payment_method_data.shared_payment_granted_token` and `confirm: true`, under an idempotency key from the session and token, then calls `placeOrder` with source agent. A concurrent call gets 409 `idempotency_in_flight`; a later one gets the same order. A failed payment or a changed basket reopens the session. A session stuck mid-complete for 2 minutes may be completed again; the idempotency key and `placeOrder`'s per-PaymentIntent replay keep that to one authorization and one order.
- **The fake.** `grantFakeSharedPaymentToken` is the fake agent; the checkout fake refuses an unknown, used, expired, other-currency or over-limit token, as Stripe documents.

## Consequences

- **The hold is above the total.** The PaymentIntent must equal the quote's hold (total plus up to 10%, at most $20) because `placeOrder` checks it. ACP agents grant a token for the total, so a real agent's token would be refused. The session says so in an `authorization_hold` message. Before a live launch the owner must choose: hold only the total for agent orders, show the hold as the total, or ask agents for a larger token.
- **Not verified against Stripe.** [ASSUMPTION] that an SPT PaymentIntent may use manual capture and a destination charge on a connected account. Stripe's SPT page shows neither; the preview API (`Stripe-Version: 2026-09-30.preview`) must be checked in test mode first.
- **Not built:** a general `Idempotency-Key` store, request signing, order webhooks to the agent, discounts, 3DS interventions, delivery, and any UI. Going live needs the owner's go on #574, the two points above, and an OpenAI merchant application.
