-- #578 synthetic seed for the 300-store scale check. Local lane database only, never Neon (run.sh refuses).
-- 300 stores x 2,000 listings; 10,000 orders a day for the 30 days of October 2026 (300,000 orders).
-- Every row's id starts with 'scale578-', so clean.sql removes exactly this seed.
-- All stores share one zone and the default digest hour: the worst case for the hourly crons (100 due a page).
\set ON_ERROR_STOP on
\timing on
BEGIN;
SET LOCAL synchronous_commit = off;
SELECT set_config('app.is_platform_admin', 'true', true);

INSERT INTO users (id, name, email, updated_at)
SELECT 'scale578-u' || lpad(s::text, 3, '0'), 'Scale owner ' || s, 'scale578-u' || s || '@example.com', now()
FROM generate_series(1, 300) s;

INSERT INTO stores (id, slug, name, status, timezone, digest_hour, updated_at, listed)
SELECT 'scale578-s' || lpad(s::text, 3, '0'), 'scale578-s' || lpad(s::text, 3, '0'), 'Scale Market ' || lpad(s::text, 3, '0'),
       CASE WHEN s % 50 = 0 THEN 'suspended' ELSE 'active' END, 'America/New_York', 20, now(), true
FROM generate_series(1, 300) s;

INSERT INTO store_memberships (id, store_id, user_id, role, updated_at)
SELECT 'scale578-m' || lpad(s::text, 3, '0'), 'scale578-s' || lpad(s::text, 3, '0'), 'scale578-u' || lpad(s::text, 3, '0'), 'owner', now()
FROM generate_series(1, 300) s;

-- Status mix: mostly paying, some trials, a few failing or cancelled, a few never subscribed (no row).
INSERT INTO store_subscriptions (store_id, plan, status, trial_ends_at, current_period_end, payment_failed_at)
SELECT 'scale578-s' || lpad(s::text, 3, '0'),
       CASE WHEN s % 3 = 0 THEN 'pro' ELSE 'starter' END,
       (ARRAY['active','active','active','active','active','active','active','trialing','past_due','canceled'])[1 + s % 10],
       CASE WHEN s % 10 = 7 THEN timestamp '2026-12-15' END,
       timestamp '2026-12-01',
       CASE WHEN s % 10 = 8 THEN timestamp '2026-11-10' END
FROM generate_series(1, 300) s WHERE s % 20 <> 0;

INSERT INTO master_products (id, name, updated_at)
SELECT 'scale578-p' || lpad(p::text, 4, '0'), 'Scale product ' || p, now()
FROM generate_series(1, 2000) p;

-- 600,000 listings: 70% counted (some at zero), 30% status; confidence spread over the three badges.
INSERT INTO listings (id, store_id, master_product_id, price, stock_mode, qty, status, confidence, updated_at)
SELECT 'scale578-l' || lpad(s::text, 3, '0') || '-' || lpad(p::text, 4, '0'), 'scale578-s' || lpad(s::text, 3, '0'),
       'scale578-p' || lpad(p::text, 4, '0'), 199 + (p % 40) * 25,
       CASE WHEN p % 10 < 7 THEN 'counted' ELSE 'status' END,
       CASE WHEN p % 10 < 7 THEN (p * 7 + s) % 60 END,
       CASE WHEN p % 10 >= 7 THEN (ARRAY['in_stock','in_stock','low','out_of_stock'])[1 + p % 4] END,
       (ARRAY[1.0, 0.9, 0.5, 0.2])[1 + (p + s) % 4], now()
FROM generate_series(1, 300) s, generate_series(1, 2000) p;

INSERT INTO listing_variants (id, listing_id, label, price, weight_g, updated_at)
SELECT id || '-v', id, 'Each', price, 500, now() FROM listings WHERE id LIKE 'scale578-%';

INSERT INTO customers (id, store_id, name, email, phone, updated_at)
SELECT 'scale578-c' || lpad(s::text, 3, '0') || '-' || c, 'scale578-s' || lpad(s::text, 3, '0'), 'Shopper ' || c,
       'scale578-' || s || '-' || c || '@example.com', '+1555' || lpad(s::text, 3, '0') || lpad(c::text, 4, '0'), now()
FROM generate_series(1, 300) s, generate_series(1, 400) c;

-- 300,000 orders, one every 8.64 s from 2026-10-01 UTC, round-robin over stores. A third each pickup,
-- store delivery and courier. 4% cancelled, 1% refund failed, the rest captured an hour after placing.
-- n is the order's index within its store; h mixes n and the store so every pattern below spreads over all stores.
CREATE TEMP TABLE scale_orders ON COMMIT DROP AS
SELECT g, n, h,
       'scale578-o' || g AS id,
       'scale578-s' || lpad((1 + g % 300)::text, 3, '0') AS store_id,
       1 + g % 300 AS s,
       timestamp '2026-10-01' + g * interval '8.64 seconds' AS created_at,
       (ARRAY['pickup','store-delivery','courier'])[1 + n % 3] AS fulfillment,
       CASE WHEN h % 100 < 4 THEN 'CANCELLED' WHEN h % 100 = 4 THEN 'REFUND_FAILED'
            WHEN n % 3 = 0 THEN 'COMPLETED' ELSE 'DELIVERED' END AS status,
       3000 + (h % 50) * 100 AS subtotal
