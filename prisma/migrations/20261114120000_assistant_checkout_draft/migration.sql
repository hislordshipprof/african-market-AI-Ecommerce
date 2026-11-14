-- The assistant's checkout draft (#247): the pickup slot the customer chose in chat,
-- read by the normal checkout page for the same cart. Store-scoped through the row's RLS.
ALTER TABLE "ai_conversations" ADD COLUMN "checkout_draft" JSONB;
