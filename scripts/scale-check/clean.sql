-- Removes the #578 scale seed (every id starts with 'scale578-') and whatever the measured crons wrote for it.
\set ON_ERROR_STOP on
BEGIN;
SELECT set_config('app.is_platform_admin', 'true', true);
DELETE FROM copilot_weekly_reports WHERE store_id LIKE 'scale578-%';
DELETE FROM copilot_digests WHERE store_id LIKE 'scale578-%';
DELETE FROM substitution_requests WHERE store_id LIKE 'scale578-%';
DELETE FROM issue_reports WHERE store_id LIKE 'scale578-%';
DELETE FROM refund_requests WHERE store_id LIKE 'scale578-%';
DELETE FROM delivery_events WHERE store_id LIKE 'scale578-%';
DELETE FROM deliveries WHERE store_id LIKE 'scale578-%';
DELETE FROM stock_events WHERE store_id LIKE 'scale578-%';
DELETE FROM order_lines WHERE store_id LIKE 'scale578-%';
DELETE FROM orders WHERE store_id LIKE 'scale578-%';
DELETE FROM customers WHERE store_id LIKE 'scale578-%';
DELETE FROM copilot_alerts WHERE store_id LIKE 'scale578-%';
DELETE FROM listing_variants WHERE listing_id LIKE 'scale578-%';
DELETE FROM listings WHERE store_id LIKE 'scale578-%';
DELETE FROM master_products WHERE id LIKE 'scale578-%';
DELETE FROM audit_logs WHERE store_id LIKE 'scale578-%';
DELETE FROM notification_logs WHERE store_id LIKE 'scale578-%';
DELETE FROM store_subscriptions WHERE store_id LIKE 'scale578-%';
DELETE FROM store_memberships WHERE store_id LIKE 'scale578-%';
DELETE FROM stores WHERE id LIKE 'scale578-%';
DELETE FROM users WHERE id LIKE 'scale578-%';
COMMIT;