FROM generate_series(0, 299999) g, LATERAL (SELECT g / 300 AS n) i, LATERAL (SELECT (g / 300) * 7919 + (g % 300) * 31 AS h) j;
ANALYZE scale_orders;

INSERT INTO orders (id, store_id, number, customer_id, status, fulfillment, subtotal_cents, buffer_cents, total_authorized_cents,
                    payment_intent_id, captured_amount_cents, service_fee_cents, delivery_fee_cents, platform_fee_cents,
                    tip_cents, total_cents, created_at, accepted_at, ready_at, completed_at, cancelled_at, updated_at, tracking_token)
SELECT o.id, o.store_id, 1000 + o.g / 300, 'scale578-c' || lpad(o.s::text, 3, '0') || '-' || (1 + (o.n * 7919) % 400),
       o.status, o.fulfillment, o.subtotal, o.subtotal / 10, o.subtotal + o.subtotal / 10 + 1200,
       'pi_scale578_' || o.g,
       CASE WHEN o.status <> 'CANCELLED' THEN o.subtotal + 150 + CASE WHEN o.fulfillment = 'courier' THEN 899 ELSE 0 END END,
       150, CASE WHEN o.fulfillment = 'courier' THEN 899 ELSE 0 END,
       CASE WHEN o.status <> 'CANCELLED' THEN 150 + CASE WHEN o.fulfillment = 'courier' THEN 899 ELSE 0 END END,
       0, o.subtotal + 150, o.created_at, o.created_at + interval '5 minutes',
       CASE WHEN o.status <> 'CANCELLED' THEN o.created_at + interval '45 minutes' END,
       CASE WHEN o.status <> 'CANCELLED' THEN o.created_at + interval '60 minutes' END,
       CASE WHEN o.status = 'CANCELLED' THEN o.created_at + interval '10 minutes' END,
       o.created_at + interval '60 minutes', 'scale578-t' || o.g
FROM scale_orders o;

-- Four lines an order (1.2M), skewed towards each store's first listings so there are best sellers and movers.
CREATE TEMP TABLE scale_lines ON COMMIT DROP AS
SELECT o.id AS order_id, o.store_id, o.s, o.h, o.created_at, o.status, k,
       'scale578-l' || lpad(o.s::text, 3, '0') || '-' || lpad((1 + floor(2000 * power(((o.h * 31 + k * 977) % 1000) / 1000.0, 3)))::int::text, 4, '0') AS listing_id,
       1 + (o.g + k) % 3 AS qty
FROM scale_orders o, generate_series(1, 4) k;

INSERT INTO order_lines (id, store_id, order_id, listing_variant_id, qty_ordered, qty_picked, unit_price_cents)
SELECT l.order_id || '-' || l.k, l.store_id, l.order_id, l.listing_id || '-v', l.qty,
       CASE WHEN l.status = 'CANCELLED' THEN 0 WHEN (l.h + l.k) % 50 = 0 THEN l.qty - 1 ELSE l.qty END, 499
FROM scale_lines l;

INSERT INTO stock_events (id, store_id, listing_id, type, delta, actor_id, created_at)
SELECT l.order_id || '-' || l.k || '-se', l.store_id, l.listing_id, 'sale', -l.qty, 'scale578-u' || lpad(l.s::text, 3, '0'), l.created_at
FROM scale_lines l WHERE l.status <> 'CANCELLED';

-- A weekly restock of each store's first 200 listings.
INSERT INTO stock_events (id, store_id, listing_id, type, delta, actor_id, created_at)
SELECT 'scale578-r' || s || '-' || p || '-' || w, 'scale578-s' || lpad(s::text, 3, '0'),
       'scale578-l' || lpad(s::text, 3, '0') || '-' || lpad(p::text, 4, '0'), 'restock', 24, 'scale578-u' || lpad(s::text, 3, '0'),
       timestamp '2026-10-01 14:00' + w * interval '7 days'
FROM generate_series(1, 300) s, generate_series(1, 200) p, generate_series(0, 4) w;

-- Courier orders: one delivery each (100,000), three events each, and incidents on a few percent:
-- 2% failover, 0.5% provider cancel, 3% assigned late, 1% delivered without proof.
INSERT INTO deliveries (id, store_id, order_id, provider, external_id, status, quote_fee_cents, proof_url, created_at, updated_at, pickup_ready_at)
SELECT o.id || '-d', o.store_id, o.id, CASE WHEN o.h % 2 = 0 THEN 'doordash' ELSE 'uber' END, 'ext_scale578_' || o.g,
       CASE WHEN o.status = 'CANCELLED' THEN 'cancelled' ELSE 'delivered' END, 899,
       CASE WHEN o.h % 100 <> 7 THEN 'https://example.com/proof/' || o.g END,
       o.created_at + interval '30 minutes', o.created_at + interval '90 minutes', o.created_at + interval '45 minutes'
