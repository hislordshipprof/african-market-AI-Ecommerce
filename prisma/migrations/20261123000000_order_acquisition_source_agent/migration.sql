-- Agentic commerce (#573): an order placed from a cart an AI agent built over MCP is attributed to "agent".
ALTER TABLE "orders" DROP CONSTRAINT "orders_acquisition_source_check";
ALTER TABLE "orders" ADD CONSTRAINT "orders_acquisition_source_check" CHECK ("acquisition_source" IN ('directory', 'agent'));
