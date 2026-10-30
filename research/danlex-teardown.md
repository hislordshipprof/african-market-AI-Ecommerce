# danlexwholesalefoods.com — teardown (2026-10-30)

Sources: REA browser capture (headless Chrome, homepage network), downloaded public JS bundles for 40 chunks across store/auth/admin routes, public API responses, policy pages. Static reading of minified client code only. Server code, DB and webhooks were not visible.

## Stack (observed)
- Next.js App Router (route groups `(store)`, `(auth)`, `admin`), behind nginx, `x-powered-by: DanlexWholesaleFoods` → custom-built, not Shopify/Woo.
- Auth: NextAuth (`/api/auth/session`, `/api/auth/signin`) + custom email verification (`/api/auth/verify/send|confirm`) and admin 2FA (`/api/auth/2fa/initiate|verify`).
- DB: IDs are cuids (e.g. `cmpc23x2q…`) → very likely Prisma (inference).
- Media: `media.danlexwholesalefoods.com`, uploads via `/api/upload/presigned` (S3-compatible presigned URLs).
- Email: Resend (strings in bundles); admin has "email history" per order + `/admin/email-health`.
- Tailwind + shadcn-style UI, lucide icons, react-hot-toast-style toasts.
- Own analytics `/api/track`; AI/chat widget `/api/chat`; WhatsApp link.

## Customer flow
1. Browse: `/shop`, `/shop/[slug]` (variants/sizes, reviews, "recent buyers", paired products, perishable message), `/deals`, `/recipes`.
2. Cart: `/api/cart` (server cart for logged-in users; guests send `guestItems` at checkout). Cart page pulls `/api/shipping-rates?city=` and `/api/free-shipping-promo`.
3. Checkout `/checkout` collects name, email, phone, address, city, province (default Alberta), postal code, notes. Extras: coupon (`/api/coupons/validate`), loyalty points (`/api/user/points`, points earned at 10% of price), store credit (`/api/user/store-credit`), terms checkbox.
4. Payment, two paths:
   - **Stripe**: POST `/api/checkout` → server returns `{url}` → redirect to Stripe Checkout (hosted). Client adds a card surcharge: `fee = (0.029*total + 0.30) / 0.971` (customer pays Stripe fee).
   - **Interac e-Transfer**: POST `/api/checkout/etransfer` → order created immediately as PENDING → `/order-success?order=…&payment=etransfer&amount=…`. Customer sends e-Transfer to payments@… with order number in message; admin confirms manually. Optional auto-cancel window (`etransferCancelHours`, currently 0 = off).
   - Store credit covering 100% → `payment=store_credit`.
5. Tracking: `/track` → `GET /api/orders/track?orderNumber=&email=`. Logged-in customers see orders on `/dashboard` (`/api/orders`), plus admin→customer notes.

## Order lifecycle (statuses in code)
`PENDING → PROCESSING → SHIPPED → DELIVERED`, side exits `CANCELLED`, `REFUNDED`.
Customer-facing copy: placed/awaiting confirmation → preparing → on its way → delivered.

## Back office (`/admin`)
Orders, payments, payment-sync, products, media, hero-media, pages (CMS via `/api/page-settings`), promotions, deals, coupons, customers, customer-notes, abandoned-carts, campaigns, marketing, recipes, reviews, reports, telemetry, email-health, delivery-cities, shipping-tax, agents, settings.
Order admin actions: change status (PATCH `{status}`), resend email (`{target}`), `sync-payment` (Stripe reconciliation: `stripeSessionId`, `stripePaymentId`, `stripeChargeId`, `stripeRefundId`, `stripeReconStatus`, `stripeLastSyncedAt`), returns (full/partial, reason, resolution, admin note, refund amount, `returnedEligibleAmount`), force delete.

## Dispatch & delivery: what is NOT there
- No driver app, routes, dispatch board, carrier integration, tracking numbers or proof-of-delivery in the client code. Only `deliveredAt` timestamp.
- "Dispatch" = admin manually flips status to SHIPPED, which presumably triggers a Resend email. Policy says tracking info goes out "via email or WhatsApp", which points to manual handling.
- Shipping = flat zone rate (`baseRate`, `estimatedDays`, free threshold) + optional tax (GST 5%, currently inactive). Policy says free delivery over $250 in Calgary.
- Observation: `/api/shipping-rates?city=Calgary` and `?city=Toronto` both return zone "Cochrane and Okotoks", $15. City matching appears to fall back to one zone (possible bug).
