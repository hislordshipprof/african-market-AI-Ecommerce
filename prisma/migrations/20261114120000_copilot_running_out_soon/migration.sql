-- Store copilot: a listing estimated to sell out within 3 days (#549).
ALTER TABLE "copilot_alerts" DROP CONSTRAINT "copilot_alerts_kind_check";
ALTER TABLE "copilot_alerts" ADD CONSTRAINT "copilot_alerts_kind_check" CHECK (
    kind IN ('sold_out', 'running_low', 'running_out_soon', 'order_needs_low_stock', 'confirm_request')
    AND (kind <> 'order_needs_low_stock' OR order_id IS NOT NULL)
);