FROM scale_orders o WHERE o.fulfillment = 'courier';

-- Delivery ids are the order id plus '-d' and delivery created_at is order created_at + 30 min, so events derive from scale_orders.
INSERT INTO delivery_events (id, store_id, order_id, delivery_id, type, payload, created_at)
SELECT o.id || '-d-' || e.type, o.store_id, o.id, o.id || '-d', e.type, '{}'::jsonb,
       o.created_at + interval '30 minutes' + CASE e.type
         WHEN 'courier_assigned' THEN CASE WHEN o.h % 100 IN (11, 12, 13) THEN interval '25 minutes' ELSE interval '3 minutes' END
         WHEN 'picked_up' THEN interval '20 minutes' ELSE interval '55 minutes' END
FROM scale_orders o, (VALUES ('courier_assigned'), ('picked_up'), ('delivered')) e(type)
WHERE o.fulfillment = 'courier' AND o.status <> 'CANCELLED';

INSERT INTO delivery_events (id, store_id, order_id, delivery_id, type, payload, created_at)
SELECT o.id || '-d-fo', o.store_id, o.id, o.id || '-d', 'failover_triggered',
       jsonb_build_object('fromProvider', CASE WHEN o.h % 2 = 0 THEN 'doordash' ELSE 'uber' END, 'reason', 'assignment_timeout'),
       o.created_at + interval '40 minutes'
FROM scale_orders o WHERE o.fulfillment = 'courier' AND o.h % 100 IN (21, 22);

INSERT INTO delivery_events (id, store_id, order_id, delivery_id, type, payload, created_at)
SELECT o.id || '-d-pc', o.store_id, o.id, o.id || '-d', 'cancelled', '{"reason":"courier_unavailable"}'::jsonb, o.created_at + interval '38 minutes'
FROM scale_orders o WHERE o.fulfillment = 'courier' AND o.h % 200 = 31;

-- 2% of captured orders have a succeeded refund; half of them came from an issue report.
INSERT INTO refund_requests (id, store_id, order_id, payment_intent_id, key, amount_cents, refund_application_fee, state,
                             provider_status, created_at, succeeded_at)
SELECT o.id || '-rf', o.store_id, o.id, 'pi_scale578_' || o.g, 'scale578-rf' || o.g, 500, o.fulfillment <> 'courier', 'CREATED',
       'succeeded', o.created_at + interval '1 day', o.created_at + interval '1 day'
FROM scale_orders o WHERE o.status NOT IN ('CANCELLED', 'REFUND_FAILED') AND o.h % 50 = 9;

INSERT INTO issue_reports (id, store_id, order_id, type, lines, amount_cents, state, refund_request_id, created_at)
SELECT o.id || '-ir', o.store_id, o.id, (ARRAY['missing','damaged','wrong','poor_freshness'])[1 + o.h % 4], '[]'::jsonb, 500,
       'auto_refunded', o.id || '-rf', o.created_at + interval '1 day'
FROM scale_orders o WHERE o.status NOT IN ('CANCELLED', 'REFUND_FAILED') AND o.h % 100 = 9;

-- 1% of lines asked a swap prompt: most answered, some timed out.
INSERT INTO substitution_requests (id, store_id, order_id, order_line_id, qty, status, expires_at, created_at)
SELECT l.order_id || '-' || l.k || '-sub', l.store_id, l.order_id, l.order_id || '-' || l.k, 1,
       CASE WHEN l.k = 4 THEN 'timed_out' ELSE 'approved' END, l.created_at + interval '20 minutes', l.created_at + interval '15 minutes'
FROM scale_lines l WHERE (l.h + l.k * 7) % 100 = 0;

-- Copilot alerts: a few a day per store, some open stock checks.
INSERT INTO copilot_alerts (id, store_id, kind, listing_id, state, dedupe_key, created_at, resolved_at)
SELECT 'scale578-a' || s || '-' || d || '-' || k, 'scale578-s' || lpad(s::text, 3, '0'),
       (ARRAY['sold_out','running_low','confirm_request'])[k],
       'scale578-l' || lpad(s::text, 3, '0') || '-' || lpad((1 + (d * 37 + k * 11) % 2000)::text, 4, '0'),
       CASE WHEN k = 3 AND d > 25 THEN 'open' ELSE 'resolved' END, 'scale578-' || d || '-' || k,
       timestamp '2026-10-01 12:00' + d * interval '1 day',
       CASE WHEN NOT (k = 3 AND d > 25) THEN timestamp '2026-10-01 18:00' + d * interval '1 day' END
FROM generate_series(1, 300) s, generate_series(0, 29) d, generate_series(1, 3) k;

COMMIT;

ANALYZE;
